# WeirdM — AI-assisted fork

> **This is a fork of [rebane2001/WeirdM](https://github.com/rebane2001/WeirdM).**
>
> The original WeirdM project was created by **rebane2001**. This repository is **not the original project and does not claim original authorship**. It is a modified fork maintained under **[mciochu/WeirdM](https://github.com/mciochu/WeirdM)**.
>
> The current fork contains substantial changes developed and maintained with **AI assistance**, including the browser processing pipeline, AV1 browser-decoder fallback, single-frame processing model, diagnostics, UI, and Render configuration.
>
> **Original source:** https://github.com/rebane2001/WeirdM  
> **License:** Unlicense (see upstream repository).


WeirdM creates WebM videos whose **dimensions change while the video is playing**, while keeping the source audio running.

The current pipeline deliberately uses **one graphic only**:

1. The browser decodes exactly the first video frame.
2. That single frame is saved as `poster.png`.
3. The source video's remaining frames are never decoded or turned into image files.
4. The single poster is repeatedly encoded into short VP8 WebM segments with different dimensions.
5. FFmpeg's concat demuxer joins those segments with stream copy so the final WebM can change dimensions during playback.
6. The source audio is extracted and encoded to WebM-compatible Opus, then muxed over the dynamic video.
7. The final WebM is downloaded directly to the user's device.

This makes long videos dramatically cheaper to process because the browser does not create thousands of PNG frames.

The resizing effect relies on WebM/Matroska and VP8 supporting resolution changes at stream boundaries. See:
- https://blog.parallax.fyi/video-resizing/
- https://github.com/maniekx86/webm-resolution

## Modes

### Bounce

Changes horizontal and/or vertical size using sine/cosine motion.

### Random

Chooses a new horizontal and/or vertical size for each generated size segment. The source video itself is not decoded frame-by-frame.

### Trim first frame

Uses ImageMagick `-trim` once on the first frame, then reuses that single trimmed graphic for the whole video.

## Quality

CRF is passed to the VP8 encoder. Lower values favor quality and larger files.

## Browser processing

Videos are processed locally. Nothing is uploaded by WeirdM itself.

Only the first frame is decoded into a graphic. The rest of the source video is not frame-processed; its duration is used to determine the WebM length and its audio is retained via Opus.

The app uses:
- `@ffmpeg/ffmpeg@0.10.1`
- `wasm-imagemagick@1.2.8`

Those versions are intentionally pinned because this is a small static browser app and the FFmpeg API used by the project is the older 0.10.x API.

## Render

WeirdM is a static site. It does not need Node, a server process, or a build step.

Render configuration is included in `render.yaml`:

- branch: `mane`
- publish directory: repository root
- Cross-Origin-Opener-Policy: `same-origin`
- Cross-Origin-Embedder-Policy: `require-corp`

The two cross-origin isolation headers are required for `SharedArrayBuffer`, which FFmpeg.wasm needs in this setup.

If the existing Render Static Site was created manually, make sure the same two headers are present in its Dashboard configuration. Adding `render.yaml` does not by itself guarantee that an existing manually-created service has been converted to a Blueprint-managed service.

## Development

There is no package manager dependency tree for the app itself.

Basic syntax validation:

```bash
node --check app.js
```

A GitHub Actions workflow also checks JavaScript syntax, static file references, and the Render configuration on pushes to `mane`.

## Processing model

The current fork intentionally does **not** process every source frame.

For each input video:

- exactly one graphic is extracted: the first video frame;
- that graphic is reused for the entire output;
- the source video's remaining frames are ignored;
- the output duration comes from the source video;
- the source audio is extracted and encoded to Opus;
- the single graphic is encoded into a bounded number of dynamic-size WebM segments (up to 240).

This keeps long inputs much lighter than frame-by-frame processing while preserving the WeirdM resizing concept.

## Attribution

This repository is a modified fork of **[rebane2001/WeirdM](https://github.com/rebane2001/WeirdM)**.

The original project and its historical implementation belong to the upstream project. Changes in this fork are maintained under `mciochu/WeirdM` and have been developed with AI assistance.

Please refer to the upstream repository for the original project history and source context.
