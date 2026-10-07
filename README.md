# WeirdM

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

Chooses a new horizontal and/or vertical size for every frame.

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

## Performance notes

Video processing is CPU- and memory-intensive because frames are decoded and manipulated in the browser.

The current pipeline releases processed PNG frames immediately after their WebM segment is encoded and periodically recreates the FFmpeg worker while retaining only the source and already-created WebM segments.

The dynamic-size video uses a bounded number of WebM segments (up to 240), so a 4-minute source does not produce thousands of intermediate image files.
