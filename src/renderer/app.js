// app.js — UI state and wiring. Holds the project model, prepares assets,
// drives the preview Player, and runs exports.
import { buildTimeline } from './render.js';
import { loadImage, makeSlideBackground, makeMontage } from './assets.js';
import { Player } from './preview.js';
import { exportVideo } from './exporter.js';

// --- State -----------------------------------------------------------------
let uidCounter = 1;
const uid = () => 's' + (uidCounter++);

const project = {
  canvas: { w: 1280, h: 720 },
  fps: 30,
  loop: true,
  background: { mode: 'slide-blur', blur: 28, dim: 0.5, color: '#101014' },
  defaults: {
    durationSec: 7,
    transitionSec: 1,
    kenBurns: { enabled: true, zoom: 0.12, direction: 'auto' },
  },
  slides: [],
  _montage: null,
};

const assetMap = new Map(); // slide.id -> { img, bg }
let timeline = buildTimeline(project);
let selectedId = null;
let exporting = false;
let cancelRequested = false;

// --- Element refs ----------------------------------------------------------
const $ = (id) => document.getElementById(id);
const canvasEl = $('preview');

function srcToUrl(src) {
  if (/^[a-zA-Z]:[\\/]/.test(src) || src.startsWith('/')) {
    const norm = src.replace(/\\/g, '/');
    return 'file://' + (norm.startsWith('/') ? '' : '/') + norm;
  }
  return src;
}

// --- Derived / helpers -----------------------------------------------------
function assetsArray() {
  return project.slides.map((s) => assetMap.get(s.id));
}
function getState() {
  return { project, timeline, assets: assetsArray() };
}
function rebuild() {
  timeline = buildTimeline(project);
  player.resizeToProject();
  player.seek(Math.min(player.time, timeline.totalDuration || 0));
  updateTimeUI(player.time, timeline.totalDuration);
  updateCount();
}

const player = new Player(canvasEl, getState, (t, dur) => updateTimeUI(t, dur));

// --- Toast -----------------------------------------------------------------
let toastTimer = null;
function toast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), isErr ? 6000 : 3000);
}

// --- Photos ----------------------------------------------------------------
async function addSources(sources) {
  if (!sources.length) return;
  const added = [];
  for (const src of sources) {
    try {
      const img = await loadImage(src);
      const id = uid();
      const name = src.split(/[\\/]/).pop();
      const slide = { id, src, name };
      assetMap.set(id, { img, bg: makeSlideBackground(img, project) });
      project.slides.push(slide);
      added.push(slide);
    } catch (err) {
      console.error(err);
      toast('Skipped a file that could not be loaded: ' + src.split(/[\\/]/).pop(), true);
    }
  }
  rebuildMontage();
  refreshSlideList();
  rebuild();
  if (added.length && !selectedId) selectSlide(added[0].id);
  $('stageEmpty').classList.toggle('hidden', project.slides.length > 0);
}

function rebuildMontage() {
  const imgs = project.slides.map((s) => assetMap.get(s.id)?.img).filter(Boolean);
  project._montage = imgs.length ? makeMontage(imgs, project) : null;
}

function rebuildBackgrounds() {
  for (const s of project.slides) {
    const a = assetMap.get(s.id);
    if (a && a.img) a.bg = makeSlideBackground(a.img, project);
  }
  rebuildMontage();
  player.redraw();
}

function removeSlide(id) {
  const idx = project.slides.findIndex((s) => s.id === id);
  if (idx === -1) return;
  project.slides.splice(idx, 1);
  assetMap.delete(id);
  if (selectedId === id) selectSlide(project.slides[Math.min(idx, project.slides.length - 1)]?.id ?? null);
  rebuildMontage();
  refreshSlideList();
  rebuild();
  $('stageEmpty').classList.toggle('hidden', project.slides.length > 0);
}

function clearAll() {
  project.slides = [];
  assetMap.clear();
  project._montage = null;
  selectSlide(null);
  refreshSlideList();
  rebuild();
  $('stageEmpty').classList.remove('hidden');
}

