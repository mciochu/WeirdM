# WeirdM

WeirdM creates WebM videos whose **dimensions change while the video is playing**.

It is intentionally different from a normal video converter:

1. The source video is decoded locally in the browser.
2. Frames are processed one by one with WebAssembly ImageMagick.
3. Bounce, Random, or Trim changes the dimensions of the processed frames.
4. Frames with the same geometry are encoded into VP8 WebM segments.
5. FFmpeg's concat demuxer joins those segments with stream copy so the final WebM can change dimensions during playback.
6. Original audio is preserved when possible; otherwise it is encoded to WebM-compatible Opus/Vorbis.
7. The final WebM is downloaded directly to the user's device.

The resizing effect relies on WebM/Matroska and VP8 supporting resolution changes at stream boundaries. See:
- https://blog.parallax.fyi/video-resizing/
- https://github.com/maniekx86/webm-resolution

## Modes

### Bounce

Changes horizontal and/or vertical size using sine/cosine motion.

### Random

Chooses a new horizontal and/or vertical size for every frame.

### Trim

Uses ImageMagick `-trim` to remove solid-color or transparent borders from each frame.

## Quality

CRF is passed to the VP8 encoder. Lower values favor quality and larger files.

## Browser processing

Videos are processed locally. Nothing is uploaded by WeirdM itself.

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

Shorter clips and lower source resolutions are still recommended for browser stability.
