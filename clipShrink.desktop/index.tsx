/*
 * ClipShrink, a Vencord userplugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ChatBarButton } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { IconComponent, OptionType, PluginNative } from "@utils/types";
import { Channel, RenderModalProps, User } from "@vencord/discord-types";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, closeModal, DraftType, FluxDispatcher, GuildStore, Modal, openModal, OverridePremiumTypeStore, PermissionsBits, PermissionStore, React, SelectedChannelStore, showToast, UploadAttachmentStore, UploadHandler, useEffect, useRef, UserStore, useState } from "@webpack/common";

import { chunkBytes, estimateUploadLimit, isImageName, isVideoName, MiB, parseRange, targetSize, videoExtensions } from "./clip";

const Native = VencordNative.pluginHelpers.ClipShrink as PluginNative<typeof import("./native")> | undefined;
const accountLimits = findByPropsLazy("getUserMaxFileSize") as { getUserMaxFileSize(user: User): number; };
const settings = definePluginSettings({
    maxSizeMiB: {
        type: OptionType.NUMBER,
        description: "Optional lower size cap in MiB. Use 0 to target Discord's estimated upload limit.",
        default: 0
    },
    automaticCompression: {
        type: OptionType.BOOLEAN,
        description: "Compress videos and still images before they are added to Discord uploads.",
        default: true
    },
    automaticOnlyOverLimit: {
        type: OptionType.BOOLEAN,
        description: "Only process automatic uploads that exceed the estimated Discord limit.",
        default: true
    },
    automaticMaxInputMiB: {
        type: OptionType.NUMBER,
        description: "Maximum input size for automatic processing in MiB.",
        default: 512
    },
    automaticMaxDurationMinutes: {
        type: OptionType.NUMBER,
        description: "Maximum video duration for automatic processing in minutes.",
        default: 10
    },
    automaticMaxEncodeMinutes: {
        type: OptionType.NUMBER,
        description: "Maximum time allowed for one automatic encode in minutes.",
        default: 14
    },
    automaticMaxConcurrentEncodes: {
        type: OptionType.NUMBER,
        description: "Maximum number of automatic encodes at once.",
        default: 1,
        min: 1,
        max: 4
    },
    ffmpegLocation: {
        type: OptionType.COMPONENT,
        description: "Local FFmpeg location",
        component: FFmpegLocation
    }
});

type Selection = NonNullable<Awaited<ReturnType<NonNullable<typeof Native>["selectVideo"]>>>;
interface Flow {
    closed: boolean;
    modalKey?: string;
}

let activeFlow: Flow | undefined;

async function endFlow(flow: Flow) {
    if (flow.closed) return;
    flow.closed = true;
    try {
        await Native?.dispose();
    } catch (error) {
        console.error("ClipShrink couldn't clean up its temporary files", error);
    } finally {
        if (activeFlow === flow) activeFlow = undefined;
    }
}

const formatSize = (bytes: number) => bytes < MiB ? `${Math.ceil(bytes / 1024)} KiB` : `${(bytes / MiB).toFixed(1)} MiB`;
const errorMessage = (error: unknown) => error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, "")
    : "ClipShrink couldn't prepare the video. Try selecting it again.";

type UploadAddFilesEvent = {
    type?: unknown;
    channelId?: unknown;
    channel?: unknown;
    files?: unknown;
    uploads?: unknown;
    items?: unknown;
    draftType?: unknown;
    maxFileSize?: unknown;
    fileSizeLimit?: unknown;
    maxFileBytes?: unknown;
    fileSizeBytes?: unknown;
    limits?: { fileSize?: unknown; maxFileSize?: unknown; };
};

let uploadInterceptor: ((event: unknown) => void) | undefined;
const automaticFiles = new WeakSet<File>();

function extractFiles(value: unknown): File[] {
    if (value instanceof File) return [value];
    if (!Array.isArray(value)) return [];
    return value.flatMap(entry => {
        if (entry instanceof File) return [entry];
        if (!entry || typeof entry !== "object") return [];
        const file = "file" in entry ? entry.file : undefined;
        if (file instanceof File) return [file];
        const item = "item" in entry && entry.item && typeof entry.item === "object" ? entry.item : undefined;
        return item && "file" in item && item.file instanceof File ? [item.file] : [];
    });
}

function numeric(value: unknown) {
    const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    return Number.isFinite(number) && number > 0 ? number : undefined;
}

function eventLimit(payload: UploadAddFilesEvent) {
    return [
        payload.maxFileSize, payload.fileSizeLimit, payload.maxFileBytes, payload.fileSizeBytes,
        payload.limits?.fileSize, payload.limits?.maxFileSize
    ].map(numeric).find(value => value !== undefined);
}

function payloadChannel(payload: UploadAddFilesEvent) {
    if (typeof payload.channelId === "string") return ChannelStore.getChannel(payload.channelId);
    if (payload.channel && typeof payload.channel === "object" && "id" in payload.channel && typeof payload.channel.id === "string")
        return ChannelStore.getChannel(payload.channel.id);
    return undefined;
}

function fileLimit(payload: UploadAddFilesEvent) {
    const direct = eventLimit(payload);
    if (direct) return direct;
    const channel = payloadChannel(payload);
    const user = UserStore.getCurrentUser();
    return channel && user ? uploadLimit(channel, user) : estimateUploadLimit(user?.premiumType);
}

function automaticTarget(payload: UploadAddFilesEvent) {
    const limit = fileLimit(payload);
    try {
        return targetSize(limit, settings.store.maxSizeMiB);
    } catch {
        return Math.floor(limit * 0.98);
    }
}

function replaceUploadPayload(payload: UploadAddFilesEvent, files: File[]) {
    payload.files = files;
    payload.uploads = [];
    payload.items = [];
}

function processAutomaticUploads(payload: UploadAddFilesEvent, files: File[]) {
    if (!Native || !settings.store.automaticCompression || payload.draftType !== DraftType.ChannelMessage) return;
    const target = automaticTarget(payload);
    const uniqueFiles = Array.from(new Set(files));
    const candidates = uniqueFiles.filter(file =>
        !automaticFiles.has(file) && (isImageName(file.name) || isVideoName(file.name, videoExtensions))
    );
    if (!candidates.length) return;
    if (settings.store.automaticOnlyOverLimit && candidates.every(file => file.size <= target)) return;

    const channel = payloadChannel(payload);
    if (!channel) return;
    replaceUploadPayload(payload, []);
    void (async () => {
        const processed: File[] = uniqueFiles.filter(file => !candidates.includes(file));
        for (const file of candidates) {
            try {
                if (file.size <= target) {
                    automaticFiles.add(file);
                    processed.push(file);
                    continue;
                }
                const result = await Native.processFile(
                    file.name,
                    await file.arrayBuffer(),
                    target,
                    {
                        maxInputBytes: Math.floor(Math.max(1, settings.store.automaticMaxInputMiB) * MiB),
                        maxDurationSeconds: Math.floor(Math.max(1, settings.store.automaticMaxDurationMinutes) * 60),
                        maxEncodeSeconds: Math.floor(Math.max(1, settings.store.automaticMaxEncodeMinutes) * 60),
                        maxConcurrentEncodes: Math.floor(Math.max(1, settings.store.automaticMaxConcurrentEncodes))
                    }
                );
                if (result.kind === "processed") {
                    const replacement = new File([result.data], result.name, { type: result.type });
                    automaticFiles.add(replacement);
                    processed.push(replacement);
                    if (result.convertedToWebp) showToast({ text: `${file.name} was converted to WebP to preserve transparency.` });
                } else {
                    automaticFiles.add(file);
                    processed.push(file);
                }
            } catch (error) {
                showToast({ text: `${file.name} was not added: ${errorMessage(error)}`, variant: "critical" });
            }
        }
        try {
            if (processed.length) UploadHandler.promptToUpload(processed, channel, DraftType.ChannelMessage);
        } catch (error) {
            showToast({ text: `ClipShrink couldn't restore the upload draft: ${errorMessage(error)}`, variant: "critical" });
        }
    })();
}

function handlePaste(event: ClipboardEvent) {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length || !settings.store.automaticCompression || !Native) return;
    const channel = ChannelStore.getChannel(SelectedChannelStore.getChannelId());
    if (!channel) return;
    const payload: UploadAddFilesEvent = { channelId: channel.id, draftType: DraftType.ChannelMessage };
    const limit = automaticTarget(payload);
    const supported = files.filter(file => isImageName(file.name) || isVideoName(file.name, videoExtensions));
    if (!supported.length || (settings.store.automaticOnlyOverLimit && supported.every(file => file.size <= limit))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    processAutomaticUploads(payload, files);
}

function FFmpegLocation() {
    const [directory, setDirectory] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(true);

    useEffect(() => {
        let mounted = true;
        void Native?.getFFmpegDirectory().then(value => {
            if (mounted) setDirectory(value);
        }).catch(error => {
            if (mounted) setError(errorMessage(error));
        }).finally(() => {
            if (mounted) setBusy(false);
        });
        return () => { mounted = false; };
    }, []);

    async function update(reset: boolean) {
        if (!Native || busy) return;
        setBusy(true);
        setError("");
        try {
            if (reset) {
                await Native.resetFFmpeg();
                setDirectory(null);
            } else {
                const selected = await Native.chooseFFmpeg();
                if (selected) setDirectory(selected);
            }
        } catch (error) {
            setError(errorMessage(error));
        } finally {
            setBusy(false);
        }
    }

    return <div className="vc-clipshrink-form">
        <p>{Native ? (busy ? "Checking FFmpeg location…" : directory ?? "Using FFmpeg from your system PATH.") : "ClipShrink needs a desktop build with its native helper."}</p>
        <div className="vc-clipshrink-actions">
            <Button disabled={busy || !Native} onClick={() => void update(false)}>Choose FFmpeg executable</Button>
            <Button disabled={busy || !directory} variant="secondary" onClick={() => void update(true)}>Use system PATH</Button>
        </div>
        {error && <p role="alert" className="vc-clipshrink-error">{error}</p>}
    </div>;
}

function canAttach(channel: Channel) {
    if (channel.isPrivate()) return true;
    const sendPermission = channel.isThread() ? PermissionsBits.SEND_MESSAGES_IN_THREADS : PermissionsBits.SEND_MESSAGES;
    return PermissionStore.can(sendPermission, channel) && PermissionStore.can(PermissionsBits.ATTACH_FILES, channel);
}

function uploadLimit(channel: Channel, user: User) {
    let clientLimit: number | undefined;
    try {
        clientLimit = accountLimits.getUserMaxFileSize(user);
    } catch {
        // Use the tier table when Discord's internal helper is unavailable.
    }
    const guild = channel.guild_id ? GuildStore.getGuild(channel.guild_id) : undefined;
    const hasBoostPerk = (feature: "MAX_FILE_SIZE_50_MB" | "MAX_FILE_SIZE_100_MB") => guild?.features?.has(feature)
        || guild?.premiumFeatures?.features?.includes(feature);
    const tier = hasBoostPerk("MAX_FILE_SIZE_100_MB") ? 3 : Math.max(guild?.premiumTier ?? 0, hasBoostPerk("MAX_FILE_SIZE_50_MB") ? 2 : 0);
    return estimateUploadLimit(OverridePremiumTypeStore?.getPremiumTypeActual?.() ?? user.premiumType, tier, clientLimit);
}

function requireChannel(channelId: string, userId: string) {
    const channel = ChannelStore.getChannel(channelId);
    if (UserStore.getCurrentUser()?.id !== userId || SelectedChannelStore.getChannelId() !== channelId)
        throw new Error("Return to the original chat and account before attaching the clip.");
    if (!channel || !canAttach(channel)) throw new Error("You can't add attachments to this chat.");
    if ((UploadAttachmentStore.getUploads(channelId, DraftType.ChannelMessage)?.length ?? 0) >= 10)
        throw new Error("This draft already has 10 attachments. Remove one and try again.");
    return channel;
}

function outputName(name: string) {
    const stem = name.replace(/\.[^.]+$/, "") || "video";
    return `${Array.from(stem).slice(0, 85).join("")}-clip.mp4`;
}

const ClipIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg width={width} height={height} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
        <path d="M8 8l12 12M8 16L20 4" />
    </svg>
);

const TrimModal = ErrorBoundary.wrap(function TrimModal({ modal, flow, video, channelId, user }: {
    modal: RenderModalProps;
    flow: Flow;
    video: Selection;
    channelId: string;
    user: User;
}) {
    const [range, setRange] = useState("");
    const [phase, setPhase] = useState("");
    const [error, setError] = useState("");
    const [invalidRange, setInvalidRange] = useState(false);
    const running = useRef(false);
    const input = useRef<HTMLInputElement>(null);
    const helpId = React.useId();
    const errorId = React.useId();
    const channel = ChannelStore.getChannel(channelId);
    const limit = channel ? uploadLimit(channel, user) : estimateUploadLimit(user.premiumType);
    let target: number | undefined;
    let settingsError = "";
    try {
        target = targetSize(limit, settings.store.maxSizeMiB);
    } catch (error) {
        settingsError = errorMessage(error);
    }

    let duration: number | undefined;
    try {
        duration = parseRange(range, video.duration).duration;
    } catch {
        // While typing, an incomplete range is normal. Validate on submit.
    }

    useEffect(() => {
        input.current?.focus();
    }, []);

    async function attach() {
        if (running.current || flow.closed || !Native || target == null) return;
        setError("");
        let trim: ReturnType<typeof parseRange>;
        try {
            trim = parseRange(range, video.duration);
        } catch (error) {
            setInvalidRange(true);
            setError(errorMessage(error));
            input.current?.focus();
            return;
        }

        running.current = true;
        setPhase("Preparing video…");
        let encoding = true;
        const poll = window.setInterval(() => {
            void Native.getPhase().then(value => {
                if (!flow.closed && encoding) setPhase(value);
            }).catch(() => {});
        }, 500);

        try {
            requireChannel(channelId, user.id);
            const result = await Native.processVideo(trim.start, trim.end, target);
            encoding = false;
            if (flow.closed) return;
            setPhase("Preparing the Discord attachment…");
            const chunks: ArrayBuffer[] = [];
            for (let offset = 0; offset < result.size; offset += chunkBytes) {
                const chunk = await Native.readChunk(offset);
                if (flow.closed) return;
                chunks.push(chunk);
            }

            const channel = requireChannel(channelId, user.id);
            if (result.size > targetSize(uploadLimit(channel, UserStore.getCurrentUser()), settings.store.maxSizeMiB))
                throw new Error("The upload target changed. Try attaching the clip again.");
            const file = new File(chunks, result.original ? video.name : outputName(video.name), { type: "video/mp4" });
            UploadHandler.promptToUpload([file], channel, DraftType.ChannelMessage);
            modal.onClose();
        } catch (error) {
            if (!flow.closed) setError(errorMessage(error));
        } finally {
            window.clearInterval(poll);
            running.current = false;
            if (!flow.closed) setPhase("");
        }
    }

    function cancel() {
        void endFlow(flow);
        modal.onClose();
    }

    return (
        <Modal {...modal} title="ClipShrink" onClose={cancel} actions={[
            { text: "Cancel", variant: "secondary", onClick: cancel },
            { text: "Prepare attachment", variant: "primary", onClick: attach, disabled: !!phase || target == null }
        ]}>
            <form className="vc-clipshrink-form" onSubmit={event => { event.preventDefault(); void attach(); }}>
                <div className="vc-clipshrink-details">
                    <strong>{video.name}</strong>
                    <p>{formatSize(video.size)} · {Number(video.duration.toFixed(3))} seconds</p>
                    <p>Estimated Discord limit: {formatSize(limit)}{target != null && ` · Target: ${formatSize(target)}`}</p>
                </div>
                <label className="vc-clipshrink-field">
                    <span>Trim range (optional)</span>
                    <input ref={input} value={range} onChange={event => {
                        setRange(event.target.value);
                        setInvalidRange(false);
                        setError("");
                    }} placeholder="00:15:13 - 00:15:15" maxLength={60} spellCheck={false} disabled={!!phase}
                    aria-invalid={invalidRange} aria-describedby={invalidRange ? `${helpId} ${errorId}` : helpId} />
                </label>
                <p id={helpId}>Use HH:MM:SS, MM:SS, or seconds. Leave blank to keep the whole video.</p>
                {duration != null && range.trim() && <p>Clip length: {Number(duration.toFixed(3))} seconds</p>}
                {phase && <p role="status">{phase}</p>}
                {(error || settingsError) && <p role="alert" id={errorId} className="vc-clipshrink-error">{error || settingsError}</p>}
                <button type="submit" hidden disabled={!!phase || target == null} />
            </form>
        </Modal>
    );
});

async function openClipShrink(channel: Channel) {
    if (activeFlow || !Native) return;
    const user = UserStore.getCurrentUser();
    if (!user) return;
    const flow: Flow = { closed: false };
    activeFlow = flow;
    try {
        const video = await Native.selectVideo();
        if (!video || flow.closed) return;
        requireChannel(channel.id, user.id);
        flow.modalKey = openModal(modal => <TrimModal modal={modal} flow={flow} video={video} channelId={channel.id} user={user} />, {
            onCloseCallback: () => void endFlow(flow)
        });
    } catch (error) {
        if (!flow.closed) showToast({ text: errorMessage(error), variant: "critical" });
    } finally {
        if (!flow.modalKey) await endFlow(flow);
    }
}

export default definePlugin({
    name: "ClipShrink",
    description: "Trim videos and fit them to Discord's upload limit with local FFmpeg processing.",
    authors: [{ name: "ClipShrink contributors", id: 0n }],
    settings,
    chatBarButton: {
        icon: ClipIcon,
        render({ channel, isMainChat, type }) {
            if (!Native || !isMainChat || !type.attachments || !canAttach(channel)) return null;
            return <ChatBarButton tooltip="ClipShrink: trim or compress a video" onClick={() => void openClipShrink(channel)}><ClipIcon /></ChatBarButton>;
        }
    },
    start() {
        if (!Native) return;
        uploadInterceptor = event => {
            if (!event || typeof event !== "object") return;
            const payload = event as UploadAddFilesEvent;
            if (payload.type !== "UPLOAD_ATTACHMENT_ADD_FILES") return;
            const files = [extractFiles(payload.files), extractFiles(payload.uploads), extractFiles(payload.items)].flat();
            if (files.length) processAutomaticUploads(payload, files);
        };
        FluxDispatcher.addInterceptor(uploadInterceptor);
        document.addEventListener("paste", handlePaste, true);
    },
    stop() {
        if (uploadInterceptor) {
            const interceptors = FluxDispatcher._interceptors;
            const index = interceptors.indexOf(uploadInterceptor);
            if (index !== -1) interceptors.splice(index, 1);
            uploadInterceptor = undefined;
        }
        document.removeEventListener("paste", handlePaste, true);
        const flow = activeFlow;
        if (!flow) return;
        void endFlow(flow);
        if (flow.modalKey) closeModal(flow.modalKey);
    }
});