// --- Slide list + drag reorder --------------------------------------------
let dragId = null;
function refreshSlideList() {
  const list = $('slideList');
  list.innerHTML = '';
  if (!project.slides.length) {
    list.innerHTML = '<li class="empty-hint">Add photos to begin.<br />Drag to reorder.</li>';
    return;
  }
  project.slides.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'slide-item' + (s.id === selectedId ? ' selected' : '');
    li.draggable = true;
    li.dataset.id = s.id;
    const dur = s.durationSec ?? project.defaults.durationSec;
    li.innerHTML = `
      <span class="num">${i + 1}</span>
      <img class="thumb" src="${srcToUrl(s.src)}" alt="" />
      <div class="meta">
        <div class="name">${s.name || 'photo'}</div>
        <div class="sub">${dur}s${s.kenBurns && s.kenBurns.enabled === false ? ' · no motion' : ''}</div>
      </div>`;
    li.addEventListener('click', () => selectSlide(s.id));
    li.addEventListener('dragstart', (e) => { dragId = s.id; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    li.addEventListener('dragend', () => { dragId = null; li.classList.remove('dragging'); clearDropMarkers(); });
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      const rect = li.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      clearDropMarkers();
      li.classList.add(after ? 'drop-after' : 'drop-before');
    });
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      const rect = li.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      reorder(dragId, s.id, after);
    });
    list.appendChild(li);
  });
}
function clearDropMarkers() {
  document.querySelectorAll('.slide-item').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
}
function reorder(fromId, toId, after) {
  if (!fromId || fromId === toId) return;
  const from = project.slides.findIndex((s) => s.id === fromId);
  const [moved] = project.slides.splice(from, 1);
  let to = project.slides.findIndex((s) => s.id === toId);
  if (after) to += 1;
  project.slides.splice(to, 0, moved);
  refreshSlideList();
  rebuild();
}

// --- Selection + per-slide settings ---------------------------------------
function selectSlide(id) {
  selectedId = id;
  const panel = $('slideSettings');
  if (!id) { panel.classList.add('hidden'); refreshSlideList(); return; }
  const s = project.slides.find((x) => x.id === id);
  if (!s) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  $('slideName').textContent = s.name ? '· ' + s.name : '';
  $('sDuration').value = s.durationSec ?? '';
  $('sTransition').value = s.transitionSec ?? '';
  $('sKbDirection').value = s.kenBurns
    ? (s.kenBurns.enabled === false ? 'off' : (s.kenBurns.direction || 'auto'))
    : '';
  refreshSlideList();
}

function currentSlide() { return project.slides.find((x) => x.id === selectedId); }

$('sDuration').addEventListener('input', (e) => {
  const s = currentSlide(); if (!s) return;
  s.durationSec = e.target.value === '' ? undefined : Math.max(0.5, parseFloat(e.target.value));
  rebuild(); refreshSlideList();
});
$('sTransition').addEventListener('input', (e) => {
  const s = currentSlide(); if (!s) return;
  s.transitionSec = e.target.value === '' ? undefined : Math.max(0, parseFloat(e.target.value));
  rebuild();
});
$('sKbDirection').addEventListener('change', (e) => {
  const s = currentSlide(); if (!s) return;
  const v = e.target.value;
  if (v === '') s.kenBurns = undefined;
  else if (v === 'off') s.kenBurns = { enabled: false };
  else s.kenBurns = { enabled: true, direction: v };
  rebuild(); refreshSlideList();
});
$('btnRemoveSlide').addEventListener('click', () => { if (selectedId) removeSlide(selectedId); });

// --- Global settings -------------------------------------------------------
function applyCanvasSize(w, h) {
  project.canvas.w = Math.max(16, Math.round(w / 2) * 2); // force even for yuv420p
  project.canvas.h = Math.max(16, Math.round(h / 2) * 2);
  rebuildBackgrounds();
  rebuild();
}
$('canvasPreset').addEventListener('change', (e) => {
  const v = e.target.value;
  const custom = $('customSize');
  if (v === 'custom') { custom.classList.remove('hidden'); return; }
  custom.classList.add('hidden');
  const [w, h] = v.split('x').map(Number);
  $('canvasW').value = w; $('canvasH').value = h;
  applyCanvasSize(w, h);
});
const onCustom = () => applyCanvasSize(parseInt($('canvasW').value, 10) || 1280, parseInt($('canvasH').value, 10) || 720);
$('canvasW').addEventListener('change', onCustom);
$('canvasH').addEventListener('change', onCustom);

$('fps').addEventListener('change', (e) => { project.fps = parseInt(e.target.value, 10); });

$('defDuration').addEventListener('input', (e) => {
  project.defaults.durationSec = parseFloat(e.target.value);
  $('durVal').textContent = project.defaults.durationSec.toFixed(1);
  rebuild(); refreshSlideList();
});
$('defTransition').addEventListener('input', (e) => {
  project.defaults.transitionSec = parseFloat(e.target.value);
  $('transVal').textContent = project.defaults.transitionSec.toFixed(1);
  rebuild();
});
$('defKbZoom').addEventListener('input', (e) => {
  project.defaults.kenBurns.zoom = parseInt(e.target.value, 10) / 100;
  $('kbVal').textContent = e.target.value;
  rebuild();
});
$('defKbDirection').addEventListener('change', (e) => {
  const v = e.target.value;
  project.defaults.kenBurns.enabled = v !== 'off';
  if (v !== 'off') project.defaults.kenBurns.direction = v;
  rebuild();
});

