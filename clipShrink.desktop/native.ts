/*
 * ClipShrink, a Vencord userplugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, BrowserWindow, dialog, IpcMainInvokeEvent } from "electron";
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";

import { chunkBytes, videoExtensions } from "./clip";
import { encodeImage, encodeVideo, probeImage, probeVideo } from "./encoder";

type Selection = Awaited<ReturnType<typeof probeVideo>>;
type Encoded = Awaited<ReturnType<typeof encodeVideo>>;

interface Session {
    controller: AbortController;
    onDestroyed: () => void;
    task?: Promise<unknown>;
    cleanup?: Promise<void>;
    input?: string;
    video?: Selection;
    directory?: string;
    output?: Encoded;
    toolDirectory?: string;
    phase: string;
}

const sessions = new Map<number, Session>();
let choosingFFmpeg = false;
const defaultAutomaticInputLimit = 512 * 1024 ** 2;
const defaultAutomaticDurationLimit = 10 * 60;
const defaultAutomaticEncodeLimit = 14 * 60;
const defaultAutomaticConcurrency = 1;
let activeAutomaticEncodes = 0;

const configPath = () => join(app.getPath("userData"), "clipshrink-ffmpeg-dir.txt");

export async function getFFmpegDirectory(_event: IpcMainInvokeEvent) {
    try {
        const directory = await readFile(configPath(), "utf8");
        if (!isAbsolute(directory)) throw new Error("ClipShrink's FFmpeg location is invalid. Choose it again in settings.");
        return directory;
    } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}

export async function chooseFFmpeg(event: IpcMainInvokeEvent) {
    if (choosingFFmpeg) return null;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error("Open ClipShrink settings in a desktop window.");
    const extension = process.platform === "win32" ? ".exe" : "";
    choosingFFmpeg = true;
    try {
        const { canceled, filePaths: [file] } = await dialog.showOpenDialog(window, {
            title: `Choose your trusted ffmpeg${extension} executable`,
            properties: ["openFile"],
            ...(extension && { filters: [{ name: "Executable", extensions: ["exe"] }] })
        });
        if (canceled || !file) return null;
        const directory = dirname(file);
        if (basename(file).toLowerCase() !== `ffmpeg${extension}`
            || !(await stat(file).catch(() => null))?.isFile()
            || !(await stat(join(directory, `ffprobe${extension}`)).catch(() => null))?.isFile())
            throw new Error(`Select ffmpeg${extension} from a folder that also contains ffprobe${extension}.`);
        await writeFile(configPath(), directory, { encoding: "utf8", mode: 0o600 });
        return directory;
    } finally {
        choosingFFmpeg = false;
    }
}

export async function resetFFmpeg(_event: IpcMainInvokeEvent) {
    if (choosingFFmpeg) throw new Error("Close the FFmpeg file picker first.");
    await rm(configPath(), { force: true });
}

function requireSession(event: IpcMainInvokeEvent) {
    const session = sessions.get(event.sender.id);
    if (!session || session.cleanup) throw new Error("No active ClipShrink session. Select the video again.");
    return session;
}

async function disposeSession(id: number) {
    const session = sessions.get(id);
    if (!session) return;
    session.cleanup ??= (async () => {
        session.controller.abort();
        try {
            await session.task?.catch(() => {});
            if (session.directory) await rm(session.directory, { recursive: true, force: true, maxRetries: 3 });
        } finally {
            sessions.delete(id);
        }
    })();
    await session.cleanup;
}

export async function dispose(event: IpcMainInvokeEvent) {
    const sender = event.sender;
    const id = sender.id;
    const session = sessions.get(id);
    if (!session) return;
    sender.removeListener("destroyed", session.onDestroyed);
    await disposeSession(id);
}

export async function selectVideo(event: IpcMainInvokeEvent) {
    const sender = event.sender;
    const id = sender.id;
    const window = BrowserWindow.fromWebContents(sender);
    if (!window) throw new Error("ClipShrink needs a desktop window to select a video.");
    if (sessions.has(id)) throw new Error("A ClipShrink session is already open in this window.");

    const session: Session = {
        controller: new AbortController(), phase: "Inspecting video…",
        onDestroyed: () => void disposeSession(id).catch(console.error)
    };
    sessions.set(id, session);
    sender.once("destroyed", session.onDestroyed);

    const task = (async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog(window, {
            title: "Choose a video for ClipShrink",
            properties: ["openFile"],
            filters: [{ name: "Video files", extensions: videoExtensions }]
        });
        const { signal } = session.controller;
        signal.throwIfAborted();
        if (canceled || !filePaths[0]) return null;
        const selected = filePaths[0];
        if (!videoExtensions.includes(extname(selected).slice(1).toLowerCase())) throw new Error("Choose a supported video file.");
        const input = await realpath(selected);
        session.toolDirectory = await getFFmpegDirectory(event) ?? undefined;
        const video = await probeVideo(input, signal, session.toolDirectory);
        session.input = input;
        session.video = video;
        return { name: basename(selected), size: video.size, duration: video.duration };
    })();
    session.task = task;
    try {
        return await task;
    } finally {
        if (session.task === task) session.task = undefined;
        if (!session.video) {
            if (!sender.isDestroyed()) sender.removeListener("destroyed", session.onDestroyed);
            await disposeSession(id);
        }
    }
}

export async function processVideo(event: IpcMainInvokeEvent, start: number, end: number | null, target: number) {
    const session = requireSession(event);
    const { video, input, controller: { signal } } = session;
    if (!input || !video || session.task) throw new Error("ClipShrink is not ready to process a video.");

    session.output = undefined;
    session.phase = "Preparing video…";
    const task = (async () => {
        session.directory ??= await mkdtemp(join(tmpdir(), "clipshrink-"));
        signal.throwIfAborted();
        const result = await encodeVideo(input, session.directory, video, { start, end, target }, signal, phase => { session.phase = phase; }, session.toolDirectory);
        signal.throwIfAborted();
        session.output = result;
        return { size: result.size, original: result.original };
    })();

    session.task = task;
    try {
        return await task;
    } finally {
        if (session.task === task) session.task = undefined;
    }
}

export function getPhase(event: IpcMainInvokeEvent) {
    return requireSession(event).phase;
}

export async function readChunk(event: IpcMainInvokeEvent, offset: number) {
    const session = requireSession(event);
    const { output } = session;
    if (session.task || !output || !Number.isSafeInteger(offset) || offset < 0 || offset >= output.size)
        throw new Error("No video data at that offset.");
    const task = (async () => {
        const file = await open(output.path, "r");
        try {
            const info = await file.stat();
            if (info.size !== output.size || (output.original && info.mtimeMs !== session.video?.modified))
                throw new Error("The video changed before it could be attached. Select it again.");
            const bytes = new Uint8Array(Math.min(chunkBytes, output.size - offset));
            let read = 0;
            while (read < bytes.length) {
                const { bytesRead } = await file.read(bytes, read, bytes.length - read, offset + read);
                if (!bytesRead) throw new Error("The video changed while reading it. Select it again.");
                read += bytesRead;
            }
            return bytes.buffer;
        } finally {
            await file.close();
        }
    })();
    session.task = task;
    try {
        return await task;
    } finally {
        if (session.task === task) session.task = undefined;
    }
}

function inputExtension(name: string) {
    const extension = extname(name).slice(1).toLowerCase();
    if (videoExtensions.includes(extension)) return extension;
    if (["png", "jpg", "jpeg", "jfif", "webp", "avif"].includes(extension)) return extension;
    return null;
}

function automaticOutputName(name: string, extension: string) {
    const stem = basename(name).replace(/\.[^.]+$/, "") || "file";
    return `${Array.from(stem).slice(0, 85).join("")}-clip.${extension}`;
}

export async function processFile(
    event: IpcMainInvokeEvent, name: string, data: ArrayBuffer, target: number,
    limits?: {
        maxInputBytes?: number;
        maxDurationSeconds?: number;
        maxEncodeSeconds?: number;
        maxConcurrentEncodes?: number;
    }
) {
    if (typeof name !== "string" || name.length === 0 || name.length > 255)
        throw new Error("The selected file has an invalid name.");
    const maxInputBytesSetting = limits?.maxInputBytes;
    const maxDurationSecondsSetting = limits?.maxDurationSeconds;
    const maxEncodeSecondsSetting = limits?.maxEncodeSeconds;
    const maxConcurrentEncodesSetting = limits?.maxConcurrentEncodes;
    const maxInputBytes = Number.isSafeInteger(maxInputBytesSetting) && maxInputBytesSetting !== undefined && maxInputBytesSetting > 0
        ? maxInputBytesSetting
        : defaultAutomaticInputLimit;
    const maxDurationSeconds = Number.isSafeInteger(maxDurationSecondsSetting) && maxDurationSecondsSetting !== undefined && maxDurationSecondsSetting > 0
        ? maxDurationSecondsSetting
        : defaultAutomaticDurationLimit;
    const maxEncodeSeconds = Number.isSafeInteger(maxEncodeSecondsSetting) && maxEncodeSecondsSetting !== undefined && maxEncodeSecondsSetting > 0
        ? Math.min(maxEncodeSecondsSetting, 30 * 60)
        : defaultAutomaticEncodeLimit;
    const maxConcurrentEncodes = Number.isSafeInteger(maxConcurrentEncodesSetting) && maxConcurrentEncodesSetting !== undefined && maxConcurrentEncodesSetting > 0
        ? Math.min(maxConcurrentEncodesSetting, 4)
        : defaultAutomaticConcurrency;
    if (!(data instanceof ArrayBuffer) || data.byteLength === 0 || data.byteLength > maxInputBytes)
        throw new Error("This file is too large for automatic ClipShrink processing.");
    if (!Number.isSafeInteger(target) || target <= 0) throw new Error("Invalid upload target.");
    if (data.byteLength <= target) return { kind: "unchanged" as const };

    const extension = inputExtension(name);
    if (!extension) return { kind: "unchanged" as const };
    if (activeAutomaticEncodes >= maxConcurrentEncodes)
        throw new Error("ClipShrink is already processing another automatic upload. Try again in a moment.");

    activeAutomaticEncodes++;
    let directory: string | undefined;
    const controller = new AbortController();
    try {
        directory = await mkdtemp(join(tmpdir(), "clipshrink-auto-"));
        const input = join(directory, `input.${extension}`);
        await writeFile(input, new Uint8Array(data));
        const toolDirectory = await getFFmpegDirectory(event) ?? undefined;
        const processingSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(maxEncodeSeconds * 1000)]);
        if (videoExtensions.includes(extension)) {
            const video = await probeVideo(input, processingSignal, toolDirectory);
            if (video.duration > maxDurationSeconds) throw new Error("This video is too long for automatic ClipShrink processing.");
            const result = await encodeVideo(input, directory, video, { start: 0, end: null, target }, processingSignal, () => {}, toolDirectory);
            if (result.original) return { kind: "unchanged" as const };
            const output = await readFile(result.path);
            return {
                kind: "processed" as const,
                data: output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength),
                name: automaticOutputName(name, "mp4"),
                type: "video/mp4",
                convertedToWebp: false
            };
        }

        const image = await probeImage(input, processingSignal, toolDirectory);
        const format = extension === "jpg" || extension === "jpeg" || extension === "jfif" ? "jpeg"
            : extension === "png" ? "png" : extension === "webp" ? "webp" : "avif";
        const result = await encodeImage(input, directory, image, { target, format }, processingSignal, () => {}, toolDirectory);
        if (result.original) return { kind: "unchanged" as const };
        const output = await readFile(result.path);
        const outputExtension = result.convertedToWebp ? "webp" : ["jpeg", "jfif"].includes(extension) ? "jpg" : extension;
        return {
            kind: "processed" as const,
            data: output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength),
            name: automaticOutputName(name, outputExtension),
            type: outputExtension === "jpg" ? "image/jpeg" : `image/${outputExtension}`,
            convertedToWebp: result.convertedToWebp
        };
    } finally {
        activeAutomaticEncodes--;
        if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
}
