const { createFFmpeg } = FFmpeg;

const MODES = ["bounce", "random", "trim"];
const DEFAULT_FPS = 15;
const DEFAULT_CRF = 42;

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
    const prefix = `[${timestamp}] [${level}]`;
    const line = `${prefix} ${formatLogValue(message)}`;

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
    addLog(`STEP START: ${name}`);
};

const finishStep = (name) => {
    addLog(`STEP END: ${name}`);
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
            addLog(`FFmpeg STDERR: ${text}`, "FFMPEG");
        } else {
            addLog(`FFmpeg ${type}: ${text}`, "FFMPEG");
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
    link.download = `weirdm-log-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
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
        screen: `${window.innerWidth}x${window.innerHeight}`,
    }, "ENV");
};

const setProgress = (percentage) => {
    if (percentage >= 0) {
        const safePercentage = Math.max(0, Math.min(100, percentage));
        startBtn.textContent = `Processing (${safePercentage}%)...`;
        startBtn.style.background = `linear-gradient(to right, #2d7d46 ${safePercentage}%, #4f545c ${safePercentage}%)`;
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

    document.querySelectorAll('input[name="mode"], select, input[type="number"], input[type="checkbox"]')
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
        const options = document.getElementById(`${candidate}-options`);
        options.hidden = candidate !== mode;
    }
};

const getRandomResize = (frame) => {
    if (frame === 1) return "100%x100%";

    const doH = document.getElementById("random-h").checked;
    const doV = document.getElementById("random-v").checked;

    const horizontal = doH ? clamp(Math.ceil(Math.random() * 100), 2, 100) : 100;
    const vertical = doV ? clamp(Math.ceil(Math.random() * 100), 2, 100) : 100;

    return `${horizontal}%x${vertical}%`;
};

const getBounceResize = (frame) => {
    if (frame === 1) return "100%x100%";

    const speedH = getNumericValue("bounce-h-speed", 10, 1, 50);
    const speedV = getNumericValue("bounce-v-speed", 10, 1, 50);

    const funcs = {
        none: () => 100,
        sin: (speed) => (Math.sin(frame * speed / fps) + 1) * 50,
        cos: (speed) => (Math.cos(frame * speed / fps) + 1) * 50,
    };

    const hStyle = document.getElementById("bounce-h-style").value;
    const vStyle = document.getElementById("bounce-v-style").value;

    const horizontal = clamp(Math.ceil(funcs[hStyle](speedH)), 2, 100);
    const vertical = clamp(Math.ceil(funcs[vStyle](speedV)), 2, 100);

    return `${horizontal}%x${vertical}%`;
};

const getInputExtension = (file) => {
    const match = file.name.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : "bin";
};

const sanitizeDownloadName = (name) => {
    const withoutExtension = name.replace(/\.[^/.]+$/, "");
    const safe = withoutExtension.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "");
    return (safe || "video") + "_weirdm.webm";
};

const writeTextFile = (name, text) => {
    ffmpeg.FS("writeFile", name, new TextEncoder().encode(text));
};

const fileExists = (name) => {
    try {
        ffmpeg.FS("readFile", name);
        return true;
    } catch {
        return false;
    }
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
        throw new Error(`${label} was not created by FFmpeg.`);
    }

    // WebM/Matroska files start with the EBML header.
    if (name.endsWith(".webm") && (data[0] !== 0x1a || data[1] !== 0x45 || data[2] !== 0xdf || data[3] !== 0xa3)) {
        throw new Error(`${label} was created, but it is not a valid WebM file.`);
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
    addLog(`FFmpeg RUN: ${args.join(" ")}`, "COMMAND");
    clearFfmpegLogs();

    try {
        await ffmpeg.run(...args);
    } catch (error) {
        addLog(`FFmpeg command failed: ${args.join(" ")}`, "ERROR");
        if (lastFfmpegOutput.trim()) {
            addLog(`FFmpeg last output:\n${lastFfmpegOutput.trim()}`, "ERROR");
        }
        addLog(error, "ERROR");
        throw error;
    }

    throwIfCancelled();
};

