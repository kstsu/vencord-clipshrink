import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { MiB } from "../clipShrink.desktop/clip.ts";
import { encodeImage, encodeVideo, probeImage, probeVideo } from "../clipShrink.desktop/encoder.ts";

const run = promisify(execFile);
const toolDirectory = process.env.CLIPSHRINK_TEST_FFMPEG_DIR;
const ffmpeg = toolDirectory ? join(toolDirectory, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg") : "ffmpeg";

test("probes, keeps an in-limit original, compresses oversized video, and trims a clip", { timeout: 120_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "clipshrink-test-"));
    const source = join(directory, "sample with spaces.mp4");
    const signal = AbortSignal.timeout(110_000);
    try {
        await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=960x540:r=30:d=6",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-c:a", "aac", source], { signal });
        const video = await probeVideo(source, signal, toolDirectory);
        assert.equal(video.duration, 6);
        assert.equal(video.hasAudio, true);
        assert.equal(video.canKeepOriginal, true);
        assert.ok(video.size > MiB);

        const encode = (start, end, target, phases = []) => encodeVideo(source, directory, video, { start, end, target }, signal, phase => phases.push(phase), toolDirectory);
        assert.deepEqual(await encode(0, null, video.size), { path: source, size: video.size, original: true });

        const phases = [];
        const compressed = await encode(0, null, MiB, phases);
        assert.ok(compressed.size > 0 && compressed.size <= MiB);
        assert.equal(compressed.original, false);
        assert.ok(phases.some(phase => phase.includes("pass 2")));
        assert.equal((await probeVideo(compressed.path, signal, toolDirectory)).duration, 6);

        const trimmed = await encode(1.25, 3.25, MiB);
        const result = await probeVideo(trimmed.path, signal, toolDirectory);
        assert.ok(trimmed.size <= MiB && !trimmed.original);
        assert.ok(Math.abs(result.duration - 2) < 0.1);
        assert.equal(result.hasAudio, true);

        const imageSource = join(directory, "sample.png");
        await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=1200x800:d=1",
            "-vf", "format=rgba", "-frames:v", "1", "-c:v", "png", imageSource], { signal });
        const image = await probeImage(imageSource, signal, toolDirectory);
        assert.equal(image.width, 1200);
        assert.equal(image.height, 800);
        assert.equal(image.hasAlpha, true);
        assert.ok(image.size > 16 * 1024);
        const compressedImage = await encodeImage(imageSource, directory, image, { target: 16 * 1024, format: "png" }, signal, () => {}, toolDirectory);
        assert.ok(compressedImage.size <= 16 * 1024);
        assert.equal(compressedImage.original, false);

        await assert.rejects(() => encode(3, 7, MiB), /within the video/);
        await assert.rejects(() => encode(0, null, 100), /too long for the target/);
    } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
});
