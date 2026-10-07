const { createFFmpeg } = FFmpeg;

const MODES = ["bounce", "random", "trim"];
const DEFAULT_FPS = 15;
const DEFAULT_CRF = 42;

// WeirdM now uses exactly one source graphic: the first video frame.
// The audio keeps the source video's full duration.
// Resolution changes happen at segment boundaries rather than per source frame.
const MIN_SEGMENT_SECONDS = 0.5;
const MAX_SEGMENTS = 240;

let ffmpeg = null;
let fps = DEFAULT_FPS;
let crf = DEFAULT_CRF;
let mode = "bounce";
let processing = false;
let cancelRequested = false;
let generatedSegments = [];
let logLines = [];
let logBuffer = "";
let activeStep = "";
let lastFfmpegOutput = "";

const LOG_LIMIT = 300000;

const filePicker = document.getElementById("filepicker");
const startBtn = document.querySelector(".button.start");
const cancelBtn = document.querySelector(".button.cancel");
const statusEl = document.getElementById("status");

const setStatus = (message = "", isError = false) => {
    statusEl.textContent = message;
    statusEl.classList.toggle("error", isError);
};

const formatLogValue = (value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
};

const renderLogs = () => {
    const logEl = document.getElementById("logs");
    logEl.value = logBuffer;
    logEl.scrollTop = logEl.scrollHeight;
};

