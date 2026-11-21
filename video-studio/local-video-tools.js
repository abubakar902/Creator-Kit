/* TrivexaAI Video Studio — free local video tools.
 * MediaPipe Tasks Vision: Apache-2.0. RNNoise WASM: Apache-2.0.
 * FFmpeg.wasm wrapper: MIT; FFmpeg core follows its upstream FFmpeg build license.
 * User media is processed in this browser tab; no media is uploaded to an AI API.
 */

const MP_VISION_VERSION = "1.2.3";
const MP_VISION_BUNDLE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@" + MP_VISION_VERSION + "/vision_bundle.mjs";
const MP_WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@" + MP_VISION_VERSION + "/wasm";
const PERSON_MODEL = "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite";
const OBJECT_MODEL = "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite";
const FFMPEG_SCRIPT = "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.js";
// The FFmpeg class worker is an ES module, so it must import the ESM core (default factory export), not the UMD build.
const FFMPEG_CORE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";

let visionPromise = null;
let segmenterPromise = null;
let detectorPromise = null;
let imageSegmenter = null;
let objectDetector = null;
let segmentationTimestamp = 0;
let rnnoisePromise = null;
let ffmpegPromise = null;
let ffmpegInstance = null;
const personFrameCache = new Map();

function byId(id) {
  return document.getElementById(id);
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}
function checkCancelled(token) {
  if (token && token.cancelled) {
    const error = new Error("You cancelled this tool. Your original media is safe.");
    error.name = "AbortError";
    throw error;
  }
}
function readableToolError(error) {
  let message = "";
  if (typeof error === "string") message = error;
  else if (error && typeof error.message === "string") message = error.message;
  else if (error !== undefined && error !== null) {
    try { message = String(error); } catch (ignored) {}
  }
  message = String(message || "").trim();
  if (!message || message === "[object Object]") {
    return "This local tool could not finish. Please try again.";
  }
  // FFmpeg worker errors can arrive as strings instead of Error objects.
  return message.replace(/^Error:\s*/i, "").slice(0, 420);
}
function waitForPaint() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}
function appendScript(src, ready) {
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let script = [...document.scripts].find(item => item.src === src);
    if (!script) {
      script = document.createElement("script");
      script.src = src;
      script.async = true;
      document.head.append(script);
    }
    const fail = message => {
      if (script && script.parentNode) script.parentNode.removeChild(script);
      reject(new Error(message));
    };
    const finish = () => ready() ? resolve() : fail("The local processing library did not load correctly.");
    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", () => fail("Could not download a free processing library. Check your internet connection and try again."), { once: true });
    if (ready()) resolve();
  });
}
async function loadVision() {
  if (!visionPromise) {
    visionPromise = (async () => {
      const visionModule = await import(MP_VISION_BUNDLE);
      const fileset = await visionModule.FilesetResolver.forVisionTasks(MP_WASM_ROOT);
      return { ...visionModule, fileset };
    })().catch(error => {
      visionPromise = null;
      throw error;
    });
  }
  return visionPromise;
}
async function ensureObjectDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const vision = await loadVision();
      objectDetector = await vision.ObjectDetector.createFromOptions(vision.fileset, {
        baseOptions: { modelAssetPath: OBJECT_MODEL },
        runningMode: "IMAGE",
        scoreThreshold: 0.32,
        maxResults: 8
      });
      return objectDetector;
    })().catch(error => {
      detectorPromise = null;
      objectDetector = null;
      throw error;
    });
  }
  return detectorPromise;
}
async function ensurePersonSegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const vision = await loadVision();
      imageSegmenter = await vision.ImageSegmenter.createFromOptions(vision.fileset, {
        baseOptions: { modelAssetPath: PERSON_MODEL },
        runningMode: "VIDEO",
        outputCategoryMask: true,
        outputConfidenceMasks: true
      });
      return imageSegmenter;
    })().catch(error => {
      segmenterPromise = null;
      imageSegmenter = null;
      throw error;
    });
  }
  return segmenterPromise;
}
function personMaskCanvas(result) {
  const labels = imageSegmenter && typeof imageSegmenter.getLabels === "function" ? imageSegmenter.getLabels() : [];
  const personIndex = Array.isArray(labels) ? labels.findIndex(label => String(label).toLowerCase() === "person") : -1;
  const masks = result && Array.isArray(result.confidenceMasks) ? result.confidenceMasks : [];
  const confidence = masks.length
    ? (masks[personIndex >= 0 ? personIndex : (masks.length > 1 ? 1 : 0)] || masks[0])
    : null;
  const category = result && result.categoryMask;
  const mask = confidence || category;
  if (!mask || typeof mask.getAsUint8Array !== "function" && typeof mask.getAsFloat32Array !== "function") {
    throw new Error("The person mask was not returned by the local model.");
  }
  const width = Number(mask.width) || 0;
  const height = Number(mask.height) || 0;
  if (!width || !height) throw new Error("The person mask has an invalid size.");
  const floats = confidence && typeof confidence.getAsFloat32Array === "function" ? confidence.getAsFloat32Array() : null;
  const bytes = floats ? null : (category || mask).getAsUint8Array();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not prepare the person mask.");
  const image = context.createImageData(width, height);
  const total = width * height;
  for (let i = 0; i < total; i++) {
    let alpha;
    if (floats) alpha = clamp((Number(floats[i]) - 0.2) / 0.58, 0, 1);
    else alpha = bytes[i] > 0 ? 1 : 0;
    const offset = i * 4;
    image.data[offset] = 255;
    image.data[offset + 1] = 255;
    image.data[offset + 2] = 255;
    image.data[offset + 3] = Math.round(alpha * 255);
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

/* Called by the editor preview and its normal export renderer. Reuses a low
 * resolution mask between inference passes to keep older PCs responsive. */
export function renderPersonCutoutFrame(source, cacheKey) {
  if (!imageSegmenter || !source || source.readyState !== undefined && source.readyState < 2) return null;
  const sourceWidth = source.videoWidth || source.naturalWidth || source.width;
  const sourceHeight = source.videoHeight || source.naturalHeight || source.height;
  if (!sourceWidth || !sourceHeight) return null;
  const sourceIdentity = String(source.currentSrc || source.src || (source.videoWidth || source.naturalWidth || source.width) + "x" + (source.videoHeight || source.naturalHeight || source.height));
  const key = String(cacheKey || "person-cutout") + "|" + sourceIdentity;
  let entry = personFrameCache.get(key);
  if (entry) {
    personFrameCache.delete(key);
    personFrameCache.set(key, entry);
  } else {
    entry = { canvas: document.createElement("canvas"), mask: null, lastInference: 0, lastVideoTime: -1 };
    personFrameCache.set(key, entry);
    // Keep only a few clip canvases alive on low-memory devices.
    while (personFrameCache.size > 4) {
      const oldestKey = personFrameCache.keys().next().value;
      personFrameCache.delete(oldestKey);
    }
  }
  const now = performance.now();
  const needsInference = !entry.mask || now - entry.lastInference >= 125 && Math.abs((Number(source.currentTime) || 0) - entry.lastVideoTime) >= 0.035;
  if (needsInference) {
    let copiedMask = null;
    segmentationTimestamp = Math.max(segmentationTimestamp + 34, Math.round(now));
    imageSegmenter.segmentForVideo(source, segmentationTimestamp, value => {
      // MediaPipe guarantees mask memory only for the callback lifetime.
      // Convert and copy pixels into our canvas before returning from it.
      copiedMask = personMaskCanvas(value);
    });
    if (copiedMask) {
      entry.mask = copiedMask;
      entry.lastInference = now;
      entry.lastVideoTime = Number(source.currentTime) || 0;
    }
  }
  if (!entry.mask) return null;
  const factor = Math.min(1, 640 / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * factor));
  const height = Math.max(1, Math.round(sourceHeight * factor));
  if (entry.canvas.width !== width || entry.canvas.height !== height) {
    entry.canvas.width = width;
    entry.canvas.height = height;
  }
  const context = entry.canvas.getContext("2d");
  if (!context) return null;
  context.clearRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);
  context.globalCompositeOperation = "destination-in";
  context.drawImage(entry.mask, 0, 0, width, height);
  context.globalCompositeOperation = "source-over";
  return entry.canvas;
}