const detectInputFps = async (inputName) => {
    startStep("Detect input video properties");
    clearFfmpegLogs();

    await runFFmpeg(
        "-y",
        "-i", inputName,
        "-map", "0:v:0",
        "-frames:v", "1",
        "-f", "null",
        "-"
    );

    const probeText = lastFfmpegOutput;
    const match = probeText.match(/(\d+(?:\.\d+)?)\s+fps\b/);

    if (match) {
        fps = Number(match[1]);
        addLog(`Detected FPS: ${fps}`);
    } else {
        fps = DEFAULT_FPS;
        addLog(`Could not reliably detect FPS; using fallback ${DEFAULT_FPS}.`, "WARN");
    }

    finishStep("Detect input video properties");
};

const recycleFFmpeg = async (segmentCount, inputName) => {
    const preservedNames = [inputName];

    for (let i = 0; i < segmentCount; i++) {
        preservedNames.push(`${i}.webm`);
    }

    const preservedFiles = [];

    for (const name of preservedNames) {
        const data = readFile(name);
        if (data) {
            preservedFiles.push([name, data]);
            unlinkQuietly(name);
        }
    }

    try {
        ffmpeg.exit();
    } catch {}

    await createFFmpegInstance();

    for (const [name, data] of preservedFiles) {
        ffmpeg.FS("writeFile", name, data);
    }
};

const makeWebmPart = async (frameNames, segmentIndex) => {
    if (!frameNames.length) return false;

    const concat = frameNames.map((name) => `file '${name}'`).join("\n") + "\n";
    writeTextFile("frames-concat.txt", concat);

    await runFFmpeg(
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", "frames-concat.txt",
        "-an",
        "-vf", `scale=ceil(iw/2)*2:ceil(ih/2)*2,settb=AVTB,setpts=N/${fps}/TB,fps=${fps}`,
        "-c:v", "libvpx",
        "-pix_fmt", "yuv420p",
        "-crf", String(crf),
        "-b:v", "0",
        segmentIndex + ".webm"
    );

    assertOutputFile(segmentIndex + ".webm", `Video segment ${segmentIndex}.webm`);
    generatedSegments.push(segmentIndex);

    // PNGs are no longer needed after the segment has been encoded.
    // The original project kept them around, which made long videos
    // unnecessarily memory-hungry.
    frameNames.forEach(unlinkQuietly);
    unlinkQuietly("frames-concat.txt");

    return true;
};

const joinWebmSegments = async (segmentCount) => {
    startStep(`Join ${segmentCount} WebM segments`);

    const concat = Array.from(
        { length: segmentCount },
        (_, index) => `file ${index}.webm`
    ).join("\n") + "\n";

    writeTextFile("segments-concat.txt", concat);
    addLog(`segments-concat.txt:\n${concat}`, "INPUT");

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
        addLog(`Join failed for ${segmentCount} segments.`, "ERROR");
        if (lastFfmpegOutput.trim()) {
            addLog(`Full FFmpeg concat output:\n${lastFfmpegOutput.trim()}`, "ERROR");
        }
        throw new Error(
            "FFmpeg could not join the processed WebM segments. " +
            "See the Diagnostic log below for the complete FFmpeg output."
        );
    }

    const result = assertOutputFile("vid.webm", "Joined WebM");
    addLog(`Joined WebM size: ${result.length} bytes.`);
    finishStep(`Join ${segmentCount} WebM segments`);
    return result;
};

