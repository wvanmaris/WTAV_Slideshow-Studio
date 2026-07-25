// faces.js — on-device face detection via face-api.js (SSD MobileNet v1).
// EVERYTHING runs locally in this process. No image, and no derived data, ever
// leaves the machine — essential for the sensitive photos this app handles.
//
// face-api.js is loaded as a classic <script> in index.html, exposing the
// global `window.faceapi` (it bundles its own TensorFlow.js, WebGL backend).
//
// We use SSD MobileNet v1, NOT the lighter TinyFaceDetector: measured on a hard
// group photo (~29 old B&W faces) Tiny found 0 at every setting, while SSD at
// ~1280px / minConfidence 0.3 found ~29. Detection runs once on import, so the
// extra cost (a few hundred ms per photo) is fine.

let _ready = null;
const MIN_CONFIDENCE = 0.3; // recall-biased: a missed face is worse than a stray box
const MAX_DIM = 1280;       // detect on a copy capped here — the SSD sweet spot

export function faceApiAvailable() {
  return !!(window.faceapi && window.faceapi.nets && window.faceapi.nets.ssdMobilenetv1);
}

// Load the model weights once (from the bundled vendor/models folder) and warm
// up the WebGL kernels — the first inference after load can intermittently
// return nothing before kernels are compiled, so we run one throwaway detection.
export function initFaceDetector(modelUri = 'vendor/models') {
  if (!faceApiAvailable()) return Promise.reject(new Error('face-api.js not loaded'));
  if (!_ready) {
    _ready = (async () => {
      const faceapi = window.faceapi;
      await faceapi.nets.ssdMobilenetv1.loadFromUri(modelUri);
      try {
        const c = document.createElement('canvas');
        c.width = 320; c.height = 320;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, 320, 320);
        await faceapi.detectAllFaces(c, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }));
      } catch (_) { /* warmup best-effort */ }
    })();
  }
  return _ready;
}

// Detect faces in an already-loaded HTMLImageElement.
// Returns normalised boxes: [{ x, y, w, h, score }] in 0..1 image coordinates.
//
// We detect on a copy capped at `maxDim` px: full resolution is slow and, oddly,
// not the most accurate; ~1280 px is the measured sweet spot for recall. Boxes
// are normalised, so they map straight back onto the full-resolution image.
export async function detectFaces(img, { minConfidence = MIN_CONFIDENCE, maxDim = MAX_DIM } = {}) {
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

  const opts = new faceapi.SsdMobilenetv1Options({ minConfidence });
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
