/* Same-origin worker bootstrap for FFmpeg.wasm 0.12.15.
 * The browser worker is served from TrivexaAI's own GitHub Pages origin.
 * Its upstream implementation is imported as an ES module from jsDelivr.
 */
import "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/worker.js";