const muxAudio = async (inputName) => {
    startStep("Mux final WebM and source audio");
    unlinkQuietly("out.webm");

    addLog(`Audio input: ${inputName}`);

    // First preserve an already WebM-compatible audio stream without
    // re-encoding. If that is not possible, encode to Opus/Vorbis.
    const attempts = [
        { codec: "copy", args: [] },
        { codec: "libopus", args: ["-b:a", "96k"] },
        { codec: "libvorbis", args: ["-q:a", "4"] },
    ];

    for (const attempt of attempts) {
        try {
            await runFFmpeg(
                "-y",
                "-i", "vid.webm",
                "-i", inputName,
                "-map", "0:v:0",
                "-map", "1:a:0?",
                "-c:v", "copy",
                "-c:a", attempt.codec,
                ...attempt.args,
                "-metadata", "title=WeirdM",
                "out.webm"
            );

            const output = assertOutputFile("out.webm", "Final WebM");
            addLog(`Final WebM created with audio codec: ${attempt.codec}; size: ${output.length} bytes.`);
            finishStep("Mux final WebM and source audio");
            return output;
        } catch (error) {
            console.warn(`Audio mux attempt ${attempt.codec} failed:`, error);
            addLog(`Audio mux attempt ${attempt.codec} failed: ${formatLogValue(error)}`, "WARN");
            if (lastFfmpegOutput.trim()) {
                addLog(`FFmpeg audio output:\n${lastFfmpegOutput.trim()}`, "WARN");
            }
            unlinkQuietly("out.webm");
        }
    }

    // Audio is optional for WeirdM. A video-only result is still a valid
    // export when the source audio cannot be represented in WebM.
    const videoOnly = readFile("vid.webm");
    if (!videoOnly) {
        throw new Error("Final video exists neither with nor without audio.");
    }

    ffmpeg.FS("writeFile", "out.webm", videoOnly);
    addLog("No compatible source audio was available; using video-only WebM.", "WARN");
    const output = assertOutputFile("out.webm", "Final video-only WebM");
    addLog(`Final video-only WebM size: ${output.length} bytes.`);
    finishStep("Mux final WebM and source audio");
    return output;
};

const cleanupWorkspace = (inputName) => {
    unlinkQuietly(inputName);
    unlinkQuietly("frames-concat.txt");
    unlinkQuietly("segments-concat.txt");
    unlinkQuietly("vid.webm");
    unlinkQuietly("out.webm");

    generatedSegments.forEach((index) => {
        unlinkQuietly(`${index}.webm`);
    });

    generatedSegments = [];
};