function waitForVideo(video, url) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener("loadeddata", ready);
      video.removeEventListener("error", failed);
      if (error) reject(error); else resolve();
    };
    const ready = () => finish();
    const failed = () => finish(new Error("The selected video could not be opened for local analysis."));
    const timer = setTimeout(() => finish(new Error("Loading the selected video timed out. Try a smaller clip.")), 30000);
    video.addEventListener("loadeddata", ready, { once: true });
    video.addEventListener("error", failed, { once: true });
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    video.load();
    if (video.readyState >= 2) finish();
  });
}
function seekVideo(video, time) {
  const target = clamp(time, 0, Math.max(0, (Number(video.duration) || time) - 0.025));
  if (Math.abs((Number(video.currentTime) || 0) - target) < 0.025 && video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener("seeked", ready);
      video.removeEventListener("error", failed);
      if (error) reject(error); else resolve();
    };
    const ready = () => finish();
    const failed = () => finish(new Error("The browser could not seek to an analysis frame."));
    const timer = setTimeout(() => finish(new Error("Seeking took too long. Try a shorter clip.")), 8000);
    video.addEventListener("seeked", ready, { once: true });
    video.addEventListener("error", failed, { once: true });
    try { video.currentTime = target; } catch (error) { finish(error); }
  });
}
function detectionInfo(detection, width, height) {
  const box = detection && detection.boundingBox;
  if (!box || !width || !height) return null;
  const x = clamp(box.originX, 0, width);
  const y = clamp(box.originY, 0, height);
  const w = clamp(box.width, 0, width - x);
  const h = clamp(box.height, 0, height - y);
  if (w < 2 || h < 2) return null;
  const category = detection.categories && detection.categories[0] || {};
  return {
    x: (x + w / 2) / width,
    y: (y + h / 2) / height,
    width: w / width,
    height: h / height,
    area: (w / width) * (h / height),
    label: String(category.categoryName || category.displayName || "object").toLowerCase(),
    score: Number(category.score) || 0
  };
}
function chooseDetection(detections, width, height, target, previous) {
  let options = (detections || []).map(item => detectionInfo(item, width, height)).filter(Boolean);
  if (target === "person") options = options.filter(item => item.label === "person");
  if (!options.length) return null;
  if (!previous) return options.sort((a, b) => b.area * b.score - a.area * a.score)[0];
  return options.sort((a, b) => {
    const distanceA = Math.hypot(a.x - previous.x, a.y - previous.y);
    const distanceB = Math.hypot(b.x - previous.x, b.y - previous.y);
    const classPenaltyA = a.label === previous.label ? 0 : 0.25;
    const classPenaltyB = b.label === previous.label ? 0 : 0.25;
    return (distanceA + classPenaltyA - a.score * 0.08) - (distanceB + classPenaltyB - b.score * 0.08);
  })[0];
}
async function analyseClip(api, clip, mode, token) {
  if (!clip || clip.type !== "video") throw new Error("Select a video clip on the timeline first.");
  const asset = api.getAsset(clip.assetId);
  const url = api.getAssetUrl(clip.assetId);
  if (!asset || !url) throw new Error("The selected video's original file is unavailable.");
  if (clip.duration < 1.2) throw new Error("This clip is too short to track. Choose a clip at least 1.2 seconds long.");
  const target = mode === "reframe" ? "person" : (byId("motionTrackTarget")?.value || "person");
  const detector = await ensureObjectDetector();
  checkCancelled(token);
  const video = document.createElement("video");
  await waitForVideo(video, url);
  checkCancelled(token);
  const sampleCount = Math.min(36, Math.max(5, Math.ceil(clip.duration / 0.7) + 1));
  const points = [];
  let previous = null;
  let smoothX = 0.5, smoothY = 0.5, smoothScale = 1;
  try {
    for (let i = 0; i < sampleCount; i++) {
      checkCancelled(token);
      const local = clip.duration * i / (sampleCount - 1);
      const sourceTime = api.getClipSourceTime(clip, local);
      await seekVideo(video, sourceTime);
      checkCancelled(token);
      const detections = detector.detect(video).detections || [];
      const found = chooseDetection(detections, video.videoWidth, video.videoHeight, target, previous);
      if (found) {
        const amount = previous ? 0.62 : 1;
        smoothX = smoothX * (1 - amount) + found.x * amount;
        smoothY = smoothY * (1 - amount) + found.y * amount;
        smoothScale = smoothScale * (1 - amount) + clamp(0.62 / Math.max(0.15, found.height), 1, 2.2) * amount;
        previous = { ...found, x: smoothX, y: smoothY };
        const base = api.getAnimatedValues(clip, local);
        const x = clamp((0.5 - smoothX) * 100, -45, 45);
        const y = clamp((0.5 - smoothY) * 100, -45, 45);
        const scale = mode === "reframe" ? smoothScale : Math.max(1, Number(base.scale) || 1);
        points.push({ time: Number(local.toFixed(3)), values: { ...base, x, y, scale } });
      }
      if (i % 2 === 0) {
        api.setStatus((mode === "reframe" ? "Auto Reframe" : "Motion Tracking") + " · analysing " + Math.round((i + 1) / sampleCount * 100) + "%");
        await waitForPaint();
        checkCancelled(token);
      }
    }
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
  checkCancelled(token);
  if (points.length < 3) {
    throw new Error(target === "person"
      ? "No clear person was detected. Try Motion Tracking with 'Any object', or use a brighter clip with the person visible."
      : "No clear object was detected in enough frames. Try a brighter or shorter clip.");
  }
  if (points[0].time > 0) points.unshift({ time: 0, values: { ...api.getAnimatedValues(clip, 0), ...points[0].values } });
  if (points[points.length - 1].time < clip.duration) {
    points.push({ time: Number(clip.duration.toFixed(3)), values: { ...points[points.length - 1].values } });
  }
  return points;
}

async function loadFFmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      await appendScript(FFMPEG_SCRIPT, () => !!window.FFmpegWASM?.FFmpeg);
      const FFmpeg = window.FFmpegWASM.FFmpeg;
      const instance = new FFmpeg();
      const fetchBlobUrl = async (url, mime) => {
        const response = await fetch(url, { cache: "force-cache" });
        if (!response.ok) throw new Error("Could not download the free video codec file (" + response.status + ").");
        const blob = await response.blob();
        return URL.createObjectURL(new Blob([blob], { type: mime }));
      };
      const coreURL = await fetchBlobUrl(FFMPEG_CORE + "/ffmpeg-core.js", "text/javascript");
      const wasmURL = await fetchBlobUrl(FFMPEG_CORE + "/ffmpeg-core.wasm", "application/wasm");
      try {
        const classWorkerURL = new URL("./ffmpeg-worker-bootstrap.js", window.location.href).href;
        await instance.load({ coreURL, wasmURL, classWorkerURL });
      } catch (error) {
        URL.revokeObjectURL(coreURL);
        URL.revokeObjectURL(wasmURL);
        throw error;
      }
      // The worker has copied both files into its own runtime; release the
      // temporary main-thread object URLs on successful initialisation.
      URL.revokeObjectURL(coreURL);
      URL.revokeObjectURL(wasmURL);
      ffmpegInstance = instance;
      return instance;
    })().catch(error => {
      ffmpegPromise = null;
      ffmpegInstance = null;
      throw error;
    });
  }
  return ffmpegPromise;
}
function extensionForAsset(asset) {
  const match = String(asset && asset.name || "").match(/\.([a-z0-9]{2,5})$/i);
  if (match) return match[1].toLowerCase();
  const mime = String(asset && asset.mime || "");
  if (mime.includes("webm")) return "webm";
  if (mime.includes("quicktime")) return "mov";
  return "mp4";
}
async function reverseSelectedClip(api, token) {
  const clip = api.getSelectedClip();
  if (!clip || clip.type !== "video") throw new Error("Select a video clip on the timeline first.");
  const asset = api.getAsset(clip.assetId);
  if (!asset || !asset.blob) throw new Error("The original video file is unavailable.");
  const sourceDuration = api.getClipSourceElapsed(clip, clip.duration);
  if (sourceDuration > 30) throw new Error("For this free low-memory version on a 4 GB PC, first split the video so the selected clip is 30 seconds or shorter.");
  if (Number(asset.size || asset.blob.size) > 50 * 1024 * 1024) throw new Error("For this free low-memory version, use a source file smaller than 50 MB on this PC.");
  if (!sourceDuration || sourceDuration < 0.2) throw new Error("The selected clip has an invalid duration.");
  api.pause();
  const button = byId("reverseClipBtn");
  button.textContent = "Loading video engine…";
  api.setStatus("Downloading FFmpeg.wasm · first use is about 31 MB…");
  const ffmpeg = await loadFFmpeg();
  checkCancelled(token);
  const inputName = "trivexa-input." + extensionForAsset(asset);
  const logLines = [];
  const onLog = ({ message }) => { if (message) logLines.push(message); };
  const onProgress = ({ progress }) => {
    button.textContent = "Reversing " + clamp(Math.round(progress * 100), 0, 99) + "% · click to cancel";
    api.setStatus("Reversing selected clip locally… " + clamp(Math.round(progress * 100), 0, 99) + "%");
  };
  ffmpeg.on("log", onLog);
  ffmpeg.on("progress", onProgress);
  token.cancel = () => {
    try { ffmpeg.terminate(); } catch (error) {}
    ffmpegPromise = null;
    ffmpegInstance = null;
  };
  try {
    await ffmpeg.writeFile(inputName, new Uint8Array(await asset.blob.arrayBuffer()));
    const scanResult = await ffmpeg.exec(["-hide_banner", "-encoders"]);
    if (scanResult !== 0) {
      const scanDetails = logLines.slice(-5).join(" | ").slice(-260);
      throw new Error("The video engine could not inspect its available encoders." + (scanDetails ? " Details: " + scanDetails : ""));
    }
    const encoderText = logLines.join("\n");
    let videoCodec = "", outputName = "trivexa-reversed.mp4", mime = "video/mp4";
    let videoArgs = [];
    if (encoderText.includes("libx264")) {
      videoCodec = "libx264";
      videoArgs = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-threads", "1"];
    } else if (encoderText.includes("libvpx")) {
      videoCodec = "libvpx";
      outputName = "trivexa-reversed.webm";
      mime = "video/webm";
      videoArgs = ["-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "900k", "-threads", "1"];
    } else if (encoderText.includes("mpeg4")) {
      videoCodec = "mpeg4";
      videoArgs = ["-c:v", "mpeg4", "-q:v", "5", "-threads", "1"];
    } else {
      throw new Error("This browser's free FFmpeg build has no compatible video encoder. Try again on an updated Chrome or Edge browser.");
    }
    let audioArgs = [];
    if (videoCodec === "libvpx") {
      if (encoderText.includes("libopus")) audioArgs = ["-c:a", "libopus", "-b:a", "96k"];
      else if (encoderText.includes("libvorbis")) audioArgs = ["-c:a", "libvorbis", "-q:a", "4"];
      else audioArgs = ["-an"];
    } else if (encoderText.includes("aac")) {
      audioArgs = ["-c:a", "aac", "-b:a", "128k"];
    } else {
      audioArgs = ["-an"];
    }
    const audioFilterArgs = audioArgs[0] === "-an" ? [] : ["-af", "areverse"];
    checkCancelled(token);
    const result = await ffmpeg.exec([
      // Restrict the input range before applying reverse, so only the
      // selected timeline segment is buffered by FFmpeg's reverse filter.
      "-ss", String(Math.max(0, api.getClipSourceTime(clip, 0)).toFixed(3)),
      "-t", String(sourceDuration.toFixed(3)),
      "-i", inputName,
      "-map", "0:v:0",
      "-map", "0:a?",
      "-vf", "scale='min(720,iw)':-2,reverse",
      ...audioFilterArgs,
      ...videoArgs,
      ...audioArgs,
      ...(mime === "video/mp4" ? ["-movflags", "+faststart"] : []),
      outputName
    ]);
    if (result !== 0) {
      const diagnostic = logLines.slice(-8).join(" | ").replace(/\s+/g, " ").slice(-420);
      throw new Error("The free video engine could not reverse this file. " +
        (diagnostic ? "FFmpeg details: " + diagnostic : "Try a shorter MP4 clip."));
    }
    const output = await ffmpeg.readFile(outputName);
    if (!output || output.length < 1000) throw new Error("The reversed video file was empty. Try a shorter clip.");
    checkCancelled(token);
    const blob = new Blob([output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength)], { type: mime });
    const created = await api.addDerivedAsset(blob, (clip.name || asset.name || "Video") + " (Reversed)", "video", sourceDuration);
    api.replaceClipAsset(clip.id, created.id, sourceDuration, "Reversed");
    api.notify("Reverse Video complete. The original file is still in your Media Library.");
  } finally {
    try { ffmpeg.off("log", onLog); } catch (error) {}
    try { ffmpeg.off("progress", onProgress); } catch (error) {}
    if (ffmpegPromise) {
      try { await ffmpeg.deleteFile(inputName); } catch (error) {}
    }
    try { await ffmpeg.deleteFile("trivexa-reversed.mp4"); } catch (error) {}
    try { await ffmpeg.deleteFile("trivexa-reversed.webm"); } catch (error) {}
  }
}