// Background
$('bgMode').addEventListener('change', (e) => {
  project.background.mode = e.target.value;
  const isColor = e.target.value === 'color';
  $('bgColorField').classList.toggle('hidden', !isColor);
  $('bgBlurField').classList.toggle('hidden', isColor);
  $('bgDimField').classList.toggle('hidden', isColor);
  player.redraw();
});
let bgDebounce = null;
function bgChanged(rebuildBmp) {
  if (rebuildBmp) {
    clearTimeout(bgDebounce);
    bgDebounce = setTimeout(rebuildBackgrounds, 120);
  } else {
    player.redraw();
  }
}
$('bgBlur').addEventListener('input', (e) => { project.background.blur = parseInt(e.target.value, 10); $('blurVal').textContent = e.target.value; bgChanged(true); });
$('bgDim').addEventListener('input', (e) => { project.background.dim = parseInt(e.target.value, 10) / 100; $('dimVal').textContent = e.target.value; bgChanged(true); });
$('bgColor').addEventListener('input', (e) => { project.background.color = e.target.value; player.redraw(); });

$('loopToggle').addEventListener('change', (e) => { project.loop = e.target.checked; rebuild(); });

// --- Transport -------------------------------------------------------------
function fmtTime(sec) {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function updateTimeUI(t, dur) {
  $('timeLabel').textContent = `${fmtTime(t)} / ${fmtTime(dur)}`;
  const scrub = $('scrub');
  if (!scrub.dragging) scrub.value = dur > 0 ? Math.round((t / dur) * 1000) : 0;
  $('btnPlay').textContent = player.playing ? '❚❚' : '►';
}
$('btnPlay').addEventListener('click', () => { player.toggle(); updateTimeUI(player.time, timeline.totalDuration); });
const scrub = $('scrub');
scrub.addEventListener('input', (e) => {
  scrub.dragging = true;
  const dur = timeline.totalDuration || 0;
  player.pause();
  player.seek((parseInt(e.target.value, 10) / 1000) * dur);
});
scrub.addEventListener('change', () => { scrub.dragging = false; });

function updateCount() {
  const n = project.slides.length;
  $('countLabel').textContent = n ? `${n} photo${n > 1 ? 's' : ''} · ${fmtTime(timeline.totalDuration)}` : '';
}

// --- Add photos (button + drag-drop) --------------------------------------
$('btnAddPhotos').addEventListener('click', async () => {
  const files = await window.api.openImages();
  await addSources(files);
});
$('btnClear').addEventListener('click', () => { if (project.slides.length) clearAll(); });

// Drag & drop image files onto the window.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const paths = [];
  for (const f of e.dataTransfer.files) {
    if (f.type.startsWith('image/') || /\.(jpe?g|png|webp|bmp|gif|tiff?|heic)$/i.test(f.name)) {
      if (f.path) paths.push(f.path);
    }
  }
  if (paths.length) await addSources(paths);
});

// --- Export ----------------------------------------------------------------
const QUALITY = {
  mp4: { high: 16, balanced: 19, small: 24 },
  webm: { high: 24, balanced: 31, small: 38 },
};
$('btnExport').addEventListener('click', runExport);
$('btnCancelExport').addEventListener('click', () => { cancelRequested = true; });

async function runExport() {
  if (exporting) return;
  if (!project.slides.length) { toast('Add some photos first.', true); return; }
  const format = $('exportFormat').value;
  const qualityKey = $('exportQuality').value;
  const outputPath = await window.api.saveVideo(format);
  if (!outputPath) return;

  exporting = true;
  cancelRequested = false;
  player.pause();
  $('btnExport').disabled = true;
  $('exportProgress').classList.remove('hidden');
  $('progressFill').style.width = '0%';
  $('progressLabel').textContent = 'Rendering frames…';

  const exportTimeline = buildTimeline(project); // fresh, current settings
  try {
    const res = await exportVideo(project, exportTimeline, assetsArray(), {
      format,
      quality: QUALITY[format][qualityKey],
      fps: project.fps,
      outputPath,
      onProgress: (p, f, total) => {
        $('progressFill').style.width = (p * 100).toFixed(1) + '%';
        $('progressLabel').textContent = `Rendering frame ${f} / ${total}`;
      },
      shouldCancel: () => cancelRequested,
    });
    if (res.canceled) {
      toast('Export cancelled.');
    } else if (res.ok) {
      $('progressFill').style.width = '100%';
      toast('Saved: ' + outputPath);
    } else {
      console.error(res.log);
      toast('Export failed. See console for FFmpeg log.', true);
    }
  } catch (err) {
    console.error(err);
    toast('Export error: ' + err.message, true);
  } finally {
    exporting = false;
    $('btnExport').disabled = false;
    setTimeout(() => $('exportProgress').classList.add('hidden'), 1500);
  }
}

// --- Keyboard --------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); player.toggle(); updateTimeUI(player.time, timeline.totalDuration); }
  if (e.code === 'Delete' && selectedId) removeSlide(selectedId);
});

// --- Init ------------------------------------------------------------------
player.resizeToProject();
player.seek(0);
updateCount();
