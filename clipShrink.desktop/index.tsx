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
import { ChannelStore, closeModal, DraftType, GuildStore, Modal, openModal, OverridePremiumTypeStore, PermissionsBits, PermissionStore, React, SelectedChannelStore, showToast, UploadAttachmentStore, UploadHandler, useEffect, useRef, UserStore, useState } from "@webpack/common";

import { chunkBytes, estimateUploadLimit, MiB, parseRange, targetSize } from "./clip";

const Native = VencordNative.pluginHelpers.ClipShrink as PluginNative<typeof import("./native")> | undefined;
const accountLimits = findByPropsLazy("getUserMaxFileSize") as { getUserMaxFileSize(user: User): number; };
const settings = definePluginSettings({
    maxSizeMiB: {
        type: OptionType.NUMBER,
        description: "Optional lower size cap in MiB. Use 0 to target Discord's estimated upload limit.",
        default: 0
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
    stop() {
        const flow = activeFlow;
        if (!flow) return;
        void endFlow(flow);
        if (flow.modalKey) closeModal(flow.modalKey);
    }
});