function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return new Float32Array(input);
  const length = Math.max(1, Math.round(input.length * toRate / fromRate));
  const output = new Float32Array(length);
  const ratio = fromRate / toRate;
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const left = Math.min(input.length - 1, Math.floor(position));
    const right = Math.min(input.length - 1, left + 1);
    const mix = position - left;
    output[i] = (input[left] || 0) * (1 - mix) + (input[right] || 0) * mix;
  }
  return output;
}
function writeWav(channels, sampleRate) {
  const count = channels[0].length;
  const channelCount = channels.length;
  const buffer = new ArrayBuffer(44 + count * channelCount * 2);
  const view = new DataView(buffer);
  const writeText = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  writeText(0, "RIFF"); view.setUint32(4, 36 + count * channelCount * 2, true);
  writeText(8, "WAVE"); writeText(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true); view.setUint16(34, 16, true);
  writeText(36, "data"); view.setUint32(40, count * channelCount * 2, true);
  let offset = 44;
  for (let i = 0; i < count; i++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const value = clamp(channels[channel][i] / 32768, -1, 1);
      view.setInt16(offset, Math.round(value * 32767), true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}
async function loadRNNoise() {
  if (!rnnoisePromise) {
    rnnoisePromise = (async () => {
      // The upstream file is an ES module (it ends with "export default"),
      // so load it with import() rather than inserting it as a classic script.
      const packageRoot = "https://cdn.jsdelivr.net/npm/@jitsi/rnnoise-wasm@0.2.1/dist/";
      const imported = await import(packageRoot + "rnnoise.js");
      const factory = imported && imported.default;
      if (typeof factory !== "function") throw new Error("The free RNNoise WebAssembly module could not be loaded.");
      const module = await factory({
        locateFile: path => new URL(path, packageRoot).href
      });
      if (!module || !module._rnnoise_create || !module._rnnoise_process_frame || !module.HEAPF32) {
        throw new Error("The free RNNoise model could not initialise in this browser.");
      }
      // rnnoise_create(NULL) calls rnnoise_init internally for each state.
      return module;
    })().catch(error => {
      rnnoisePromise = null;
      throw error;
    });
  }
  return rnnoisePromise;
}
async function enhanceSelectedAudio(api, token) {
  const clip = api.getSelectedClip();
  if (!clip || clip.type !== "audio") throw new Error("Select an audio clip on the audio track first. For video sound, detach its audio and select that audio clip.");
  const asset = api.getAsset(clip.assetId);
  if (!asset || !asset.blob) throw new Error("The selected audio file is unavailable.");
  if (Number(asset.size || asset.blob.size) > 80 * 1024 * 1024) throw new Error("For this free low-memory version, choose an audio file smaller than 80 MB.");
  const sourceStart = api.getClipSourceTime(clip, 0);
  const sourceDuration = api.getClipSourceElapsed(clip, clip.duration);
  if (sourceDuration > 120 || Number(asset.duration) > 180) {
    throw new Error("For this free low-memory version, choose an audio source under 3 minutes and a selected section of 120 seconds or less.");
  }
  api.pause();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("Audio enhancement needs an updated Chrome or Edge browser.");
  const context = new AudioContextClass();
  let decoded;
  try {
    decoded = await context.decodeAudioData(await asset.blob.arrayBuffer());
  } finally {
    try { await context.close(); } catch (error) {}
  }
  checkCancelled(token);
  const sampleStart = Math.max(0, Math.floor(sourceStart * decoded.sampleRate));
  const sampleEnd = Math.min(decoded.length, Math.ceil((sourceStart + sourceDuration) * decoded.sampleRate));
  if (sampleEnd <= sampleStart) throw new Error("The selected audio range is outside the source file.");
  const channelCount = Math.max(1, Math.min(2, decoded.numberOfChannels));
  const module = await loadRNNoise();
  checkCancelled(token);
  const frameSize = 480;
  let inputPointer = 0, outputPointer = 0;
  const denoisedChannels = [];
  try {
    inputPointer = module._malloc(frameSize * 4);
    outputPointer = module._malloc(frameSize * 4);
    if (!inputPointer || !outputPointer) throw new Error("Not enough memory to start local audio enhancement.");
    const inputIndex = inputPointer >>> 2, outputIndex = outputPointer >>> 2;
    const frameBuffer = new Float32Array(frameSize);
    for (let channel = 0; channel < channelCount; channel++) {
      const original = decoded.getChannelData(channel).subarray(sampleStart, sampleEnd);
      const resampled = resampleLinear(original, decoded.sampleRate, 48000);
      const denoised = new Float32Array(resampled.length);
      const state = module._rnnoise_create(0);
      if (!state) throw new Error("RNNoise could not create a processing session.");
      try {
        const frameCount = Math.ceil(resampled.length / frameSize);
        for (let frame = 0; frame < frameCount; frame++) {
          checkCancelled(token);
          const from = frame * frameSize;
          frameBuffer.fill(0);
          const available = Math.min(frameSize, resampled.length - from);
          for (let i = 0; i < available; i++) frameBuffer[i] = resampled[from + i] * 32768;
          module.HEAPF32.set(frameBuffer, inputIndex);
          module._rnnoise_process_frame(state, outputPointer, inputPointer);
          // RNNoise has a 10 ms look-ahead: this frame's output belongs to
          // the previous input block. Drop the initial warm-up output.
          if (frame > 0) {
            const destination = (frame - 1) * frameSize;
            const copyLength = Math.min(frameSize, denoised.length - destination);
            if (copyLength > 0) denoised.set(module.HEAPF32.subarray(outputIndex, outputIndex + copyLength), destination);
          }
          if (channel === 0 && frame % 100 === 0) {
            byId("enhanceAudioBtn").textContent = "Cleaning " + Math.min(99, Math.round((from + available) / resampled.length * 100)) + "% · click to cancel";
            api.setStatus("RNNoise · cleaning audio locally… " + Math.min(99, Math.round((from + available) / resampled.length * 100)) + "%");
            await waitForPaint();
          }
        }
        // Flush the final delayed block so the output keeps the full duration.
        frameBuffer.fill(0);
        module.HEAPF32.set(frameBuffer, inputIndex);
        module._rnnoise_process_frame(state, outputPointer, inputPointer);
        const finalDestination = (frameCount - 1) * frameSize;
        const finalLength = Math.min(frameSize, denoised.length - finalDestination);
        if (finalLength > 0) denoised.set(module.HEAPF32.subarray(outputIndex, outputIndex + finalLength), finalDestination);
      } finally {
        module._rnnoise_destroy(state);
      }
      denoisedChannels.push(denoised);
    }
  } finally {
    if (inputPointer) module._free(inputPointer);
    if (outputPointer) module._free(outputPointer);
  }
  checkCancelled(token);
  const processedDuration = (sampleEnd - sampleStart) / decoded.sampleRate;
  const created = await api.addDerivedAsset(writeWav(denoisedChannels, 48000), (clip.name || asset.name || "Audio") + " (Noise Reduced)", "audio", processedDuration);
  api.replaceAudioWithEnhanced(clip.id, created.id, sourceDuration, "Noise Reduced");
  api.notify("Audio enhancement complete. A noise-reduced copy was added; your original audio stays safe.");
}

export function createLocalVideoTools(api) {
  const busy = new Map();
  const run = async (id, workingText, action) => {
    const button = byId(id);
    if (!button) return;
    const active = busy.get(id);
    if (active) {
      active.cancelled = true;
      if (typeof active.cancel === "function") active.cancel();
      button.disabled = true;
      button.textContent = "Cancelling…";
      return;
    }
    const token = { cancelled: false, cancel: null };
    const oldText = button.textContent, oldTitle = button.title;
    busy.set(id, token);
    button.disabled = false;
    button.title = "Click again to cancel this task";
    button.textContent = workingText + " · click to cancel";
    try {
      await action(token);
      checkCancelled(token);
    } catch (error) {
      if (token.cancelled || error && error.name === "AbortError") api.notify("Cancelled. Your original media and project are safe.");
      else api.notify(readableToolError(error));
      api.setStatus("Ready · Auto-save on");
    } finally {
      busy.delete(id);
      button.disabled = false;
      button.title = oldTitle;
      const selected = api.getSelectedClip();
      button.textContent = id === "removeVideoBgBtn" && selected && selected.bgRemoveEnabled ? "✓ Person BG On" : (id === "removeVideoBgBtn" ? "✂ Remove Person BG" : oldText);
    }
  };
  return {
    bind() {
      byId("reverseClipBtn")?.addEventListener("click", () => run("reverseClipBtn", "Preparing…", token => reverseSelectedClip(api, token)));
      byId("motionTrackBtn")?.addEventListener("click", () => run("motionTrackBtn", "Tracking…", async token => {
        const clip = api.getSelectedClip();
        const points = await analyseClip(api, clip, "track", token);
        api.applyClipKeyframes(clip.id, points, {});
        api.notify("Motion tracking complete. The selected clip now follows the detected subject.");
      }));
      byId("autoReframeBtn")?.addEventListener("click", () => run("autoReframeBtn", "Reframing…", async token => {
        const clip = api.getSelectedClip();
        const points = await analyseClip(api, clip, "reframe", token);
        api.applyClipKeyframes(clip.id, points, { framingMode: "fill" });
        api.notify("Auto Reframe complete. The person is now kept near the centre of the frame.");
      }));
      byId("removeVideoBgBtn")?.addEventListener("click", () => run("removeVideoBgBtn", "Loading person model…", async token => {
        const clip = api.getSelectedClip();
        if (!clip || clip.type !== "video") throw new Error("Select a video clip on the timeline first.");
        if (clip.bgRemoveEnabled) {
          api.setClipBackgroundRemoval(clip.id, false);
          api.notify("Person background removal is off for this clip.");
          return;
        }
        api.pause();
        await ensurePersonSegmenter();
        checkCancelled(token);
        api.setClipBackgroundRemoval(clip.id, true);
        api.notify("Person background removal is on. The model runs locally; use a short clip for smoother export.");
      }));
      byId("enhanceAudioBtn")?.addEventListener("click", () => run("enhanceAudioBtn", "Loading RNNoise…", token => enhanceSelectedAudio(api, token)));
    },
    prepareBackgroundRemoval: ensurePersonSegmenter,
    hasBackgroundRemovalModel: () => !!imageSegmenter
  };
}
