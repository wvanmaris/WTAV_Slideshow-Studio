// assets.js — load images and pre-render the expensive, static pieces:
//   * each slide's blurred/dimmed background bitmap ("slide-blur" mode)
//   * one shared randomized montage backdrop ("montage" mode)
// These are computed once (not per frame), so per-frame rendering stays cheap.

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Load an image from a filesystem path or an object URL.
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image: ' + src));
    // Local absolute paths (from the file dialog / drag-drop) -> file:// URL.
    if (/^[a-zA-Z]:[\\/]/.test(src) || src.startsWith('/')) {
      const norm = src.replace(/\\/g, '/');
      img.src = 'file://' + (norm.startsWith('/') ? '' : '/') + norm;
    } else {
      img.src = src; // already a URL (blob:, file://, data:)
    }
  });
}

function drawCover(ctx, img, cw, ch) {
  const scale = Math.max(cw / img.width, ch / img.height);
  const dw = img.width * scale, dh = img.height * scale;
  ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
}

// Blurred + dimmed version of a single image, sized to the canvas.
export function makeSlideBackground(img, project) {
  const cw = project.canvas.w, ch = project.canvas.h;
  const bg = project.background || {};
  // Blur is a 0–50% amount; map it to pixels (scaled with resolution).
  const blurPx = ((bg.blur ?? 22) / 100) * 130 * (cw / 1280);
  const dim = bg.dim ?? 0.5;

  const c = makeCanvas(cw, ch);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cw, ch);
  // Slight over-scale so the blur doesn't reveal soft edges.
  ctx.filter = `blur(${blurPx}px)`;
  const scale = Math.max(cw / img.width, ch / img.height) * 1.15;
  const dw = img.width * scale, dh = img.height * scale;
  ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  ctx.filter = 'none';
  // Dim overlay so the sharp foreground reads clearly on top.
  ctx.fillStyle = `rgba(0,0,0,${dim})`;
  ctx.fillRect(0, 0, cw, ch);
  return c;
}

// One randomized, blurred, dimmed collage of ALL images — the "composition of
// all pictures" backdrop. Deterministic given the same images + seed.
export function makeMontage(images, project, seed = 12345) {
  const cw = project.canvas.w, ch = project.canvas.h;
  const bg = project.background || {};
  const blurPx = ((bg.blur ?? 22) / 100) * 130 * (cw / 1280) * 1.5; // montage blurs harder
  const dim = bg.dim ?? 0.5;

  // Simple seeded PRNG (mulberry32-ish) for repeatable placement.
  let a = seed >>> 0;
  const rnd = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const c = makeCanvas(cw, ch);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, cw, ch);

  const pool = images.filter(Boolean);
  if (pool.length) {
    const cols = Math.min(5, Math.max(3, Math.round(Math.sqrt(pool.length))));
    const rows = Math.ceil(pool.length / cols) || 1;
    const cells = cols * rows;
    const tileW = cw / cols, tileH = ch / rows;

    // Assign photos to cells via a seeded shuffle, so a new seed genuinely
    // rearranges WHICH photo goes WHERE (not just tiny jitter). Fill/repeat to
    // cover every cell, then shuffle the whole assignment.
    const assign = [];
    for (let i = 0; i < cells; i++) assign.push(pool[i % pool.length]);
    for (let i = assign.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = assign[i]; assign[i] = assign[j]; assign[j] = t;
    }

    let k = 0;
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        const img = assign[k++];
        // Large jitter + rotation + scale spread so it reads as a real collage.
        const cx = tileW * (col + 0.5) + (rnd() - 0.5) * tileW * 0.85;
        const cy = tileH * (r + 0.5) + (rnd() - 0.5) * tileH * 0.85;
        const cover = Math.max(tileW / img.width, tileH / img.height);
        const s = cover * (1.15 + rnd() * 0.7);
        const dw = img.width * s, dh = img.height * s;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((rnd() - 0.5) * 0.9); // up to ~26deg tilt
        ctx.globalAlpha = 0.9;
        ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
        ctx.restore();
      }
    }
  }

  // Blur the whole collage in one pass, then dim it.
  const blurred = makeCanvas(cw, ch);
  const bctx = blurred.getContext('2d');
  bctx.filter = `blur(${blurPx}px)`;
  bctx.drawImage(c, 0, 0);
  bctx.filter = 'none';
  bctx.fillStyle = `rgba(0,0,0,${dim})`;
  bctx.fillRect(0, 0, cw, ch);
  return blurred;
}

// Prepare everything for the current project + list of image sources.
// Returns assets[] aligned with project.slides and sets project._montage.
export async function prepareAssets(project, sources, onProgress) {
  const assets = [];
  const imgs = [];
  for (let i = 0; i < sources.length; i++) {
    const img = await loadImage(sources[i]);
    imgs.push(img);
    assets.push({ img, bg: null });
    if (onProgress) onProgress(i + 1, sources.length);
  }
  // Per-slide blurred backgrounds.
  for (let i = 0; i < assets.length; i++) {
    assets[i].bg = makeSlideBackground(assets[i].img, project);
  }
  // Shared montage backdrop.
  project._montage = imgs.length ? makeMontage(imgs, project) : null;
  return assets;
}

// Recompute just the backgrounds (cheap-ish) when blur/dim/canvas changes.
export function rebuildBackgrounds(project, assets) {
  for (const a of assets) {
    if (a && a.img) a.bg = makeSlideBackground(a.img, project);
  }
  project._montage = assets.length ? makeMontage(assets.map(a => a.img), project) : null;
}
