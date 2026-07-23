// app.js — UI state and wiring. Holds the project model, prepares assets,
// drives the preview Player, and runs exports.
import { buildTimeline, featuredAt, getSourceRect, computeFrame } from './render.js';
import { loadImage, makeSlideBackground, makeMontage } from './assets.js';
import { Player } from './preview.js';
import { exportVideo } from './exporter.js';
import { detectFaces, faceApiAvailable } from './faces.js';

// --- State -----------------------------------------------------------------
let uidCounter = 1;
const uid = () => 's' + (uidCounter++);

const project = {
  canvas: { w: 1280, h: 720 },
  fps: 30,
  loop: true,
  protectFaces: true,     // AI: keep detected faces in frame
  showFaceOverlay: false, // draw face boxes on the preview
  foreground: { shape: '16:9', scale: 1, align: 'center' }, // the photo frame
  background: { mode: 'slide-blur', blur: 22, dim: 0.5, color: '#101014' }, // blur is 0–50%
  montageSeed: 12345, // shuffle re-rolls this
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
let currentPlayingId = null; // slide currently shown in the preview (≠ selected)
let currentProjectPath = null;
let currentProjectName = null;
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

const player = new Player(canvasEl, getState, (t, dur) => { updateTimeUI(t, dur); updateNowPlaying(t); });

// Mark the photo currently shown in the preview in the list (independent of
// selection). Only touches DOM when the featured slide changes, so it's cheap
// even at 60 fps.
function updateNowPlaying(t) {
  const f = (timeline && timeline.items.length) ? featuredAt(timeline, t) : null;
  setNowPlaying(f ? project.slides[f.item.index].id : null);
}
function setNowPlaying(id) {
  if (id === currentPlayingId) return;
  currentPlayingId = id;
  document.querySelectorAll('.slide-item.now-playing').forEach((el) => el.classList.remove('now-playing'));
  if (id) {
    const el = document.querySelector(`.slide-item[data-id="${id}"]`);
    if (el) {
      el.classList.add('now-playing');
      if (player.playing) el.scrollIntoView({ block: 'nearest' });
    }
  }
}

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
      const slide = { id, src, name, faces: [], protect: true };
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

  // Detect faces on the newly added photos (on-device, in the background).
  scanFaces(added);
}

let scanning = false;
async function scanFaces(slides) {
  if (!faceApiAvailable()) {
    $('faceScanStatus').textContent = 'Face AI unavailable — motion will use defaults.';
    return;
  }
  const todo = slides.filter((s) => s && assetMap.has(s.id));
  if (!todo.length) return;
  scanning = true;
  const status = $('faceScanStatus');
  let done = 0;
  for (const slide of todo) {
    const asset = assetMap.get(slide.id);
    if (!asset) { done++; continue; }
    status.textContent = `Scanning for faces… ${done + 1}/${todo.length}`;
    try {
      slide.faces = await detectFaces(asset.img);
    } catch (err) {
      console.error('face detect failed', err);
      slide.faces = [];
    }
    done++;
    rebuild();                       // reframe as results arrive
    if (slide.id === selectedId) refreshSelectedFacePanel();
    refreshSlideList();
  }
  const total = todo.reduce((n, s) => n + (s.faces ? s.faces.length : 0), 0);
  status.textContent = `Found ${total} face${total === 1 ? '' : 's'} across ${todo.length} photo${todo.length === 1 ? '' : 's'}.`;
  scanning = false;
}