const makeVideo = async (file) => {
    resetLogs();
    addLog("========== WeirdM processing started ==========");
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
    const inputName = `input.${extension}`;
    const outputName = sanitizeDownloadName(file.name);
    addLog(`Input extension: ${extension}; internal FFmpeg name: ${inputName}; output: ${outputName}`, "INPUT");

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

    setStatus("Loading image processor…");
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
    throwIfCancelled();

    setProgress(5);
    ffmpeg.FS("writeFile", inputName, new Uint8Array(await file.arrayBuffer()));

    setStatus("Reading video information…");
    await detectInputFps(inputName);

    setStatus(`Extracting frames at about ${fps} FPS…`);
    startStep("Decode source video into PNG frames");

    // Explicitly use the image2 muxer and preserve the source frame rate.
    // This avoids relying on the input extension and makes MP4/MOV/WebM
    // decoding behave consistently in the older FFmpeg.wasm runtime.
    await runFFmpeg(
        "-y",
        "-i", inputName,
        "-map", "0:v:0",
        "-an",
        "-sn",
        "-dn",
        "-vsync", "0",
        "-f", "image2",
        "-start_number", "1",
        "%06d.png"
    );

    const decodedFrames = listFiles()
        .filter((name) => /^\d+\.png$/i.test(name))
        .sort((a, b) => Number(a.slice(0, -4)) - Number(b.slice(0, -4)));

    if (!decodedFrames.length) {
        const files = listFiles()
            .filter((name) => name !== "." && name !== "..")
            .slice(0, 40);

        throw new Error(
            "FFmpeg decoded no video frames. " +
            "The MP4 container is supported, but its video codec may not be " +
            "supported by this browser FFmpeg build." +
            (files.length ? ` Files in FFmpeg filesystem: ${files.join(", ")}.` : "")
        );
    }

    const framesTotal = decodedFrames.length;
    addLog(`FFmpeg decoded ${framesTotal} PNG frames.`);

    finishStep("Decode source video into PNG frames");
    setProgress(10);
    setStatus(`Processing ${framesTotal} frames…`);
    startStep(`Apply ${mode.toUpperCase()} effect to frames`);

    let lastGeometry = null;
    let segmentIndex = 0;
    let frameNames = [];

    for (let frame = 1; frame <= framesTotal; frame++) {
        throwIfCancelled();

        const frameName = String(frame).padStart(6, "0") + ".png";
        const inputFrame = readFile(frameName);

        if (!inputFrame) {
            throw new Error(`Missing decoded frame ${frameName}.`);
        }

        const args = {
            trim: [
                "convert",
                "in.png",
                "-trim",
                "-shave", "1x1",
                "+repage",
                "-set", "filename:mysize", "%wx%h",
                "%[filename:mysize]"
            ],
            bounce: [
                "convert",
                "in.png",
                "-resize", getBounceResize(frame),
                "-set", "filename:mysize", "%wx%h",
                "%[filename:mysize]"
            ],
            random: [
                "convert",
                "in.png",
                "-resize", getRandomResize(frame),
                "-set", "filename:mysize", "%wx%h",
                "%[filename:mysize]"
            ],
        }[mode];

        const result = await Magick.Call(
            [{ name: "in.png", content: inputFrame }],
            args
        );

        if (!result || !result.length || !result[0].buffer) {
            throw new Error(`ImageMagick did not return processed frame ${frame}.`);
        }

        const geometry = String(result[0].name || "").match(/(\d+)x(\d+)/);
        if (!geometry) {
            throw new Error(`ImageMagick returned an invalid size for frame ${frame}.`);
        }

        const width = Number(geometry[1]);
        const height = Number(geometry[2]);

        if (width < 1 || height < 1) {
            throw new Error(`Frame ${frame} produced an empty image.`);
        }

        const normalizedGeometry = `${width}x${height}`;
        ffmpeg.FS("writeFile", frameName, result[0].buffer);

        if (lastGeometry !== null && lastGeometry !== normalizedGeometry) {
            addLog(`Geometry changed: ${lastGeometry} → ${normalizedGeometry}; closing segment ${segmentIndex}`);
            if (await makeWebmPart(frameNames, segmentIndex)) {
                segmentIndex++;

                // Recycle immediately after a complete group. At this point
                // there are no unencoded frames from the previous segment.
                if (segmentIndex % 10 === 0) {
                    await recycleFFmpeg(segmentIndex, inputName);
                }
            }
            frameNames = [];
        }

        frameNames.push(frameName);
        lastGeometry = normalizedGeometry;

        setProgress(10 + Math.floor((frame / framesTotal) * 80));
    }

    if (await makeWebmPart(frameNames, segmentIndex)) {
        segmentIndex++;
    }

    finishStep(`Apply ${mode.toUpperCase()} effect to frames`);
    addLog(`Generated ${segmentIndex} WebM video segments.`);
    
    if (!segmentIndex) {
        throw new Error("No WebM segments were generated.");
    }

    setProgress(90);
    setStatus("Joining resizing WebM segments…");
    await joinWebmSegments(segmentIndex);

    setProgress(95);
    setStatus("Preserving source audio…");
    const final = await muxAudio(inputName);

    setProgress(100);
    setStatus("Done. Downloading your WeirdM…");
    addLog(`SUCCESS: output ${outputName} is ready for download.`, "SUCCESS");
    addLog("========== WeirdM processing finished successfully ==========");

    const downloadData = new Uint8Array(final);
    const blob = new Blob([downloadData], { type: "video/webm" });
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
        addLog(`Active step: ${activeStep || "(none)"}`, "ERROR");
        addLog(error, "ERROR");
        if (lastFfmpegOutput.trim()) {
            addLog(`Latest FFmpeg output:\n${lastFfmpegOutput.trim()}`, "ERROR");
        }

        if (cancelRequested) {
            setProgress(-1);
            setStatus("Processing cancelled.");
        } else {
            const message = error instanceof Error ? error.message : String(error);
            setProgress(-1);
            setStatus(message, true);
            alert("Processing failed. Please try another video.\n\n" + message);
        }
    } finally {
        try {
            const inputName = file ? `input.${getInputExtension(file)}` : null;
            if (ffmpeg && inputName) cleanupWorkspace(inputName);
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
