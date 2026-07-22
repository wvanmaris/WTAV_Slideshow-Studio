// render.js — the single source of truth for how a frame looks.
// Used BOTH by the live preview and by the full-resolution export, so the
// exported video is pixel-for-pixel what the operator previewed.
//
// This module is pure: give it a context, a project, prepared assets and a
// time in seconds, and it draws exactly one frame. No DOM, no timers, no
// randomness at render time (all randomness is resolved up front into the
// timeline, so preview and export stay identical).

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Deterministic tiny PRNG from a string/number seed (mulberry32).
function seededRandom(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (let i = 0; i < String(seed).length; i++) {
    h = Math.imul(h ^ String(seed).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Ken Burns resolution — turn a human setting (direction + zoom) into explicit
// from/to zoom + pan numbers, deterministically, so it never changes between
// preview and export.
// ---------------------------------------------------------------------------
const PAN_K = 0.72; // how far across the available slack a pan travels

function resolveKenBurns(kb, seed) {
  const enabled = kb.enabled !== false;
  if (!enabled) {
    return { fromZoom: 1, toZoom: 1, fromPanX: 0, fromPanY: 0, toPanX: 0, toPanY: 0 };
  }
  let zoom = clamp(kb.zoom ?? 0.12, 0, 0.6);
  let dir = kb.direction || 'auto';

  if (dir === 'auto' || dir === 'random') {
    const rnd = seededRandom('kb' + seed);
    const pool = ['in', 'out', 'left', 'right', 'up', 'down'];
    dir = pool[Math.floor(rnd() * pool.length)];
  }

  // Pans need horizontal/vertical slack to move within, so guarantee a minimum
  // zoom when a directional pan is requested.
  const panZoom = Math.max(zoom, 0.1);

  switch (dir) {
    case 'in':
      return { fromZoom: 1, toZoom: 1 + zoom, fromPanX: 0, fromPanY: 0, toPanX: 0, toPanY: 0 };
    case 'out':
      return { fromZoom: 1 + zoom, toZoom: 1, fromPanX: 0, fromPanY: 0, toPanX: 0, toPanY: 0 };
    case 'left':
      return { fromZoom: 1 + panZoom, toZoom: 1 + panZoom, fromPanX: PAN_K, fromPanY: 0, toPanX: -PAN_K, toPanY: 0 };
    case 'right':
      return { fromZoom: 1 + panZoom, toZoom: 1 + panZoom, fromPanX: -PAN_K, fromPanY: 0, toPanX: PAN_K, toPanY: 0 };
    case 'up':
      return { fromZoom: 1 + panZoom, toZoom: 1 + panZoom, fromPanX: 0, fromPanY: PAN_K, toPanX: 0, toPanY: -PAN_K };
    case 'down':
      return { fromZoom: 1 + panZoom, toZoom: 1 + panZoom, fromPanX: 0, fromPanY: -PAN_K, toPanX: 0, toPanY: PAN_K };
    default:
      return { fromZoom: 1, toZoom: 1 + zoom, fromPanX: 0, fromPanY: 0, toPanX: 0, toPanY: 0 };
  }
}

// ---------------------------------------------------------------------------
// Timeline — place every slide on a circular timeline so the last slide
// crossfades back into the first, making the exported file loop seamlessly.
// ---------------------------------------------------------------------------
export function buildTimeline(project) {
  const d = project.defaults;
  const n = project.slides.length;
  const items = project.slides.map((s, i) => {
    const durationSec = s.durationSec ?? d.durationSec;
    // transitionSec on a slide = the fade AFTER it (into the next slide).
    const transitionAfter = s.transitionSec ?? d.transitionSec;
    // Per-slide motion inherits the default zoom unless it overrides it.
    const kbSetting = s.kenBurns ? { ...d.kenBurns, ...s.kenBurns } : d.kenBurns;
    return {
      index: i,
      id: s.id,
      durationSec,
      transitionAfter,
      kb: resolveKenBurns(kbSetting, s.id ?? i),
    };
  });

  // Guard: a transition can't be longer than either neighbouring slide.
  // A lone slide has nothing to crossfade into, so it holds for its full time.
  for (let i = 0; i < n; i++) {
    if (n < 2) { items[i].transitionAfter = 0; continue; }
    const next = items[(i + 1) % n];
    items[i].transitionAfter = Math.min(
      items[i].transitionAfter,
      items[i].durationSec * 0.9,
      next.durationSec * 0.9
    );
  }

  // Start times: each slide starts (prevDuration - prevTransition) after the
  // previous one, so they overlap by exactly the transition length.
  let t = 0;
  for (let i = 0; i < n; i++) {
    items[i].start = t;
    t += items[i].durationSec - items[i].transitionAfter;
  }
  const cycle = t; // total loop length: sum(duration) - sum(transition)

  // Fade-in duration of slide i is the transition AFTER its predecessor
  // (wrapping so slide 0's fade-in is the last slide's transition).
  for (let i = 0; i < n; i++) {
    const prev = items[(i - 1 + n) % n];
    items[i].fadeIn = n > 1 ? prev.transitionAfter : 0;
  }

  const loop = project.loop !== false;
  // How long the exported/previewed clip runs. Looping renders exactly one
  // seamless cycle; one-shot runs until the last slide finishes.
  const last = items[n - 1];
  const totalDuration = n === 0 ? 0
    : loop ? cycle
    : last.start + last.durationSec;

  return { items, cycle, totalDuration, loop };
}

// ---------------------------------------------------------------------------
// Backgrounds and Ken Burns foreground
// ---------------------------------------------------------------------------
function drawBackground(ctx, project, asset, cw, ch) {
  const bg = project.background || {};
  if (bg.mode === 'color') {
    ctx.fillStyle = bg.color || '#000000';
    ctx.fillRect(0, 0, cw, ch);
    return;
  }
  // 'montage' uses one shared pre-rendered backdrop; 'slide-blur' uses this
  // slide's own pre-blurred bitmap. Both are prepared in assets.js.
  const bmp = bg.mode === 'montage' ? project._montage : asset.bg;
  if (bmp) {
    ctx.drawImage(bmp, 0, 0, cw, ch);
  } else {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, cw, ch);
  }
}

function drawKenBurns(ctx, img, cw, ch, u, kb) {
  const iw = img.width, ih = img.height;
  const scale0 = Math.max(cw / iw, ch / ih); // "cover" fit
  const z = lerp(kb.fromZoom, kb.toZoom, u);
  const scale = scale0 * z;
  const dw = iw * scale, dh = ih * scale;
  const panX = lerp(kb.fromPanX, kb.toPanX, u);
  const panY = lerp(kb.fromPanY, kb.toPanY, u);
  const x = (cw - dw) / 2 + panX * (dw - cw) / 2;
  const y = (ch - dh) / 2 + panY * (dh - ch) / 2;
  ctx.drawImage(img, x, y, dw, dh);
}

// A slide drawn fully opaque (background + moving foreground) onto a layer.
function drawSlideLayer(layerCtx, project, item, asset, localU, cw, ch) {
  layerCtx.clearRect(0, 0, cw, ch);
  layerCtx.fillStyle = '#000000';
  layerCtx.fillRect(0, 0, cw, ch);
  drawBackground(layerCtx, project, asset, cw, ch);
  if (asset && asset.img) {
    drawKenBurns(layerCtx, asset.img, cw, ch, localU, item.kb);
  }
}

// ---------------------------------------------------------------------------
// The one function everything calls.
//   ctx      : destination 2D context (preview canvas or export canvas)
//   project  : project model (see app.js)
//   timeline : result of buildTimeline()
//   assets   : array aligned with project.slides: { img, bg }
//   tSec     : time in seconds (wrapped into the loop automatically)
//   scratch  : { canvas, ctx } reusable offscreen layer at cw x ch (optional)
// ---------------------------------------------------------------------------
export function renderFrame(ctx, project, timeline, assets, tSec, scratch) {
  const cw = project.canvas.w, ch = project.canvas.h;
  const { items, cycle } = timeline;

  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, cw, ch);
  if (!items.length) return;

  // Normalise time into the loop.
  let t = cycle > 0 ? ((tSec % cycle) + cycle) % cycle : 0;

  // Collect the slides visible at time t. Because slides only overlap their
  // immediate neighbour, at most two are active. We test the wrapped copies
  // (-cycle / 0 / +cycle) so the last→first crossfade renders seamlessly.
  const ops = [];
  const offsets = timeline.loop ? [-cycle, 0, cycle] : [0];
  for (const off of offsets) {
    for (const item of items) {
      const s = item.start + off;
      if (t >= s && t < s + item.durationSec) {
        const localU = item.durationSec > 0 ? (t - s) / item.durationSec : 0;
        const alphaIn = item.fadeIn > 0 ? clamp((t - s) / item.fadeIn, 0, 1) : 1;
        ops.push({ item, startAbs: s, localU, alpha: alphaIn });
      }
    }
  }
  // Draw earlier-starting slides first; later ones fade in on top (cross dissolve).
  ops.sort((a, b) => a.startAbs - b.startAbs);

  // Reusable offscreen layer so each slide composites as one unit at its alpha.
  let layerCanvas, layerCtx;
  if (scratch && scratch.canvas) {
    layerCanvas = scratch.canvas; layerCtx = scratch.ctx;
  } else {
    layerCanvas = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(cw, ch)
      : Object.assign(document.createElement('canvas'), { width: cw, height: ch });
    layerCtx = layerCanvas.getContext('2d');
  }

  for (const op of ops) {
    const asset = assets[op.item.index];
    drawSlideLayer(layerCtx, project, op.item, asset, op.localU, cw, ch);
    ctx.globalAlpha = op.alpha;
    ctx.drawImage(layerCanvas, 0, 0, cw, ch);
  }
  ctx.globalAlpha = 1;
}

export { resolveKenBurns };
