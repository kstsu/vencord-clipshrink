# ClipShrink

ClipShrink is a desktop Vencord userplugin that trims videos and compresses them to fit Discord's estimated upload limit. Processing happens on your computer with FFmpeg. The result goes into your Discord draft; ClipShrink does not send the message for you or modify the original file.

## Install

1. Install a current [FFmpeg build](https://ffmpeg.org/download.html) with `ffmpeg`, `ffprobe`, `libx264`, and AAC support.
2. Follow Vencord's [custom plugin guide](https://docs.vencord.dev/installing/custom-plugins/) to set up a source checkout. Copy [`clipShrink.desktop`](clipShrink.desktop) into `src/userplugins/`, keeping the `.desktop` suffix. From the Vencord checkout, run `pnpm install --frozen-lockfile`, `pnpm build`, and `pnpm inject` for Discord Desktop. Fully restart Discord.
3. Enable **ClipShrink** in **Vencord → Plugins**. If FFmpeg is not on your PATH, open ClipShrink's settings, click **Choose FFmpeg executable**, and select your trusted `ffmpeg.exe` (Windows) or `ffmpeg` (macOS/Linux). `ffprobe` must be in the same folder.

The prebuilt Vencord installer alone cannot install this userplugin. The browser version is not supported.

## Use

1. Click the **ClipShrink** scissors button in the chat composer and select a video.
2. Enter an optional trim range using `HH:MM:SS`, `MM:SS`, or seconds. For example, `00:15:13 - 00:17:22` keeps 2 minutes and 9 seconds; `15.5 - 18` keeps 2.5 seconds. Leave it blank to keep the whole video, or use `15 -` to keep everything after 15 seconds.
3. Click **Prepare attachment**. When it appears in your draft, add any message text and send as usual.

ClipShrink uses Discord's live account limit when available, considers known boosted-server upload perks, and leaves 2% headroom. Its fallback account limits are 20 MiB for Free, 50 MiB for Nitro Basic, and up to 1 GiB for full Nitro. Discord may apply other limits or experiments; if Discord rejects a file, set a lower **size cap** in ClipShrink settings and retry. The cap cannot increase the estimate.

An untrimmed H.264/AAC MP4 that already fits is attached without re-encoding. Other results use H.264 MP4 with AAC audio when present. Large outputs can use significant memory when loaded into the Discord composer; set a lower cap or select a shorter range if needed. Normal Discord uploads, paste, and drag-and-drop are not intercepted.

## Development checks

- Run `pnpm test:ts` and `pnpm build --dev` from the Vencord checkout after copying the userplugin.
- Run `node --test tests/clip.test.mjs` from this repository to test the range and limit logic (Node 22.18+).
- Run `pnpm dlx tsx --test tests/*.test.mjs` to include the real FFmpeg integration test. Put the tools on PATH or set `CLIPSHRINK_TEST_FFMPEG_DIR` to their directory. The integration test generates its own media and cleans it up.

Licensed under GPL-3.0-or-later.