const addLog = (message, level = "INFO") => {
    const timestamp = new Date().toISOString();
    const prefix = \`[\${timestamp}] [\${level}]\`;
    const line = \`\${prefix} \${formatLogValue(message)}\`;

    logLines.push(line);
    logBuffer = logLines.join("\n");

    if (logBuffer.length > LOG_LIMIT) {
        logBuffer = logBuffer.slice(-LOG_LIMIT);
        logLines = logBuffer.split("\n");
    }

    console.log(line);
    renderLogs();
};

const startStep = (name) => {
    activeStep = name;
    addLog(\`STEP START: \${name}\`);
};

const finishStep = (name) => {
    addLog(\`STEP END: \${name}\`);
};

const resetLogs = () => {
    logLines = [];
    logBuffer = "";
    activeStep = "";
    lastFfmpegOutput = "";
    renderLogs();
};

const clearFfmpegLogs = () => {
    lastFfmpegOutput = "";
};

const setFfmpegLogger = () => {
    if (!ffmpeg) return;

    ffmpeg.setLogger(({ type, message }) => {
        const text = String(message);

        if (type === "fferr") {
            lastFfmpegOutput += text + "\n";
            addLog(\`FFmpeg STDERR: \${text}\`, "FFMPEG");
        } else {
            addLog(\`FFmpeg \${type}: \${text}\`, "FFMPEG");
        }
    });
};

const copyLogs = async () => {
    try {
        await navigator.clipboard.writeText(logBuffer || "No logs.");
        addLog("Diagnostic log copied to clipboard.", "INFO");
        setStatus("Logs copied to clipboard.");
    } catch (error) {
        console.error(error);
        setStatus("Could not copy logs. Select the log text manually.", true);
    }
};

const downloadLogs = () => {
    const blob = new Blob([logBuffer || "No logs."], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = \`weirdm-log-\${new Date().toISOString().replace(/[:.]/g, "-")}.txt\`;
    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const logEnvironment = () => {
    addLog({
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        browserLanguage: navigator.language,
        crossOriginIsolated: window.crossOriginIsolated,
        sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
        url: window.location.href,
        screen: \`\${window.innerWidth}x\${window.innerHeight}\`,
    }, "ENV");
};

const setProgress = (percentage) => {
    if (percentage >= 0) {
        const safePercentage = Math.max(0, Math.min(100, percentage));
        startBtn.textContent = \`Processing (\${safePercentage}%)...\`;
        startBtn.style.background =
            \`linear-gradient(to right, #2d7d46 \${safePercentage}%, #4f545c \${safePercentage}%)\`;
    } else {
        startBtn.textContent = "Process";
        startBtn.style.background = "";
    }
};

const setControls = (running) => {
    processing = running;
    startBtn.disabled = running;
    cancelBtn.disabled = !running;
    filePicker.disabled = running;

    document
        .querySelectorAll('input[name="mode"], select, input[type="number"], input[type="checkbox"]')
        .forEach((element) => {
            element.disabled = running;
        });
};

const throwIfCancelled = () => {
    if (cancelRequested) {
        throw new Error("Processing cancelled.");
    }
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const getNumericValue = (id, fallback, min, max) => {
    const value = Number(document.getElementById(id).value);
    if (!Number.isFinite(value)) return fallback;
    return clamp(value, min, max);
};

const getMode = () => {
    for (const candidate of MODES) {
        if (document.getElementById(candidate).checked) return candidate;
    }

    return "bounce";
};

const syncModeOptions = () => {
    mode = getMode();

    for (const candidate of MODES) {
        const options = document.getElementById(\`\${candidate}-options\`);
        options.hidden = candidate !== mode;
    }
};

const getInputExtension = (file) => {
    const match = file.name.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : "bin";
};

const sanitizeDownloadName = (name) => {
    const withoutExtension = name.replace(/\.[^/.]+$/, "");
    const safe = withoutExtension
        .replace(/[^a-z0-9._-]+/gi, "_")
        .replace(/^_+|_+$/g, "");

    return (safe || "video") + "_weirdm.webm";
};

const writeTextFile = (name, text) => {
    ffmpeg.FS("writeFile", name, new TextEncoder().encode(text));
};

const readFile = (name) => {
    try {
        return ffmpeg.FS("readFile", name);
    } catch {
        return null;
    }
};

const listFiles = () => {
    try {
        return ffmpeg.FS("readdir", "/");
    } catch {
        return [];
    }
};

const unlinkQuietly = (name) => {
    try {
        ffmpeg.FS("unlink", name);
    } catch {}
};

const assertOutputFile = (name, label) => {
    const data = readFile(name);

    if (!data || !data.length) {
        throw new Error(\`\${label} was not created by FFmpeg.\`);
    }

    if (
        name.endsWith(".webm") &&
        (data[0] !== 0x1a || data[1] !== 0x45 || data[2] !== 0xdf || data[3] !== 0xa3)
    ) {
        throw new Error(\`\${label} was created, but it is not a valid WebM file.\`);
    }

    return data;
};

const createFFmpegInstance = async () => {
    addLog("Creating FFmpeg WASM instance…");
    ffmpeg = createFFmpeg({ log: true });
    await ffmpeg.load();
    setFfmpegLogger();
    addLog("FFmpeg WASM loaded.");
};

const runFFmpeg = async (...args) => {
    throwIfCancelled();

    addLog(\`FFmpeg RUN: \${args.join(" ")}\`, "COMMAND");
    clearFfmpegLogs();

    try {
        await ffmpeg.run(...args);
    } catch (error) {
        addLog(\`FFmpeg command failed: \${args.join(" ")}\`, "ERROR");

        if (lastFfmpegOutput.trim()) {
            addLog(\`FFmpeg last output:\n\${lastFfmpegOutput.trim()}\`, "ERROR");
        }

        addLog(error, "ERROR");
        throw error;
    }

    throwIfCancelled();
};

const waitForVideoEvent = (video, eventName, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
        const readyStateForEvent = {
            loadedmetadata: HTMLMediaElement.HAVE_METADATA,
            loadeddata: HTMLMediaElement.HAVE_CURRENT_DATA,
        }[eventName];

        if (readyStateForEvent !== undefined && video.readyState >= readyStateForEvent) {
            resolve();
            return;
        }

        let timer = null;

        const cleanup = () => {
            if (timer) clearTimeout(timer);
            video.removeEventListener(eventName, onEvent);
            video.removeEventListener("error", onError);
        };

        const onEvent = () => {
            cleanup();
            resolve();
        };

        const onError = () => {
            cleanup();
            reject(new Error(
                \`Browser video decoder emitted an error while waiting for \${eventName}: \` +
                \`\${video.error?.message || "unknown media error"}.\`
            ));
        };

        timer = setTimeout(() => {
            cleanup();
            reject(new Error(\`Timed out waiting for browser video event "\${eventName}".\`));
        }, timeoutMs);

        video.addEventListener(eventName, onEvent, { once: true });
        video.addEventListener("error", onError, { once: true });
    });

const canvasToPngBytes = (canvas) =>
    new Promise((resolve, reject) => {
        canvas.toBlob(async (blob) => {
            if (!blob) {
                reject(new Error("Browser could not encode the first video frame as PNG."));
                return;
            }

            try {
                resolve(new Uint8Array(await blob.arrayBuffer()));
            } catch (error) {
                reject(error);
            }
        }, "image/png");
    });

const extractFirstFrame = async (file) => {
    startStep("Extract exactly one graphic: first video frame");

    const video = document.createElement("video");
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: false });

    if (!context) {
        throw new Error("Browser canvas 2D context is unavailable.");
    }

    const objectUrl = URL.createObjectURL(file);

    try {
        video.preload = "auto";
        video.muted = true;
        video.playsInline = true;
        video.src = objectUrl;

        addLog(\`Browser decoder input MIME: \${file.type || "(unknown)"}\`, "INPUT");
        addLog(\`canPlayType(video/mp4): \${video.canPlayType("video/mp4") || "empty"}\`, "INPUT");
        addLog(\`canPlayType(video/webm): \${video.canPlayType("video/webm") || "empty"}\`, "INPUT");

        await waitForVideoEvent(video, "loadedmetadata");
        await waitForVideoEvent(video, "loadeddata");

        const width = video.videoWidth;
        const height = video.videoHeight;
        const duration = video.duration;

        if (!width || !height) {
            throw new Error("Browser returned an invalid video size.");
        }

        if (!Number.isFinite(duration) || duration <= 0) {
            throw new Error("Browser returned no usable video duration.");
        }

        canvas.width = width;
        canvas.height = height;
        context.drawImage(video, 0, 0, width, height);

        const pngBytes = await canvasToPngBytes(canvas);
        ffmpeg.FS("writeFile", "poster.png", pngBytes);

        addLog({
            durationSeconds: duration,
            width,
            height,
            sourceGraphic: "poster.png",
            sourceFramesDecoded: 1,
        }, "INPUT");

        addLog(
            "Only the first video frame was decoded. The remaining source video frames are not used.",
            "SUCCESS"
        );

        finishStep("Extract exactly one graphic: first video frame");

        return {
            duration,
            width,
            height,
        };
    } catch (error) {
        addLog("Could not extract the first video frame with the browser decoder.", "ERROR");
        addLog(error, "ERROR");
        throw error;
    } finally {
        video.pause();
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(objectUrl);
        canvas.width = 1;
        canvas.height = 1;
    }
};

const preparePoster = async () => {
    if (mode !== "trim") return;

    startStep("Trim the single source graphic once");

    const poster = readFile("poster.png");

    if (!poster) {
        throw new Error("poster.png is missing before Trim processing.");
    }

    const result = await Magick.Call(
        [{ name: "in.png", content: poster }],
        [
            "convert",
            "in.png",
            "-trim",
            "-shave", "1x1",
            "+repage",
            "poster.png",
        ]
    );

    if (!result || !result.length || !result[0].buffer) {
        throw new Error("ImageMagick did not return the trimmed first-frame graphic.");
    }

    ffmpeg.FS("writeFile", "poster.png", result[0].buffer);

    addLog(
        "Trim was applied once to the first frame. The same resulting graphic is reused for the whole video.",
        "SUCCESS"
    );

    finishStep("Trim the single source graphic once");
};

const getBouncePercent = (timeSeconds, style, speed) => {
    if (style === "none") return 100;

    const phase = timeSeconds * speed;
    const wave = style === "cos" ? Math.cos(phase) : Math.sin(phase);

    return clamp(Math.ceil(((wave + 1) * 50)), 2, 100);
};

const getSegmentGeometry = (segmentIndex, startSeconds, baseWidth, baseHeight) => {
    if (mode === "trim") {
        return {
            widthPercent: 100,
            heightPercent: 100,
            width: baseWidth,
            height: baseHeight,
        };
    }

    if (mode === "random") {
        const horizontalEnabled = document.getElementById("random-h").checked;
        const verticalEnabled = document.getElementById("random-v").checked;

        return {
            widthPercent: horizontalEnabled ? clamp(Math.ceil(Math.random() * 99) + 1, 2, 100) : 100,
            heightPercent: verticalEnabled ? clamp(Math.ceil(Math.random() * 99) + 1, 2, 100) : 100,
        };
    }

    const speedH = getNumericValue("bounce-h-speed", 10, 1, 50);
    const speedV = getNumericValue("bounce-v-speed", 10, 1, 50);
    const styleH = document.getElementById("bounce-h-style").value;
    const styleV = document.getElementById("bounce-v-style").value;

    return {
        widthPercent: getBouncePercent(startSeconds, styleH, speedH),
        heightPercent: getBouncePercent(startSeconds, styleV, speedV),
    };
};

const makeWebmSegment = async ({
    index,
    duration,
    widthPercent,
    heightPercent,
}) => {
    throwIfCancelled();

    const outputName = \`\${index}.webm\`;
    const widthExpression = \`ceil(iw*\${widthPercent}/100/2)*2\`;
    const heightExpression = \`ceil(ih*\${heightPercent}/100/2)*2\`;

    await runFFmpeg(
        "-y",
        "-loop", "1",
        "-i", "poster.png",
        "-t", duration.toFixed(3),
        "-an",
        "-vf", \`scale=\${widthExpression}:\${heightExpression}\`,
        "-r", String(fps),
        "-c:v", "libvpx",
        "-pix_fmt", "yuv420p",
        "-crf", String(crf),
        "-b:v", "0",
        outputName
    );

    assertOutputFile(outputName, \`Video segment \${index}\`);
    generatedSegments.push(index);
};

const buildSegments = async ({ duration, width, height }) => {
    startStep("Generate dynamic-size video from one graphic");

    const targetSegmentCount = Math.min(
        MAX_SEGMENTS,
        Math.max(1, Math.ceil(duration / MIN_SEGMENT_SECONDS))
    );

    const segmentSeconds = Math.max(MIN_SEGMENT_SECONDS, duration / targetSegmentCount);
    const actualSegmentCount = Math.ceil(duration / segmentSeconds);

    addLog({
        strategy: "one static graphic + changing WebM segment dimensions",
        sourceGraphic: "poster.png",
        durationSeconds: duration,
        segmentSeconds,
        plannedSegments: actualSegmentCount,
        baseWidth: width,
        baseHeight: height,
    }, "INFO");

    for (let index = 0; index < actualSegmentCount; index++) {
        throwIfCancelled();

        const start = index * segmentSeconds;
        const segmentDuration = Math.min(segmentSeconds, duration - start);
        if (segmentDuration <= 0) break;

        const geometry = getSegmentGeometry(index, start, width, height);

        addLog({
            segment: index + 1,
            totalSegments: actualSegmentCount,
            startSeconds: Number(start.toFixed(3)),
            durationSeconds: Number(segmentDuration.toFixed(3)),
            widthPercent: geometry.widthPercent,
            heightPercent: geometry.heightPercent,
        }, "SHAPE");

        await makeWebmSegment({
            index,
            duration: segmentDuration,
            widthPercent: geometry.widthPercent,
            heightPercent: geometry.heightPercent,
        });

        setProgress(10 + Math.floor(((index + 1) / actualSegmentCount) * 75));
        setStatus(
            \`Building shape segments: \${index + 1}/\${actualSegmentCount}\`
        );
    }

    finishStep("Generate dynamic-size video from one graphic");
    addLog(\`Generated \${generatedSegments.length} WebM segments from exactly one source graphic.\`);

    if (!generatedSegments.length) {
        throw new Error("No WebM video segments were generated.");
    }
};

const joinWebmSegments = async () => {
    startStep(\`Join \${generatedSegments.length} WebM segments\`);

    const concat = generatedSegments
        .map((index) => \`file \${index}.webm\`)
        .join("\n") + "\n";

    writeTextFile("segments-concat.txt", concat);
    addLog(\`segments-concat.txt contains \${generatedSegments.length} segments.\`, "INPUT");

    clearFfmpegLogs();

    try {
        await runFFmpeg(
            "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", "segments-concat.txt",
            "-map", "0:v:0",
            "-c", "copy",
            "-f", "webm",
            "vid.webm"
        );
    } catch (error) {
        addLog(
            "Joining the dynamic WebM segments failed. Resolution changes require stream copy.",
            "ERROR"
        );

        if (lastFfmpegOutput.trim()) {
            addLog(\`Full FFmpeg concat output:\n\${lastFfmpegOutput.trim()}\`, "ERROR");
        }

        throw new Error(
            "FFmpeg could not join the dynamic-size WebM segments. " +
            "See Diagnostics for the complete FFmpeg output."
        );
    }

    const result = assertOutputFile("vid.webm", "Joined WebM");
    addLog(\`Joined dynamic WebM size: \${result.length} bytes.\`);
    finishStep(\`Join \${generatedSegments.length} WebM segments\`);

    return result;
};

const muxSourceAudio = async (inputName, durationSeconds) => {
    startStep("Keep the source audio for the full video duration");

    unlinkQuietly("audio.opus");
    unlinkQuietly("out.webm");

    try {
        await runFFmpeg(
            "-y",
            "-i", inputName,
            "-vn",
            "-sn",
            "-dn",
            "-map", "0:a:0",
            "-c:a", "libopus",
            "-b:a", "96k",
            "-t", durationSeconds.toFixed(3),
            "audio.opus"
        );

        assertOutputFile("audio.opus", "Source audio track");

        await runFFmpeg(
            "-y",
            "-i", "vid.webm",
            "-i", "audio.opus",
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-c:v", "copy",
            "-c:a", "copy",
            "-shortest",
            "-metadata", "title=WeirdM",
            "out.webm"
        );

        const output = assertOutputFile("out.webm", "Final WebM");
        addLog(
            \`Source audio encoded to Opus and muxed with the dynamic video. Output size: \${output.length} bytes.\`,
            "SUCCESS"
        );

        finishStep("Keep the source audio for the full video duration");
        return output;
    } catch (error) {
        addLog(
            "Audio could not be encoded/muxed. Falling back to video-only output.",
            "WARN"
        );

        if (lastFfmpegOutput.trim()) {
            addLog(\`FFmpeg audio output:\n\${lastFfmpegOutput.trim()}\`, "WARN");
        }

        const videoOnly = readFile("vid.webm");
        if (!videoOnly) {
            throw error;
        }

        ffmpeg.FS("writeFile", "out.webm", videoOnly);
        const output = assertOutputFile("out.webm", "Video-only WebM");
        addLog(
            \`Video-only WebM created because source audio was unavailable. Size: \${output.length} bytes.\`,
            "WARN"
        );

        finishStep("Keep the source audio for the full video duration");
        return output;
    }
};

const cleanupWorkspace = (inputName) => {
    unlinkQuietly(inputName);
    unlinkQuietly("poster.png");
    unlinkQuietly("segments-concat.txt");
    unlinkQuietly("audio.opus");
    unlinkQuietly("vid.webm");
    unlinkQuietly("out.webm");

    generatedSegments.forEach((index) => {
        unlinkQuietly(\`\${index}.webm\`);
    });

    generatedSegments = [];
};

const makeVideo = async (file) => {
    resetLogs();
    addLog("========== WeirdM processing started ==========");
    addLog(
        "NEW PIPELINE: one first-frame graphic + dynamic WebM dimensions + full source audio.",
        "INFO"
    );
    logEnvironment();

    addLog({
        name: file.name,
        type: file.type || "(browser did not provide MIME type)",
        sizeBytes: file.size,
        lastModified: new Date(file.lastModified).toISOString(),
    }, "INPUT");

    fps = DEFAULT_FPS;
    crf = clamp(Math.round(getNumericValue("crf", DEFAULT_CRF, 0, 63)), 0, 63);
    mode = getMode();
    generatedSegments = [];

    const extension = getInputExtension(file);
    const inputName = \`input.\${extension}\`;
    const outputName = sanitizeDownloadName(file.name);

    addLog(
        \`Input extension: \${extension}; internal FFmpeg name: \${inputName}; output: \${outputName}\`,
        "INPUT"
    );
    addLog(
        \`Output frame rate: \${fps} FPS. Source video frames after the first are intentionally ignored.\`,
        "INFO"
    );

    if (typeof SharedArrayBuffer === "undefined" || window.crossOriginIsolated !== true) {
        throw new Error(
            "This page is not cross-origin isolated. Configure Render with " +
            "Cross-Origin-Opener-Policy: same-origin and " +
            "Cross-Origin-Embedder-Policy: require-corp."
        );
    }

    if (!file.size) {
        throw new Error("The selected video file is empty.");
    }

    setProgress(0);
    setStatus("Loading video engine…");
    await createFFmpegInstance();

    ffmpeg.FS(
        "writeFile",
        inputName,
        new Uint8Array(await file.arrayBuffer())
    );

    startStep("Initialize ImageMagick");
    if (!window.magickReady) {
        throw new Error("ImageMagick loader is unavailable.");
    }

    await window.magickReady;

    if (!window.Magick || typeof window.Magick.Call !== "function") {
        throw new Error("ImageMagick failed to initialize.");
    }

    addLog("ImageMagick initialized.");
    finishStep("Initialize ImageMagick");

    setProgress(5);
    setStatus("Reading first video frame…");

    const source = await extractFirstFrame(file);

    await preparePoster();

    setProgress(10);
    setStatus("Creating dynamic dimensions from one graphic…");

    await buildSegments(source);

    setProgress(88);
    setStatus("Joining dynamic WebM…");
    await joinWebmSegments();

    setProgress(95);
    setStatus("Keeping source audio…");

    const final = await muxSourceAudio(inputName, source.duration);

    setProgress(100);
    setStatus("Done. Downloading your WeirdM…");

    addLog(\`SUCCESS: output \${outputName} is ready for download.\`, "SUCCESS");
    addLog("========== WeirdM processing finished successfully ==========");

    const blob = new Blob([new Uint8Array(final)], { type: "video/webm" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = outputName;
    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);

    return outputName;
};

startBtn.addEventListener("click", async () => {
    if (processing) return;

    const file = filePicker.files?.[0];

    if (!file) {
        setStatus("Choose a video file first.", true);
        return;
    }

    cancelRequested = false;
    setControls(true);
    setStatus("Starting…");

    try {
        await makeVideo(file);
    } catch (error) {
        console.error("WeirdM processing failed:", error);
        addLog("========== WeirdM processing FAILED ==========", "ERROR");
        addLog(\`Active step: \${activeStep || "(none)"}\`, "ERROR");
        addLog(error, "ERROR");

        if (lastFfmpegOutput.trim()) {
            addLog(\`Latest FFmpeg output:\n\${lastFfmpegOutput.trim()}\`, "ERROR");
        }

        if (cancelRequested) {
            setProgress(-1);
            setStatus("Processing cancelled.");
        } else {
            const message = error instanceof Error ? error.message : String(error);
            setProgress(-1);
            setStatus(message, true);
            alert("Processing failed. Please copy the Diagnostics log.\n\n" + message);
        }
    } finally {
        try {
            const inputName = file ? \`input.\${getInputExtension(file)}\` : null;

            if (ffmpeg && inputName) {
                cleanupWorkspace(inputName);
            }
        } catch (cleanupError) {
            console.warn("Cleanup failed:", cleanupError);
        }

        try {
            ffmpeg?.exit();
        } catch {}

        ffmpeg = null;
        setControls(false);
        addLog("Cleanup complete.");

        if (!cancelRequested && !statusEl.classList.contains("error")) {
            setProgress(-1);
        }
    }
});

cancelBtn.addEventListener("click", () => {
    if (!processing) return;

    cancelRequested = true;
    setStatus("Cancelling…");

    try {
        ffmpeg?.exit();
    } catch {}
});

document.querySelectorAll('input[name="mode"]').forEach((radio) => {
    radio.addEventListener("change", syncModeOptions);
});

document.getElementById("copy-logs").addEventListener("click", copyLogs);
document.getElementById("download-logs").addEventListener("click", downloadLogs);

syncModeOptions();
setControls(false);
