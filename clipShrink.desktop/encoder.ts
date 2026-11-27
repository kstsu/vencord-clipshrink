/*
 * ClipShrink, a Vencord userplugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import { maxUploadBytes, resolveTrim, videoExtensions } from "./clip";

const run = promisify(execFile);
const inputOptions = ["-protocol_whitelist", "file", "-format_whitelist", "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpegts,mpeg,flv,asf,ogg"];
const maxEncodeMs = 30 * 60_000;

async function runMediaTool(tool: "ffprobe" | "ffmpeg", args: string[], signal: AbortSignal, timeout: number, directory?: string, cwd?: string) {
    if (directory && !isAbsolute(directory)) throw new Error("Choose the FFmpeg location again in ClipShrink settings.");
    const executable = directory ? join(directory, process.platform === "win32" ? `${tool}.exe` : tool) : tool;
    try {
        return (await run(executable, args, { cwd, signal, timeout, windowsHide: true, maxBuffer: 1024 ** 2 })).stdout;
    } catch (error) {
        signal.throwIfAborted();
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
            throw new Error(`ClipShrink couldn't find ${tool}. Install FFmpeg (including ffprobe), then choose its executable in ClipShrink settings or restart Discord after updating PATH.`);
        if (typeof error === "object" && error !== null && "killed" in error && error.killed)
            throw new Error(`${tool} timed out. Try a shorter trim range.`);
        throw new Error(tool === "ffprobe"
            ? "ClipShrink couldn't read this video. Choose a supported local video file."
            : "FFmpeg couldn't encode this video. Use a current build with the libx264 and AAC encoders.");
    }
}

interface ProbeStream {
    codec_type?: string;
    codec_name?: string;
    duration?: string;
    width?: number;
    height?: number;
    pix_fmt?: string;
    disposition?: { attached_pic?: number; };
}

export async function probeVideo(input: string, signal: AbortSignal, toolDirectory?: string) {
    const info = await stat(input);
    if (!info.isFile() || !info.size) throw new Error("Choose a non-empty local video file.");

    const text = await runMediaTool("ffprobe", [
        "-v", "error", ...inputOptions, "-show_entries",
        "stream=codec_type,codec_name,duration:stream_disposition=attached_pic:format=format_name,duration:format_tags=major_brand",
        "-of", "json", "-i", input
    ], signal, 30_000, toolDirectory);
    const { streams, format } = JSON.parse(text) as {
        streams?: ProbeStream[];
        format?: { duration?: string; format_name?: string; tags?: { major_brand?: string; }; };
    };
    const video = streams?.find(stream => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1);
    const audio = streams?.find(stream => stream.codec_type === "audio");
    const videoDuration = Number(video?.duration);
    const duration = videoDuration > 0 ? videoDuration : Number(format?.duration);
    if (!video || video.codec_name === "gif" || format?.format_name?.split(",")[0] === "gif" || !Number.isFinite(duration) || duration <= 0)
        throw new Error("This file has no readable video with a known duration.");

    const canKeepOriginal = /\.mp4$/i.test(input) && !!format?.tags?.major_brand && video.codec_name === "h264"
        && (!audio || audio.codec_name === "aac");
    return { duration, size: info.size, modified: info.mtimeMs, hasAudio: !!audio, canKeepOriginal };
}

export async function probeImage(input: string, signal: AbortSignal, toolDirectory?: string) {
    const info = await stat(input);
    if (!info.isFile() || !info.size) throw new Error("Choose a non-empty local image file.");

    const text = await runMediaTool("ffprobe", [
        "-v", "error", "-show_entries",
        "stream=codec_type,codec_name,width,height,pix_fmt:format=format_name",
        "-of", "json", "-i", input
    ], signal, 30_000, toolDirectory);
    const { streams, format } = JSON.parse(text) as {
        streams?: ProbeStream[];
        format?: { format_name?: string; };
    };
    const image = streams?.find(stream => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1);
    const formatName = format?.format_name?.split(",")[0]?.toLowerCase() ?? "";
    if (!image || formatName.includes("gif") || image.codec_name === "gif")
        throw new Error("GIFs are not supported. Choose a PNG, JPEG, WebP, or AVIF image.");
    if (!(formatName.startsWith("png") || formatName.startsWith("jpeg") || formatName.startsWith("webp") || formatName.startsWith("avif")))
        throw new Error("Choose a PNG, JPEG, WebP, or AVIF image.");

    const width = Number(image.width);
    const height = Number(image.height);
    if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0)
        throw new Error("This image has no readable dimensions.");

    const pixFmt = image.pix_fmt?.toLowerCase() ?? "";
    const hasAlpha = /(?:a|rgba|bgra|argb|abgr|yuva|gbrap)/.test(pixFmt);
    return {
        size: info.size,
        modified: info.mtimeMs,
        width,
        height,
        hasAlpha,
        formatName
    };
}

type ImageFormat = "png" | "jpeg" | "webp" | "avif";

export async function encodeImage(
    input: string, directory: string, image: Awaited<ReturnType<typeof probeImage>>,
    request: { target: number; format: ImageFormat; }, signal: AbortSignal,
    report: (phase: string) => void, toolDirectory?: string
) {
    const { target, format } = request;
    if (!Number.isSafeInteger(target) || target <= 0 || target > maxUploadBytes) throw new Error("Invalid upload target.");
    const source = await stat(input);
    if (source.size !== image.size || source.mtimeMs !== image.modified)
        throw new Error("The image changed after selection. Try attaching it again.");
    if (source.size <= target) return { path: input, size: source.size, original: true, convertedToWebp: false };

    const sourceFormat = format === "jpeg" ? "jpeg" : format;
    const plans: Array<{ format: "png" | "jpeg" | "webp"; scale: number; quality?: number; convertedToWebp: boolean; }> = [];
    const dimensions = [1, 0.85, 0.7, 0.55, 0.4, 0.3, 0.2];
    const qualities = [90, 75, 60, 45];
    const jpegQualities = [3, 8, 15, 25];
    if (sourceFormat === "png") {
        for (const scale of dimensions) plans.push({ format: "png", scale, convertedToWebp: false });
        for (const scale of dimensions) for (const quality of qualities)
            plans.push({ format: "webp", scale, quality, convertedToWebp: true });
    } else if (sourceFormat === "webp") {
        for (const scale of dimensions) for (const quality of qualities)
            plans.push({ format: "webp", scale, quality, convertedToWebp: false });
    } else if (sourceFormat === "jpeg") {
        for (const scale of dimensions) for (const quality of jpegQualities)
            plans.push({ format: "jpeg", scale, quality, convertedToWebp: false });
        for (const scale of dimensions) for (const quality of qualities)
            plans.push({ format: "webp", scale, quality, convertedToWebp: true });
    } else {
        for (const scale of dimensions) for (const quality of qualities)
            plans.push({ format: "webp", scale, quality, convertedToWebp: true });
    }

    const output = join(directory, "clip-image");
    for (let attempt = 0; attempt < plans.length; attempt++) {
        const plan = plans[attempt];
        if (!plan) break;
        const extension = plan.format === "jpeg" ? "jpg" : plan.format;
        const outputPath = `${output}.${extension}`;
        await rm(outputPath, { force: true });
        const maxDimension = Math.max(2, Math.floor(Math.max(image.width, image.height) * plan.scale));
        const filter = `scale=w='min(iw,${maxDimension})':h='min(ih,${maxDimension})':force_original_aspect_ratio=decrease:force_divisible_by=2`;
        const args = [
            "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-autorotate",
            "-i", input, "-frames:v", "1", "-vf", filter, "-an", "-sn", "-dn", "-map_metadata", "-1"
        ];
        if (plan.format === "png") {
            args.push("-c:v", "png", "-compression_level", "9");
        } else if (plan.format === "jpeg") {
            args.push("-c:v", "mjpeg", "-q:v", `${plan.quality ?? 75}`);
        } else {
            args.push("-c:v", "libwebp", "-lossless", "0", "-q:v", `${plan.quality ?? 75}`);
            if (image.hasAlpha) args.push("-pix_fmt", "yuva420p");
        }
        args.push(outputPath);

        report(`Sizing image (attempt ${attempt + 1} of ${plans.length})…`);
        await runMediaTool("ffmpeg", args, signal, maxEncodeMs, toolDirectory, directory);
        const result = await stat(outputPath);
        if (result.size <= target)
            return { path: outputPath, size: result.size, original: false, convertedToWebp: plan.convertedToWebp };
    }

    throw new Error("ClipShrink couldn't fit this image under the size cap. Try a lower-resolution source image.");
}

export async function encodeVideo(
    input: string, directory: string, video: Awaited<ReturnType<typeof probeVideo>>,
    request: { start: number; end: number | null; target: number; }, signal: AbortSignal,
    report: (phase: string) => void, toolDirectory?: string
) {
    const { start, end, target } = request;
    if (!Number.isSafeInteger(target) || target <= 0 || target > maxUploadBytes) throw new Error("Invalid upload target.");
    if (end !== null && !Number.isFinite(end)) throw new Error("Invalid end time.");
    const trim = resolveTrim(start, end, video.duration);
    const source = await stat(input);
    if (source.size !== video.size || source.mtimeMs !== video.modified)
        throw new Error("The video changed after selection. Close ClipShrink and select it again.");
    if (!trim.isTrimmed && video.canKeepOriginal && source.size <= target) return { path: input, size: source.size, original: true };

    const output = join(directory, "clip.mp4");
    const encodeSignal = AbortSignal.any([signal, AbortSignal.timeout(maxEncodeMs)]);
    const totalKbps = target * 8 * 0.95 / trim.duration / 1000;
    if (totalKbps < (video.hasAudio ? 90 : 55))
        throw new Error("This clip is too long for the target size. Pick a shorter range or raise the optional size cap.");

    const audioKbps = Math.min(160, Math.max(32, Math.floor(totalKbps * 0.18)));
    const audioArgs = video.hasAudio ? ["-map", "0:a:0", "-c:a", "aac", "-b:a", `${audioKbps}k`, "-ac", "2"] : ["-an"];
    const muxArgs = ["-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart", output];
    const inputArgs = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...inputOptions,
        "-ss", `${start}`, "-i", input, "-t", `${trim.duration}`, "-map", "0:V:0", "-sn", "-dn", "-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p"];

    const encode = (args: string[]) => runMediaTool("ffmpeg", args, encodeSignal, maxEncodeMs, toolDirectory, directory);
    let videoKbps = Math.floor(Math.min(20_000, totalKbps - (video.hasAudio ? audioKbps : 0)));
    for (let attempt = 1; attempt <= 3; attempt++) {
        const height = videoKbps < 230 ? 360 : videoKbps < 600 ? 480 : videoKbps < 1400 ? 720 : 1080;
        const videoArgs = [...inputArgs, "-vf", `scale=w='min(iw,${Math.ceil(height * 16 / 9)})':h='min(ih,${height})':force_original_aspect_ratio=decrease:force_divisible_by=2`];
        if (attempt === 1 && (videoKbps >= 5000 || source.size * trim.duration / video.duration < target * 0.65)) {
            report("Encoding video…");
            await encode([...videoArgs, "-crf", "21", ...audioArgs, ...muxArgs]);
        } else {
            const rateArgs = ["-b:v", `${videoKbps}k`, "-passlogfile", "clipshrink-pass"];
            report(`Sizing video (attempt ${attempt} of 3, pass 1 of 2)…`);
            await encode([...videoArgs, ...rateArgs, "-pass", "1", "-an", "-f", "null", "-"]);
            report(`Encoding video (attempt ${attempt} of 3, pass 2 of 2)…`);
            await encode([...videoArgs, ...rateArgs, "-pass", "2", ...audioArgs, ...muxArgs]);
        }
        const { size } = await stat(output);
        if (size <= target) {
            const result = await probeVideo(output, encodeSignal, toolDirectory);
            if (Math.abs(result.duration - trim.duration) > Math.max(0.15, trim.duration * 0.01))
                throw new Error("The encoded clip did not match the requested duration. Try a slightly different range.");
            return { path: output, size, original: false };
        }
        videoKbps = Math.floor(videoKbps * Math.min(0.85, 0.92 * target / size));
        if (videoKbps < 50) break;
    }
    throw new Error("ClipShrink couldn't fit this video under the size cap. Try a shorter trim range.");
}
