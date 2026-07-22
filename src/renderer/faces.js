// faces.js — on-device face detection via face-api.js (TinyFaceDetector).
// EVERYTHING runs locally in this process. No image, and no derived data, ever
// leaves the machine — essential for the sensitive photos this app handles.
//
// face-api.js is loaded as a classic <script> in index.html, exposing the
// global `window.faceapi` (it bundles its own TensorFlow.js, WebGL backend).

let _ready = null;

export function faceApiAvailable() {
  return !!(window.faceapi && window.faceapi.nets && window.faceapi.nets.tinyFaceDetector);
}

// Load the model weights once (from the bundled vendor/models folder) and warm
// up the WebGL kernels. The first inference after load can intermittently
// return no results before kernels are compiled, so we run one throwaway
// detection here and discard it — real scans are then reliable.
export function initFaceDetector(modelUri = 'vendor/models') {
  if (!faceApiAvailable()) return Promise.reject(new Error('face-api.js not loaded'));
  if (!_ready) {
    _ready = (async () => {
      const faceapi = window.faceapi;
      await faceapi.nets.tinyFaceDetector.loadFromUri(modelUri);
      try {
        const c = document.createElement('canvas');
        c.width = 320; c.height = 320;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, 320, 320);
        await faceapi.detectAllFaces(c, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 }));
      } catch (_) { /* warmup best-effort */ }
    })();
  }
  return _ready;
}

// Detect faces in an already-loaded HTMLImageElement.
// Returns normalised boxes: [{ x, y, w, h, score }] in 0..1 image coordinates.
// inputSize must be a multiple of 32; larger = more accurate but slower.
//
// IMPORTANT: TinyFaceDetector misses faces on very high-resolution photos
// (verified: 0 hits on a 3250x4333 image, reliable hits once downscaled). We
// therefore detect on a copy capped at `maxDim` px. Boxes are normalised, so
// they map straight back onto the full-resolution image unchanged.
export async function detectFaces(img, { inputSize = 416, scoreThreshold = 0.35, maxDim = 1024 } = {}) {
  if (!faceApiAvailable()) return [];
  await initFaceDetector();
  const faceapi = window.faceapi;

  const W = img.naturalWidth || img.width;
  const H = img.naturalHeight || img.height;
  const scale = Math.min(1, maxDim / Math.max(W, H));
  let target = img;
  if (scale < 1) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(W * scale));
    cv.height = Math.max(1, Math.round(H * scale));
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    target = cv;
  }

  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold });
  const results = await faceapi.detectAllFaces(target, opts);
  const tw = target.width, th = target.height;
  return results.map((r) => {
    const b = r.box;
    return {
      x: clamp01(b.x / tw),
      y: clamp01(b.y / th),
      w: clamp01(b.width / tw),
      h: clamp01(b.height / th),
      score: r.score,
    };
  });
}

function clamp01(v) { return Math.min(1, Math.max(0, v)); }
