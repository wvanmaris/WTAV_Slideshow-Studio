// render.js — the single source of truth for how a frame looks.
// Used BOTH by the live preview and by the full-resolution export, so the
// exported video is pixel-for-pixel what the operator previewed.
//
// Ken Burns is expressed as a "source rectangle" (a crop of the image, in the
// canvas aspect ratio) that animates from a start rect to an end rect and is
// scaled up to fill the canvas. This formulation makes it easy to guarantee a
// protected region (detected faces) stays fully inside the frame at all times,
// and to fall back to a sweeping pan when a group is too wide to contain.

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Deterministic tiny PRNG from a string/number seed (mulberry32).
function seededRandom(seed) {
  const str = String(seed);
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
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

const PAN_K = 0.72; // how far across the available slack a directional pan travels

// ---------------------------------------------------------------------------
// Timeline — place every slide on a circular timeline so the last slide
// crossfades back into the first, making the exported file loop seamlessly.
// ---------------------------------------------------------------------------
export function buildTimeline(project) {
  // Collage is a distinct ambient mode (multiple photos at once); it loops over
  // one period and ignores the crossfade timeline / titles.
  const sch = buildCollageSchedule(project);
  if (sch) return { items: [], collage: sch, cycle: sch.L, totalDuration: sch.L, loop: project.loop !== false };

  const d = project.defaults;
  const protectGlobal = project.protectFaces !== false;
  const timing = project.timing || {};
  const tc = project.titleCard || {};

  // Ordered sources: an optional title card, the photos, an optional end card.
  const sources = [];
  if (tc.atStart) sources.push({ type: 'title' });
  project.slides.forEach((s, i) => sources.push({ type: 'photo', slide: s, slideIndex: i }));
  if (tc.atEnd) sources.push({ type: 'title' });
  const n = sources.length;

  const items = sources.map((src, i) => {
    if (src.type === 'title') {
      return {
        index: -1, type: 'title',
        durationSec: Math.max(1, tc.durationSec ?? 5),
        transitionAfter: d.transitionSec,
        kbSetting: { enabled: false }, seed: 'title' + i, faces: [], protect: false,
        _rk: null, _rects: null,
      };
    }
    const s = src.slide;
    // In 'total' mode, unlocked photos use the auto-computed duration so the
    // whole show fits a fixed length (or the music). A manual duration locks it.
    const autoDur = timing.mode === 'total' ? (timing._autoDur ?? d.durationSec) : d.durationSec;
    const durationSec = s.durationSec ?? autoDur;
    const transitionAfter = s.transitionSec ?? d.transitionSec;
    const kbSetting = s.kenBurns ? { ...d.kenBurns, ...s.kenBurns } : d.kenBurns;
    const faces = s.faces || [];
    return {
      index: src.slideIndex, type: 'photo',
      id: s.id,
      durationSec,
      transitionAfter,
      kbSetting,
      seed: s.id ?? src.slideIndex,
      faces,
      protect: protectGlobal && s.protect !== false && faces.length > 0,
      _rk: null, _rects: null,
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

  let t = 0;
  for (let i = 0; i < n; i++) {
    items[i].start = t;
    t += items[i].durationSec - items[i].transitionAfter;
  }
  const cycle = t;

  for (let i = 0; i < n; i++) {
    const prev = items[(i - 1 + n) % n];
    items[i].fadeIn = n > 1 ? prev.transitionAfter : 0;
  }

  const loop = project.loop !== false;
  const last = items[n - 1];
  const totalDuration = n === 0 ? 0 : loop ? cycle : last.start + last.durationSec;

  return { items, cycle, totalDuration, loop };
}

// ---------------------------------------------------------------------------
// Ken Burns rect maths
// ---------------------------------------------------------------------------
// Largest rect of the canvas aspect that fits inside the image ("zoom 1").
function coverRect(iw, ih, A) {
  return iw / ih > A ? { w: ih * A, h: ih } : { w: iw, h: iw / A };
}

// Aspect ratio of the foreground "photo frame" from its shape setting.
function frameAspect(shape, cw, ch) {
  switch (shape) {
    case 'fill': return cw / ch;   // fill the whole canvas (old behaviour)
    case '4:3': return 4 / 3;
    case '3:2': return 3 / 2;
    case '1:1': return 1;
    case '16:9':
    default: return 16 / 9;
  }
}

// The rectangle (in canvas px) where the sharp photo is drawn. The blurred
// background always fills the whole canvas; this frame floats on top. On a
// wide/odd canvas the frame stays ~16:9 so faces are easy to keep in view.
// With shape 'original', the frame matches the photo's own aspect ratio
// (imageAspect) so it shows whole — e.g. a portrait leaves side background.
export function computeFrame(project, imageAspect) {
  const cw = project.canvas.w, ch = project.canvas.h;
  const fg = project.foreground || {};
  const aspect = (fg.shape === 'original' && imageAspect)
    ? imageAspect
    : frameAspect(fg.shape || '16:9', cw, ch);
  const scale = clamp(fg.scale ?? 1, 0.3, 1);

  // Largest `aspect` box that fits the canvas (contain), then scaled down.
  let fw, fh;
  if (cw / ch > aspect) { fh = ch; fw = ch * aspect; } else { fw = cw; fh = cw / aspect; }
  fw = Math.min(fw * scale, cw);
  fh = Math.min(fh * scale, ch);

  const align = fg.align || 'center';
  const margin = Math.min(ch * 0.04, Math.max(0, cw - fw));
  let x;
  if (align === 'left') x = margin;
  else if (align === 'right') x = cw - fw - margin;
  else x = (cw - fw) / 2;
  const y = (ch - fh) / 2;
  return { x, y, w: fw, h: fh };
}

// Union of face boxes -> a rect in image pixels (the HARD "must stay visible"
// region — the actual faces, no generous padding).
function unionFaces(faces, iw, ih) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const f of faces) {
    x0 = Math.min(x0, f.x); y0 = Math.min(y0, f.y);
    x1 = Math.max(x1, f.x + f.w); y1 = Math.max(y1, f.y + f.h);
  }
  return { x: x0 * iw, y: y0 * ih, w: (x1 - x0) * iw, h: (y1 - y0) * ih };
}

// Preferred framing: faces plus a little breathing room (more above the heads).
function padRegion(box, iw, ih) {
  const padX = box.w * 0.15, padTop = box.h * 0.32, padBot = box.h * 0.12;
  const x0 = clamp(box.x - padX, 0, iw), y0 = clamp(box.y - padTop, 0, ih);
  const x1 = clamp(box.x + box.w + padX, 0, iw), y1 = clamp(box.y + box.h + padBot, 0, ih);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Contain `region` and gently zoom toward it (zoom only as far as the region
// still fits; otherwise a static, centred hold — never clips the region).
function containAndZoom(cover, region, iw, ih, zoom, enabled) {
  const zFit = Math.min(cover.w / Math.max(region.w, 1), cover.h / Math.max(region.h, 1));
  let zEnd = enabled ? Math.min(1 + zoom, Math.max(1, zFit) * 0.97) : 1;
  zEnd = Math.max(1, zEnd);
  return {
    start: { ...centerContainingP(cover, 1, region, iw, ih), z: 1 },
    end: { ...centerContainingP(cover, zEnd, region, iw, ih), z: zEnd },
  };
}

// Centre (normalised) for a rect of the given zoom that contains P if possible,
// otherwise the image-clamped centre nearest P's centre.
function centerContainingP(cover, z, P, iw, ih) {
  const rw = cover.w / z, rh = cover.h / z;
  const loX = Math.max(P.x + P.w - rw / 2, rw / 2), hiX = Math.min(P.x + rw / 2, iw - rw / 2);
  const loY = Math.max(P.y + P.h - rh / 2, rh / 2), hiY = Math.min(P.y + rh / 2, ih - rh / 2);
  const midX = P.x + P.w / 2, midY = P.y + P.h / 2;
  const cx = loX <= hiX ? clamp(midX, loX, hiX) : clamp(midX, rw / 2, iw - rw / 2);
  const cy = loY <= hiY ? clamp(midY, loY, hiY) : clamp(midY, rh / 2, ih - rh / 2);
  return { x: cx / iw, y: cy / ih };
}

function directionalRects(cover, iw, ih, zoom, seed, direction) {
  let dir = direction || 'auto';
  if (dir === 'auto' || dir === 'random') {
    const rnd = seededRandom('kb' + seed);
    const pool = ['in', 'out', 'left', 'right', 'up', 'down'];
    dir = pool[Math.floor(rnd() * pool.length)];
  }
  const C = { x: 0.5, y: 0.5 };
  if (dir === 'in') return { start: { ...C, z: 1 }, end: { ...C, z: 1 + zoom } };
  if (dir === 'out') return { start: { ...C, z: 1 + zoom }, end: { ...C, z: 1 } };

  const zc = 1 + Math.max(zoom, 0.1); // pans need slack to move within
  if (dir === 'left' || dir === 'right') {
    const halfNorm = (cover.w / zc / 2) / iw;
    const loX = lerp(0.5, halfNorm, PAN_K), hiX = lerp(0.5, 1 - halfNorm, PAN_K);
    return dir === 'right'
      ? { start: { x: loX, y: 0.5, z: zc }, end: { x: hiX, y: 0.5, z: zc } }
      : { start: { x: hiX, y: 0.5, z: zc }, end: { x: loX, y: 0.5, z: zc } };
  }
  // up / down
  const halfNorm = (cover.h / zc / 2) / ih;
  const loY = lerp(0.5, halfNorm, PAN_K), hiY = lerp(0.5, 1 - halfNorm, PAN_K);
  return dir === 'down'
    ? { start: { x: 0.5, y: loY, z: zc }, end: { x: 0.5, y: hiY, z: zc } }
    : { start: { x: 0.5, y: hiY, z: zc }, end: { x: 0.5, y: loY, z: zc } };
}

function computeRects(iw, ih, cw, ch, item) {
  const A = cw / ch;
  const cover = coverRect(iw, ih, A);
  const kb = item.kbSetting;
  const zoom = clamp(kb.zoom ?? 0.12, 0, 0.6);
  const enabled = kb.enabled !== false;
  const faces = item.faces || [];

  if (item.protect && faces.length) {
    const faceBox = unionFaces(faces, iw, ih);

    // Genuine wide group: the faces span wider than the widest possible crop,
    // so they cannot all be shown at once -> slow horizontal sweep across them.
    // (Vertical overflow, e.g. a portrait face in a 16:9 frame, is NEVER swept
    //  — that would pan across a single face; we centre on it instead.)
    if (faceBox.w > cover.w + 0.5) {
      const halfW = cover.w / 2;
      const sx = clamp(faceBox.x + halfW, halfW, iw - halfW);
      const ex = clamp(faceBox.x + faceBox.w - halfW, halfW, iw - halfW);
      const cy = clamp(faceBox.y + faceBox.h / 2, cover.h / 2, ih - cover.h / 2);
      const a = { x: sx / iw, y: cy / ih, z: 1 }, b = { x: ex / iw, y: cy / ih, z: 1 };
      return seededRandom('sw' + item.seed)() < 0.5 ? { start: b, end: a } : { start: a, end: b };
    }

    // Otherwise: frame with breathing room if it fits, else on the faces
    // themselves. containAndZoom guarantees the region is never clipped.
    const padded = padRegion(faceBox, iw, ih);
    const region = (padded.w <= cover.w && padded.h <= cover.h) ? padded : faceBox;
    return containAndZoom(cover, region, iw, ih, zoom, enabled);
  }

  if (!enabled) return { start: { x: 0.5, y: 0.5, z: 1 }, end: { x: 0.5, y: 0.5, z: 1 } };
  return directionalRects(cover, iw, ih, zoom, item.seed, kb.direction);
}

function getRects(item, iw, ih, cw, ch) {
  const kb = item.kbSetting;
  const key = `${iw}x${ih}@${cw}x${ch}:${item.protect ? 1 : 0}:${kb.enabled !== false ? 1 : 0}:${kb.zoom}:${kb.direction}:${item.faces.length}`;
  if (item._rk !== key) { item._rects = computeRects(iw, ih, cw, ch, item); item._rk = key; }
  return item._rects;
}

// Source rect (image px) currently visible for a slide, for a target of the
// given size (the photo frame). Used for drawing and for the face overlay.
export function getSourceRect(item, img, targetW, targetH, u) {
  const iw = img.width, ih = img.height;
  const A = targetW / targetH;
  const cover = coverRect(iw, ih, A);
  const r = getRects(item, iw, ih, targetW, targetH);
  const z = lerp(r.start.z, r.end.z, u);
  const rw = cover.w / z, rh = cover.h / z;
  let cx = lerp(r.start.x, r.end.x, u) * iw;
  let cy = lerp(r.start.y, r.end.y, u) * ih;
  cx = clamp(cx, rw / 2, iw - rw / 2);
  cy = clamp(cy, rh / 2, ih - rh / 2);
  return { sx: cx - rw / 2, sy: cy - rh / 2, sw: rw, sh: rh };
}

// ---------------------------------------------------------------------------
// Backgrounds
// ---------------------------------------------------------------------------
function drawBackground(ctx, project, asset, cw, ch) {
  const bg = project.background || {};
  if (bg.mode === 'color') {
    ctx.fillStyle = bg.color || '#000000';
    ctx.fillRect(0, 0, cw, ch);
    return;
  }
  const bmp = bg.mode === 'montage' ? project._montage : asset && asset.bg;
  if (bmp) ctx.drawImage(bmp, 0, 0, cw, ch);
  else { ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, cw, ch); }
}

// Draw a title card: background + up to 4 centred lines of text.
function drawTitle(ctx, project, cw, ch) {
  const tc = project.titleCard || {};
  const bg = tc.bg || {};
  if (bg.mode === 'montage' && project._montage) {
    ctx.drawImage(project._montage, 0, 0, cw, ch);
  } else {
    ctx.fillStyle = bg.color || '#0d0d10';
    ctx.fillRect(0, 0, cw, ch);
  }
  const lines = (tc.lines || []).filter((l) => l && (l.text || '').trim().length);
  if (!lines.length) return;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const spacing = tc.lineSpacing ?? 1.3;
  const sized = lines.map((l) => ({
    text: l.text,
    font: l.font || 'Playfair Display',
    size: (l.sizePct ?? 7) / 100 * ch,
  }));
  const slotHeights = sized.map((s) => s.size * spacing);
  const totalH = slotHeights.reduce((a, b) => a + b, 0);
  let y = ch / 2 - totalH / 2;

  ctx.fillStyle = tc.textColor || '#f2ece0';
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = ch * 0.008;
  for (let i = 0; i < sized.length; i++) {
    y += slotHeights[i] / 2;
    ctx.font = `${Math.round(sized[i].size)}px "${sized[i].font}", serif`;
    ctx.fillText(sized[i].text, cw / 2, y);
    y += slotHeights[i] / 2;
  }
  ctx.shadowBlur = 0;
}

// Where the photo is drawn inside its frame — inset by the decorative border.
export function photoInnerRect(project, F) {
  const b = project.photoBorder;
  if (!b || b.style === 'none') return { x: F.x, y: F.y, w: F.w, h: F.h, bpx: 0 };
  const bpx = Math.max(2, Math.min(F.w, F.h) * (b.widthPct ?? 3) / 100);
  return { x: F.x + bpx, y: F.y + bpx, w: F.w - 2 * bpx, h: F.h - 2 * bpx, bpx };
}

// Draw a decorative picture frame filling F; the photo is drawn on top, inset.
function drawFrameFill(ctx, style, F, bpx) {
  const { x, y, w, h } = F;
  const inset = (k) => ctx.strokeRect(x + bpx * k, y + bpx * k, w - 2 * bpx * k, h - 2 * bpx * k);
  if (style === 'white' || style === 'mat') {
    ctx.fillStyle = style === 'mat' ? '#f2ede2' : '#ffffff';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = Math.max(1, bpx * 0.06); inset(0.9);
  } else if (style === 'black') {
    ctx.fillStyle = '#141414'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = Math.max(1, bpx * 0.08); inset(0.9);
  } else if (style === 'wood') {
    const g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, '#6b4a2b'); g.addColorStop(0.5, '#8a5f38'); g.addColorStop(1, '#553a20');
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = Math.max(1, bpx * 0.08); inset(0.88);
  } else if (style === 'gold') {
    ctx.fillStyle = '#3a2e12'; ctx.fillRect(x, y, w, h);
    const g = ctx.createLinearGradient(x, y, x + bpx, y + bpx);
    g.addColorStop(0, '#a9791a'); g.addColorStop(0.4, '#e8c25a'); g.addColorStop(0.6, '#f6e39a'); g.addColorStop(1, '#a9791a');
    ctx.fillStyle = g; ctx.fillRect(x + bpx * 0.18, y + bpx * 0.18, w - 0.36 * bpx, h - 0.36 * bpx);
    ctx.fillStyle = '#2c220e'; ctx.fillRect(x + bpx * 0.82, y + bpx * 0.82, w - 1.64 * bpx, h - 1.64 * bpx);
  }
}

// Exposed for the settings-panel live preview of the title card.
export function renderTitleCard(ctx, project, cw, ch) {
  ctx.clearRect(0, 0, cw, ch);
  drawTitle(ctx, project, cw, ch);
}

function drawSlideLayer(layerCtx, project, item, asset, localU, cw, ch) {
  layerCtx.clearRect(0, 0, cw, ch);
  layerCtx.fillStyle = '#000000';
  layerCtx.fillRect(0, 0, cw, ch);
  if (item.type === 'title') { drawTitle(layerCtx, project, cw, ch); return; }
  drawBackground(layerCtx, project, asset, cw, ch); // background fills the canvas
  if (asset && asset.img) {
    // Frame is per-slide: 'original' shape uses this photo's aspect ratio.
    const F = computeFrame(project, asset.img.width / asset.img.height);
    const border = project.photoBorder || { style: 'none' };
    const hasBorder = border.style && border.style !== 'none';
    const framed = hasBorder || F.w < cw - 1 || F.h < ch - 1;
    if (framed) {
      // Soft shadow so the photo/frame lifts off the background.
      layerCtx.save();
      layerCtx.shadowColor = 'rgba(0,0,0,0.55)';
      layerCtx.shadowBlur = Math.max(8, F.h * 0.035);
      layerCtx.shadowOffsetY = Math.max(2, F.h * 0.012);
      layerCtx.fillStyle = '#000';
      layerCtx.fillRect(F.x, F.y, F.w, F.h);
      layerCtx.restore();
    }
    const inner = photoInnerRect(project, F);
    if (hasBorder) drawFrameFill(layerCtx, border.style, F, inner.bpx);
    // Ken Burns uses the inner (photo) rect's aspect, drawn into it.
    const r = getSourceRect(item, asset.img, inner.w, inner.h, localU);
    layerCtx.drawImage(asset.img, r.sx, r.sy, r.sw, r.sh, inner.x, inner.y, inner.w, inner.h);
  }
}

// ---------------------------------------------------------------------------
// Multi-photo modes — several photos on the canvas at once.
//
//   'grid' — Collage: N non-overlapping cells; each cell shows one photo and
//            swaps to the next one ("one at a time" or "all together").
//   'wall' — Photo wall: photos are pasted at random spots on top of each
//            other; the wall keeps filling up and new photos cover old ones.
//
// Both are driven by a deterministic schedule (buildCollageSchedule) that is
// periodic over L seconds, so a looped export closes seamlessly. Randomness
// only jitters WHEN swaps happen (never the cycle length), so the loop is
// still exact. The schedule is built once per rebuild() and carried in the
// timeline object; rendering just looks up "what is on screen at t".
// ---------------------------------------------------------------------------
const COLLAGE_DEFAULTS = {
  mode: 'off', count: 3, swap: 'one', intervalSec: 5, randomness: 0,
  wallDepth: 20, wallSizePct: 30,
};

export function normalizeCollage(c) {
  const src = c || {};
  // Legacy (<= v0.3.x): {enabled, maxConcurrent, photoSec}
  if (src.mode === undefined && src.enabled !== undefined) {
    return {
      ...COLLAGE_DEFAULTS,
      mode: src.enabled ? 'grid' : 'off',
      count: clamp(src.maxConcurrent ?? 3, 2, 7),
      intervalSec: src.photoSec ?? 5,
    };
  }
  const out = { ...COLLAGE_DEFAULTS, ...src };
  if (!['off', 'grid', 'wall'].includes(out.mode)) out.mode = 'off';
  out.count = clamp(Math.round(out.count) || 3, 2, 7);
  out.swap = out.swap === 'all' ? 'all' : 'one';
  out.intervalSec = clamp(+out.intervalSec || 5, 1, 30);
  out.randomness = clamp(+out.randomness || 0, 0, 100);
  out.wallDepth = clamp(Math.round(out.wallDepth) || 20, 4, 60);
  out.wallSizePct = clamp(Math.round(out.wallSizePct) || 30, 10, 70);
  return out;
}

// Seeded Fisher-Yates over 0..n-1.
function seededOrder(n, rnd) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Split N cells over rows so every row is (nearly) full and cells are as close
// to a pleasant landscape aspect as possible. Returns [{x,y,w,h}] in px.
function gridCells(N, cw, ch) {
  let best = null;
  for (let rows = 1; rows <= N; rows++) {
    const cols = Math.ceil(N / rows);
    if (cols * (rows - 1) >= N) continue; // last row would be empty
    const aspect = (cw / cols) / (ch / rows);
    const score = Math.abs(Math.log(aspect / 1.25));
    if (!best || score < best.score) best = { rows, cols, score };
  }
  const { rows } = best;
  // Distribute N over rows as evenly as possible, fuller rows first.
  const per = []; let left = N;
  for (let r = 0; r < rows; r++) { const n = Math.ceil(left / (rows - r)); per.push(n); left -= n; }
  const cells = [];
  const rh = ch / rows;
  const cwid = cw / Math.max(...per);
  per.forEach((n, r) => {
    const x0 = (cw - n * cwid) / 2; // centre short rows
    for (let i = 0; i < n; i++) cells.push({ x: x0 + i * cwid, y: r * rh, w: cwid, h: rh });
  });
  return cells;
}

export function buildCollageSchedule(project) {
  const c = normalizeCollage(project.collage);
  const nPhotos = project.slides.length;
  if (c.mode === 'off' || !nPhotos) return null;
  const cw = project.canvas.w, ch = project.canvas.h;
  const seedBase = 'mp' + (project.montageSeed ?? 0) + ':';
  const order = seededOrder(nPhotos, seededRandom(seedBase + 'seq'));
  const interval = c.intervalSec;
  const jit = (c.randomness / 100) * 0.45 * interval; // < interval/2 keeps events strictly ordered
  const jitter = (r) => (r() - 0.5) * 2 * jit;

  if (c.mode === 'grid') {
    const N = Math.min(c.count, nPhotos);
    const slots = Array.from({ length: N }, () => []); // per slot: [{t, photo, key}]
    let L;
    if (c.swap === 'all') {
      // Rounds of N photos; the last round is padded by repeating photos from
      // the start of the order (a photo only lives one round, so a repeat can
      // never be on screen twice at once).
      const R = Math.ceil(nPhotos / N);
      L = R * interval;
      for (let r = 0; r < R; r++) {
        const t = r * interval + jitter(seededRandom(seedBase + 'ga' + r));
        for (let k = 0; k < N; k++) { const j = r * N + k; slots[k].push({ t, photo: order[j % nPhotos], key: j }); }
      }
    } else {
      // One swap per interval, every photo exactly once per cycle (so a photo
      // is never on screen twice). Slots are visited round-robin in a seeded
      // order, so each photo lives N intervals; the loop closes because a
      // slot's state before its first swap is its last swap of the cycle.
      L = nPhotos * interval;
      const visit = seededOrder(N, seededRandom(seedBase + 'so'));
      for (let j = 0; j < nPhotos; j++) {
        const t = j * interval + jitter(seededRandom(seedBase + 'g1' + j));
        slots[visit[j % N]].push({ t, photo: order[j], key: j });
      }
    }
    for (const s of slots) s.sort((a, b) => a.t - b.t);
    const fadeDur = Math.min(1.2, interval * 0.35);
    return { mode: 'grid', L, N, fadeDur, slots, cells: gridCells(N, cw, ch) };
  }

  // 'wall'
  const L = nPhotos * interval;
  const pastes = [];
  for (let j = 0; j < nPhotos; j++) {
    const r = seededRandom(seedBase + 'w' + j);
    const t = j * interval + jitter(r);
    pastes.push({ t, photo: order[j], key: j, rx: r(), ry: r(), rot: (r() - 0.5) * 0.28, sz: 0.85 + r() * 0.3 });
  }
  pastes.sort((a, b) => a.t - b.t);
  return { mode: 'wall', L, pastes, depth: c.wallDepth, sizePct: c.wallSizePct, fadeDur: Math.min(0.6, interval * 0.3) };
}

// Draw one framed photo (shadow, optional decorative border, cover-cropped
// image) centred at (cx,cy) with size w x h and rotation rot, at alpha.
function drawPastedPhoto(ctx, project, img, cx, cy, w, h, rot, alpha) {
  const border = project.photoBorder || { style: 'none' };
  const hasB = border.style && border.style !== 'none';
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  const F = { x: -w / 2, y: -h / 2, w, h };
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = h * 0.06; ctx.shadowOffsetY = h * 0.02;
  ctx.fillStyle = '#000'; ctx.fillRect(F.x, F.y, F.w, F.h);
  ctx.restore();
  const inner = hasB ? photoInnerRect(project, F) : { x: F.x, y: F.y, w: F.w, h: F.h, bpx: 0 };
  if (hasB) drawFrameFill(ctx, border.style, F, inner.bpx);
  const scale = Math.max(inner.w / img.width, inner.h / img.height);
  const dw = img.width * scale, dh = img.height * scale;
  ctx.save();
  ctx.beginPath(); ctx.rect(inner.x, inner.y, inner.w, inner.h); ctx.clip();
  ctx.drawImage(img, inner.x + (inner.w - dw) / 2, inner.y + (inner.h - dh) / 2, dw, dh);
  ctx.restore();
  ctx.restore();
}

// Photo rect inside a grid cell: keeps the photo's own aspect (clamped), takes
// 84-98 % of the cell, sits at a seeded spot inside the cell, slight tilt.
function cellPhotoRect(cell, img, rnd) {
  const gap = Math.min(cell.w, cell.h) * 0.07;
  const iw = cell.w - 2 * gap, ih = cell.h - 2 * gap;
  const ar = clamp(img.width / img.height, 0.65, 1.8);
  let w = iw, h = w / ar;
  if (h > ih) { h = ih; w = h * ar; }
  const s = 0.84 + rnd() * 0.14;
  w *= s; h *= s;
  const cx = cell.x + gap + w / 2 + rnd() * (iw - w);
  const cy = cell.y + gap + h / 2 + rnd() * (ih - h);
  const rot = (rnd() - 0.5) * 0.10;
  return { cx, cy, w, h, rot };
}

function drawCollageBackground(ctx, project) {
  const cw = project.canvas.w, ch = project.canvas.h;
  const bg = project.background || {};
  if (bg.mode === 'montage' && project._montage) ctx.drawImage(project._montage, 0, 0, cw, ch);
  else { ctx.fillStyle = bg.color || '#0b0b0e'; ctx.fillRect(0, 0, cw, ch); }
}

function drawGrid(ctx, project, assets, sch, tSec) {
  const { L, fadeDur, slots, cells } = sch;
  const t = ((tSec % L) + L) % L;
  slots.forEach((events, k) => {
    if (!events.length) return;
    // Current = last event with t <= now (wrapping to the last event of the
    // previous cycle); previous = the one before it.
    let ci = -1;
    for (let i = 0; i < events.length; i++) if (events[i].t <= t) ci = i;
    const wrapped = ci < 0;
    const curIdx = wrapped ? events.length - 1 : ci;
    const cur = events[curIdx];
    const prev = events[(curIdx - 1 + events.length) % events.length];
    const since = wrapped ? t + (L - cur.t) : t - cur.t;
    const a = fadeDur > 0 ? clamp(since / fadeDur, 0, 1) : 1;
    const cell = cells[k];
    const draw = (ev, alpha) => {
      const asset = assets[ev.photo];
      if (!asset || !asset.img || alpha <= 0.005) return;
      const r = cellPhotoRect(cell, asset.img, seededRandom('cell' + k + '-' + ev.key));
      drawPastedPhoto(ctx, project, asset.img, r.cx, r.cy, r.w, r.h, r.rot, alpha);
    };
    if (a < 1 && prev !== cur) draw(prev, 1 - a);
    draw(cur, a);
  });
}

function drawWall(ctx, project, assets, sch, tSec, loop) {
  const cw = project.canvas.w, ch = project.canvas.h;
  const { L, pastes, depth, sizePct, fadeDur } = sch;
  const n = pastes.length;
  const t = loop ? ((tSec % L) + L) % L : clamp(tSec, 0, L);
  // Index of the newest paste with t <= now.
  let newest = -1;
  for (let i = 0; i < n; i++) if (pastes[i].t <= t) newest = i;
  if (newest < 0 && !loop) return; // wall starts empty in one-shot mode
  // Layers, oldest -> newest. In a loop the wall is already full: pastes from
  // the previous cycle sit underneath. One extra layer is kept so the oldest
  // can fade out instead of popping off.
  const layers = [];
  const keep = Math.min(depth + 1, n);
  for (let m = keep - 1; m >= 0; m--) {
    let i = newest - m;
    let age;
    if (i < 0) { if (!loop) continue; i += n; age = t + (L - pastes[i].t); }
    else age = t - pastes[i].t;
    layers.push({ p: pastes[i], age, rank: m });
  }
  const baseH = ch * (sizePct / 100);
  const newestAge = newest >= 0 ? t - pastes[newest].t : t + (L - pastes[n - 1].t);
  for (const { p, age, rank } of layers) {
    const asset = assets[p.photo];
    if (!asset || !asset.img) continue;
    const img = asset.img;
    // New paste: quick fade-in plus a small "slap-on" settle.
    const u = clamp(age / Math.max(0.01, fadeDur), 0, 1);
    const settle = 1 + (1 - u) * 0.07;
    let alpha = u;
    // The layer that just dropped below the kept depth fades out while the
    // newest one fades in, so it never pops.
    if (rank === depth) alpha = Math.min(alpha, 1 - clamp(newestAge / Math.max(0.01, fadeDur), 0, 1));
    const ar = clamp(img.width / img.height, 0.6, 1.8);
    const h = baseH * p.sz * settle, w = h * ar;
    // Keep the whole photo inside the canvas (small safe margin), so nothing
    // is cut off at the edges; oversize photos just sit centred.
    const pad = Math.min(cw, ch) * 0.025;
    const cx = w >= cw - 2 * pad ? cw / 2 : pad + w / 2 + p.rx * (cw - w - 2 * pad);
    const cy = h >= ch - 2 * pad ? ch / 2 : pad + h / 2 + p.ry * (ch - h - 2 * pad);
    drawPastedPhoto(ctx, project, img, cx, cy, w, h, p.rot, alpha);
  }
}

function drawCollage(ctx, project, timeline, assets, tSec) {
  const sch = timeline.collage;
  drawCollageBackground(ctx, project);
  if (!sch) return;
  if (sch.mode === 'grid') drawGrid(ctx, project, assets, sch, tSec);
  else if (sch.mode === 'wall') drawWall(ctx, project, assets, sch, tSec, !!timeline.loop);
  ctx.globalAlpha = 1;
}

// Fade in from / out to black (one-shot only; a loop must not flash black).
function applyEndFades(ctx, project, timeline, tSec) {
  if (timeline.loop || !project.fade) return;
  const cw = project.canvas.w, ch = project.canvas.h;
  const total = timeline.totalDuration;
  const fin = project.fade.inSec || 0;
  const fout = project.fade.endMode === 'fadeout' ? (project.fade.outSec || 0) : 0;
  let env = 1;
  if (fin > 0) env = Math.min(env, clamp(tSec / fin, 0, 1));
  if (fout > 0) env = Math.min(env, clamp((total - tSec) / fout, 0, 1));
  if (env < 1) {
    ctx.fillStyle = `rgba(0,0,0,${(1 - env).toFixed(4)})`;
    ctx.fillRect(0, 0, cw, ch);
  }
}

// ---------------------------------------------------------------------------
// The one function everything calls.
// ---------------------------------------------------------------------------
export function renderFrame(ctx, project, timeline, assets, tSec, scratch) {
  const cw = project.canvas.w, ch = project.canvas.h;
  const { items, cycle } = timeline;

  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, cw, ch);

  if (timeline.collage) { drawCollage(ctx, project, timeline, assets, tSec); applyEndFades(ctx, project, timeline, tSec); return; }
  if (!items.length) return;

  // Loop: wrap time into the cycle. One-shot: clamp to the real duration
  // (don't modulo by `cycle`, which is shorter than totalDuration).
  let t = timeline.loop
    ? (cycle > 0 ? ((tSec % cycle) + cycle) % cycle : 0)
    : clamp(tSec, 0, timeline.totalDuration);

  const ops = [];
  const offsets = timeline.loop ? [-cycle, 0, cycle] : [0];
  for (const off of offsets) {
    for (const item of items) {
      const s = item.start + off;
      if (t >= s && t < s + item.durationSec) {
        const localU = item.durationSec > 0 ? (t - s) / item.durationSec : 0;
        const alpha = item.fadeIn > 0 ? clamp((t - s) / item.fadeIn, 0, 1) : 1;
        ops.push({ item, startAbs: s, localU, alpha });
      }
    }
  }
  ops.sort((a, b) => a.startAbs - b.startAbs);

  let layerCanvas, layerCtx;
  if (scratch && scratch.canvas) { layerCanvas = scratch.canvas; layerCtx = scratch.ctx; }
  else {
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

  applyEndFades(ctx, project, timeline, tSec);
}

// Which slide is featured (most opaque) at time t — for the preview overlay.
export function featuredAt(timeline, tSec) {
  const { items, cycle } = timeline;
  if (!items.length) return null;
  let t = cycle > 0 ? ((tSec % cycle) + cycle) % cycle : 0;
  let best = null, bestAlpha = -1;
  const offsets = timeline.loop ? [-cycle, 0, cycle] : [0];
  for (const off of offsets) {
    for (const item of items) {
      const s = item.start + off;
      if (t >= s && t < s + item.durationSec) {
        const alpha = item.fadeIn > 0 ? clamp((t - s) / item.fadeIn, 0, 1) : 1;
        if (alpha > bestAlpha) { bestAlpha = alpha; best = { item, localU: item.durationSec > 0 ? (t - s) / item.durationSec : 0 }; }
      }
    }
  }
  return best;
}