function rebuildMontage() {
  const imgs = project.slides.map((s) => assetMap.get(s.id)?.img).filter(Boolean);
  project._montage = imgs.length ? makeMontage(imgs, project, project.montageSeed) : null;
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
    li.className = 'slide-item'
      + (s.id === selectedId ? ' selected' : '')
      + (s.id === currentPlayingId ? ' now-playing' : '')
      + (s.missing ? ' missing' : '');
    li.draggable = true;
    li.dataset.id = s.id;
    const dur = s.durationSec ?? project.defaults.durationSec;
    const sub = s.missing
      ? '<span class="warn">⚠ missing</span>'
      : `${dur}s${s.kenBurns && s.kenBurns.enabled === false ? ' · no motion' : ''}`;
    li.innerHTML = `
      <span class="playmark" title="Now showing"></span>
      <span class="num">${i + 1}</span>
      <img class="thumb" src="${srcToUrl(s.src)}" alt="" />
      <div class="meta">
        <div class="name">${s.name || 'photo'}</div>
        <div class="sub">${sub}</div>
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
  $('sProtect').checked = s.protect !== false;
  refreshSelectedFacePanel();
  refreshSlideList();
}

// Draw the selected photo with its detected face boxes in the side panel.
function refreshSelectedFacePanel() {
  const s = project.slides.find((x) => x.id === selectedId);
  const cv = $('facePreview');
  if (!s || !cv) return;
  const asset = assetMap.get(s.id);
  if (!asset || !asset.img) return;
  const img = asset.img;
  const maxW = 260, scale = Math.min(1, maxW / img.width);
  cv.width = Math.round(img.width * scale);
  cv.height = Math.round(img.height * scale);
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0, cv.width, cv.height);
  const faces = s.faces || [];
  ctx.strokeStyle = 'rgba(108,140,255,0.95)';
  ctx.lineWidth = Math.max(2, cv.width / 130);
  for (const f of faces) {
    ctx.strokeRect(f.x * cv.width, f.y * cv.height, f.w * cv.width, f.h * cv.height);
  }
  $('faceCount').textContent = scanning ? 'Scanning…'
    : faces.length ? `${faces.length} face${faces.length === 1 ? '' : 's'} found`
    : 'No faces found';
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
$('sProtect').addEventListener('change', (e) => {
  const s = currentSlide(); if (!s) return;
  s.protect = e.target.checked;
  rebuild(); refreshSlideList();
});
$('btnRedetect').addEventListener('click', async () => {
  const s = currentSlide(); if (!s || scanning) return;
  await scanFaces([s]);
});
$('btnRemoveSlide').addEventListener('click', () => { if (selectedId) removeSlide(selectedId); });

// Global AI toggles
$('protectFaces').addEventListener('change', (e) => { project.protectFaces = e.target.checked; rebuild(); });
$('showFaceOverlay').addEventListener('change', (e) => { project.showFaceOverlay = e.target.checked; player.redraw(); });

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

// Photo frame (foreground)
$('fgShape').addEventListener('change', (e) => { project.foreground.shape = e.target.value; rebuild(); });
$('fgScale').addEventListener('input', (e) => {
  project.foreground.scale = parseInt(e.target.value, 10) / 100;
  $('fgScaleVal').textContent = e.target.value;
  rebuild();
});
$('fgAlign').addEventListener('change', (e) => { project.foreground.align = e.target.value; rebuild(); });

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
  $('bgShuffleField').classList.toggle('hidden', e.target.value !== 'montage');
  player.redraw();
});
$('bgShuffle').addEventListener('click', () => {
  project.montageSeed = Math.floor(Math.random() * 1e9);
  rebuildMontage();
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

// --- Project save / load ---------------------------------------------------
function basenameNoExt(p) {
  const b = String(p).replace(/\\/g, '/').split('/').pop();
  return b.replace(/\.[^.]+$/, '');
}
function setProjectPath(filePath) {
  currentProjectPath = filePath;
  currentProjectName = basenameNoExt(filePath);
  $('projectName').textContent = currentProjectName ? '— ' + currentProjectName : '';
}

function serializeProject() {
  return {
    app: 'slideshow-studio', version: 1,
    project: {
      canvas: { w: project.canvas.w, h: project.canvas.h },
      fps: project.fps, loop: project.loop,
      protectFaces: project.protectFaces, showFaceOverlay: project.showFaceOverlay,
      foreground: { shape: project.foreground.shape, scale: project.foreground.scale, align: project.foreground.align },
      background: { mode: project.background.mode, blur: project.background.blur, dim: project.background.dim, color: project.background.color },
      montageSeed: project.montageSeed,
      defaults: {
        durationSec: project.defaults.durationSec,
        transitionSec: project.defaults.transitionSec,
        kenBurns: { ...project.defaults.kenBurns },
      },
      slides: project.slides.map((s) => ({
        id: s.id, name: s.name, file: s.src,
        durationSec: s.durationSec, transitionSec: s.transitionSec,
        kenBurns: s.kenBurns, protect: s.protect, faces: s.faces || [],
      })),
    },
  };
}

// A drawable stand-in for a photo that couldn't be found on disk.
function makePlaceholder(name) {
  const w = 1280, h = 720;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#2a2320'; ctx.fillRect(0, 0, w, h);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#e0607a'; ctx.font = 'bold 48px sans-serif';
  ctx.fillText('⚠ Photo not found', w / 2, h / 2 - 8);
  ctx.fillStyle = '#b7998f'; ctx.font = '26px sans-serif';
  ctx.fillText(name || '', w / 2, h / 2 + 42);
  return c;
}

$('btnSaveProject').addEventListener('click', () => {
  if (!project.slides.length) { toast('Add photos before saving.', true); return; }
  $('collectFiles').checked = true;
  $('saveModal').classList.remove('hidden');
});
$('btnCancelSave').addEventListener('click', () => $('saveModal').classList.add('hidden'));
$('btnConfirmSave').addEventListener('click', async () => {
  const collect = $('collectFiles').checked;
  $('saveModal').classList.add('hidden');
  const filePath = await window.api.saveProjectPath(currentProjectName || 'Untitled');
  if (!filePath) return;
  const doc = serializeProject();
  const res = await window.api.writeProject({ filePath, doc, collect });
  if (!res.ok) { toast('Save failed: ' + res.error, true); return; }
  // When collected, repoint in-memory sources to the copied files so the
  // session no longer depends on the originals (and re-saves are idempotent).
  if (collect && res.dir) {
    const dir = res.dir.replace(/\\/g, '/');
    for (const sd of res.doc.project.slides) {
      const isAbs = /^[a-zA-Z]:[\\/]/.test(sd.file) || sd.file.startsWith('/');
      if (!isAbs) {
        const slide = project.slides.find((x) => x.id === sd.id);
        if (slide) slide.src = dir + '/' + sd.file;
      }
    }
    refreshSlideList();
  }
  setProjectPath(filePath);
  toast('Saved: ' + filePath);
});

$('btnOpenProject').addEventListener('click', openProject);
async function openProject() {
  const filePath = await window.api.openProjectPath();
  if (!filePath) return;
  const read = await window.api.readProject(filePath);
  if (!read.ok) { toast('Could not open: ' + read.error, true); return; }
  await loadProjectDoc(read, filePath);
}

async function loadProjectDoc(read, filePath) {
  const p = read.doc && read.doc.project;
  if (!p || !Array.isArray(p.slides)) { toast('Not a valid project file.', true); return; }
  player.pause();

  // Reset current state
  project.slides = [];
  assetMap.clear();
  project._montage = null;
  selectedId = null;
  currentPlayingId = null;

  // Settings
  if (p.canvas) { project.canvas.w = p.canvas.w; project.canvas.h = p.canvas.h; }
  project.fps = p.fps || 30;
  project.loop = p.loop !== false;
  project.protectFaces = p.protectFaces !== false;
  project.showFaceOverlay = !!p.showFaceOverlay;
  if (p.foreground) project.foreground = { shape: '16:9', scale: 1, align: 'center', ...p.foreground };
  if (p.background) Object.assign(project.background, p.background);
  if (typeof p.montageSeed === 'number') project.montageSeed = p.montageSeed;
  if (p.defaults) {
    project.defaults.durationSec = p.defaults.durationSec ?? 7;
    project.defaults.transitionSec = p.defaults.transitionSec ?? 1;
    project.defaults.kenBurns = { enabled: true, zoom: 0.12, direction: 'auto', ...(p.defaults.kenBurns || {}) };
  }

  const resolvedMap = new Map((read.resolved || []).map((r) => [r.id, r]));
  const missing = [];
  let maxNum = 0;
  for (const sd of p.slides) {
    const r = resolvedMap.get(sd.id) || {};
    const src = r.path || sd.file;
    const slide = {
      id: sd.id || uid(), name: sd.name, src,
      durationSec: sd.durationSec, transitionSec: sd.transitionSec,
      kenBurns: sd.kenBurns, protect: sd.protect !== false, faces: sd.faces || [], missing: !r.exists,
    };
    project.slides.push(slide);
    const m = String(slide.id).match(/(\d+)/); if (m) maxNum = Math.max(maxNum, +m[1]);
    if (r.exists) {
      try {
        const img = await loadImage(src);
        assetMap.set(slide.id, { img, bg: makeSlideBackground(img, project) });
      } catch { slide.missing = true; }
    }
    if (slide.missing) {
      const ph = makePlaceholder(slide.name);
      assetMap.set(slide.id, { img: ph, bg: makeSlideBackground(ph, project) });
      missing.push(slide);
    }
  }
  uidCounter = Math.max(uidCounter, maxNum + 1);

  rebuildMontage();
  syncControlsFromProject();
  refreshSlideList();
  rebuild();
  setProjectPath(filePath);
  $('stageEmpty').classList.toggle('hidden', project.slides.length > 0);
  if (project.slides.length) selectSlide(project.slides[0].id);
  if (missing.length) openRelinkModal(missing);
  else toast('Opened: ' + (read.name || basenameNoExt(filePath)));
}

// Reflect the loaded project's settings back into every control.
function syncControlsFromProject() {
  const sizeStr = project.canvas.w + 'x' + project.canvas.h;
  const presetSel = $('canvasPreset');
  const hasPreset = [...presetSel.options].some((o) => o.value === sizeStr);
  presetSel.value = hasPreset ? sizeStr : 'custom';
  $('customSize').classList.toggle('hidden', hasPreset);
  $('canvasW').value = project.canvas.w; $('canvasH').value = project.canvas.h;
  $('fps').value = String(project.fps);
  $('fgShape').value = project.foreground.shape;
  const fgPct = Math.round((project.foreground.scale || 1) * 100);
  $('fgScale').value = fgPct; $('fgScaleVal').textContent = fgPct;
  $('fgAlign').value = project.foreground.align;
  $('defDuration').value = project.defaults.durationSec; $('durVal').textContent = project.defaults.durationSec.toFixed(1);
  $('defTransition').value = project.defaults.transitionSec; $('transVal').textContent = project.defaults.transitionSec.toFixed(1);
  const zoomPct = Math.round((project.defaults.kenBurns.zoom || 0) * 100);
  $('defKbZoom').value = zoomPct; $('kbVal').textContent = zoomPct;
  $('defKbDirection').value = project.defaults.kenBurns.enabled === false ? 'off'
    : (['in', 'out'].includes(project.defaults.kenBurns.direction) ? project.defaults.kenBurns.direction : 'auto');
  $('bgMode').value = project.background.mode;
  const isColor = project.background.mode === 'color';
  $('bgColorField').classList.toggle('hidden', !isColor);
  $('bgBlurField').classList.toggle('hidden', isColor);
  $('bgDimField').classList.toggle('hidden', isColor);
  $('bgShuffleField').classList.toggle('hidden', project.background.mode !== 'montage');
  $('bgBlur').value = project.background.blur; $('blurVal').textContent = project.background.blur;
  const dimPct = Math.round((project.background.dim || 0) * 100);
  $('bgDim').value = dimPct; $('dimVal').textContent = dimPct;
  $('bgColor').value = project.background.color || '#101014';
  $('loopToggle').checked = project.loop;
  $('protectFaces').checked = project.protectFaces;
  $('showFaceOverlay').checked = project.showFaceOverlay;
}

// Relink missing photos by pointing at the folder they now live in.
let relinkTargets = [];
function openRelinkModal(missing) {
  relinkTargets = missing;
  $('relinkMsg').textContent = `${missing.length} photo${missing.length === 1 ? '' : 's'} could not be found at the saved location. Point to the folder they’re in — they’ll be re-linked by filename.`;
  const ul = $('relinkList'); ul.innerHTML = '';
  for (const s of missing) {
    const li = document.createElement('li');
    li.dataset.id = s.id;
    li.innerHTML = `<span>${s.name || s.src}</span><span class="miss">missing</span>`;
    ul.appendChild(li);
  }
  $('relinkModal').classList.remove('hidden');
}
$('btnRelinkSkip').addEventListener('click', () => $('relinkModal').classList.add('hidden'));
$('btnRelinkLocate').addEventListener('click', async () => {
  const folder = await window.api.openFolder();
  if (!folder) return;
  const names = relinkTargets.map((s) => s.name).filter(Boolean);
  const res = await window.api.matchInFolder(folder, names);
  if (!res.ok) { toast('Could not read folder: ' + res.error, true); return; }
  let fixed = 0;
  const stillMissing = [];
  for (const s of relinkTargets) {
    const hit = res.matches[s.name];
    if (hit) {
      try {
        const img = await loadImage(hit);
        assetMap.set(s.id, { img, bg: makeSlideBackground(img, project) });
        s.src = hit; s.missing = false; fixed++;
        const li = $('relinkList').querySelector(`li[data-id="${s.id}"]`);
        if (li) li.querySelector('.miss').outerHTML = '<span class="ok">linked</span>';
      } catch { stillMissing.push(s); }
    } else stillMissing.push(s);
  }
  rebuildMontage();
  refreshSlideList();
  rebuild();
  if (selectedId) refreshSelectedFacePanel();
  relinkTargets = stillMissing;
  if (stillMissing.length) toast(`Linked ${fixed}. ${stillMissing.length} still missing.`, true);
  else { $('relinkModal').classList.add('hidden'); toast(`Linked ${fixed} photo${fixed === 1 ? '' : 's'}.`); }
});

// --- Keyboard --------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    if (project.slides.length) { $('collectFiles').checked = true; $('saveModal').classList.remove('hidden'); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) {
    e.preventDefault(); openProject(); return;
  }
  if (e.key === 'Escape') { $('saveModal').classList.add('hidden'); $('relinkModal').classList.add('hidden'); return; }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); player.toggle(); updateTimeUI(player.time, timeline.totalDuration); }
  if (e.code === 'Delete' && selectedId) removeSlide(selectedId);
});

// --- Face overlay on the preview (tracks the Ken Burns motion) -------------
player.overlay = function (ctx, t) {
  if (!project.showFaceOverlay) return;
  const f = featuredAt(timeline, t);
  if (!f) return;
  const slide = project.slides[f.item.index];
  const asset = slide && assetMap.get(slide.id);
  if (!asset || !asset.img || !slide.faces || !slide.faces.length) return;
  const cw = project.canvas.w;
  const iw = asset.img.width, ih = asset.img.height;
  const F = computeFrame(project, iw / ih);
  const r = getSourceRect(f.item, asset.img, F.w, F.h, f.localU);
  ctx.save();
  ctx.strokeStyle = 'rgba(108,140,255,0.9)';
  ctx.lineWidth = Math.max(2, cw / 360);
  for (const box of slide.faces) {
    const x = F.x + (box.x * iw - r.sx) / r.sw * F.w;
    const y = F.y + (box.y * ih - r.sy) / r.sh * F.h;
    ctx.strokeRect(x, y, box.w * iw / r.sw * F.w, box.h * ih / r.sh * F.h);
  }
  ctx.restore();
};

// --- Init ------------------------------------------------------------------
player.resizeToProject();
player.seek(0);
updateCount();
if (!faceApiAvailable()) $('faceScanStatus').textContent = 'Face AI not loaded.';
