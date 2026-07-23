// main.js — Electron main process. Owns the window, native dialogs, and the
// FFmpeg encoder. Rendering happens in the renderer; this process just receives
// finished RGBA frames and pipes them into bundled FFmpeg.
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Bundled FFmpeg binary. When packaged, it lives in app.asar.unpacked.
let ffmpegPath = require('ffmpeg-static');
if (ffmpegPath && ffmpegPath.includes('app.asar')) {
  ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
}

const isDev = process.argv.includes('--dev');
let mainWindow = null;
const jobs = new Map(); // id -> { proc, stdin, stderr }

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#15171c',
    title: 'WTAV Slideshow Studio',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const pageArg = process.argv.find((a) => a.startsWith('--page='));
  const page = pageArg ? pageArg.slice('--page='.length) : 'index.html';
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', page));
  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    // Surface renderer console + load failures on the main-process stdout so
    // headless launches can be verified.
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
      console.log(`[renderer:${level}] ${message} (${source}:${line})`);
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      console.log(`[did-fail-load] ${code} ${desc}`);
    });
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      console.log(`[render-gone] ${JSON.stringify(details)}`);
    });
  }
  Menu.setApplicationMenu(null);
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- App info / external links ---------------------------------------------
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('shell:openExternal', (_e, { url }) => {
  if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
});

// --- Native dialogs --------------------------------------------------------
ipcMain.handle('dialog:openImages', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Add photos',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tiff', 'heic'] }],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('dialog:openAudio', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Add music',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'flac', 'opus'] }],
  });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});

ipcMain.handle('dialog:saveVideo', async (_e, { format }) => {
  const ext = format === 'webm' ? 'webm' : 'mp4';
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Export video',
    defaultPath: `slideshow.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  return res.canceled ? null : res.filePath;
});

// --- Project save / load ---------------------------------------------------
ipcMain.handle('dialog:saveProjectPath', async (_e, { defaultName } = {}) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Save project',
    defaultPath: (defaultName || 'Untitled') + '.slideshow',
    filters: [{ name: 'Slideshow project', extensions: ['slideshow'] }],
  });
  return res.canceled ? null : res.filePath;
});

ipcMain.handle('dialog:openProjectPath', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open project', properties: ['openFile'],
    filters: [{ name: 'Slideshow project', extensions: ['slideshow', 'json'] }],
  });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});

ipcMain.handle('dialog:openFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Locate photos folder', properties: ['openDirectory'],
  });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});

// Write the project JSON; optionally collect all photos into "<name> files".
ipcMain.handle('project:write', async (_e, { filePath, doc, collect }) => {
  try {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath));
    const slides = (doc.project && doc.project.slides) || [];

    if (collect) {
      const filesDirName = base + ' files';
      const filesDir = path.join(dir, filesDirName);
      fs.mkdirSync(filesDir, { recursive: true });
      const used = new Set();
      for (const s of slides) {
        const srcAbs = s.file;
        if (!srcAbs || !path.isAbsolute(srcAbs) || !fs.existsSync(srcAbs)) { s.missing = true; continue; }
        const ext = path.extname(srcAbs);
        const stem = path.basename(srcAbs, ext);
        let candidate = stem + ext, i = 1;
        while (used.has(candidate.toLowerCase())) candidate = `${stem}_${i++}${ext}`;
        used.add(candidate.toLowerCase());
        const dest = path.join(filesDir, candidate);
        try {
          if (path.resolve(srcAbs) !== path.resolve(dest)) fs.copyFileSync(srcAbs, dest);
        } catch (err) { /* skip a file that can't be copied, keep going */ }
        s.file = `${filesDirName}/${candidate}`; // relative, forward slashes
      }

      // Also collect the music track, if any.
      const audio = doc.project && doc.project.audio;
      if (audio && audio.src && path.isAbsolute(audio.src) && fs.existsSync(audio.src)) {
        const ext = path.extname(audio.src);
        const stem = path.basename(audio.src, ext);
        let candidate = stem + ext, i = 1;
        while (used.has(candidate.toLowerCase())) candidate = `${stem}_${i++}${ext}`;
        used.add(candidate.toLowerCase());
        const dest = path.join(filesDir, candidate);
        try {
          if (path.resolve(audio.src) !== path.resolve(dest)) fs.copyFileSync(audio.src, dest);
          audio.src = `${filesDirName}/${candidate}`;
        } catch (err) { /* keep absolute path if copy fails */ }
      }
    }

    fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf8');
    return { ok: true, doc, dir };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Read a project and report which photos resolve on disk.
ipcMain.handle('project:read', async (_e, { filePath }) => {
  try {
    const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const dir = path.dirname(filePath);
    const slides = (doc.project && doc.project.slides) || [];
    const resolved = slides.map((s) => {
      const abs = path.isAbsolute(s.file) ? s.file : path.join(dir, s.file);
      return { id: s.id, path: abs, exists: fs.existsSync(abs) };
    });
    let audioResolved = null;
    const audio = doc.project && doc.project.audio;
    if (audio && audio.src) {
      const abs = path.isAbsolute(audio.src) ? audio.src : path.join(dir, audio.src);
      audioResolved = { path: abs, exists: fs.existsSync(abs) };
    }
    return { ok: true, doc, dir, resolved, audioResolved, name: path.basename(filePath, path.extname(filePath)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Relink: find files in a folder by basename (case-insensitive).
ipcMain.handle('fs:matchInFolder', async (_e, { folder, names }) => {
  try {
    const byLower = new Map();
    for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
      if (e.isFile()) byLower.set(e.name.toLowerCase(), path.join(folder, e.name));
    }
    const matches = {};
    for (const n of names) {
      const hit = byLower.get(String(n).toLowerCase());
      if (hit) matches[n] = hit;
    }
    return { ok: true, matches };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- FFmpeg export ---------------------------------------------------------
function buildFfmpegArgs({ width, height, fps, format, outputPath, quality, audioPath }) {
  const args = [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${width}x${height}`,
    '-r', String(fps),
    '-i', 'pipe:0',
  ];
  if (audioPath) args.push('-i', audioPath, '-map', '0:v:0', '-map', '1:a:0');

  if (format === 'webm') {
    args.push('-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '0', '-crf', String(quality ?? 30), '-row-mt', '1');
    if (audioPath) args.push('-c:a', 'libopus', '-b:a', '160k');
  } else {
    // Default: MP4 / H.264 for maximum player compatibility.
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', String(quality ?? 18), '-movflags', '+faststart');
    if (audioPath) args.push('-c:a', 'aac', '-b:a', '192k');
  }
  // End when the video (frame stream) ends, so trailing music is trimmed.
  if (audioPath) args.push('-shortest');
  args.push(outputPath);
  return args;
}

ipcMain.handle('export:begin', async (_e, opts) => {
  const id = String(Date.now()) + Math.floor(Math.random() * 1000);
  const args = buildFfmpegArgs(opts);
  const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
  const job = { proc, stdin: proc.stdin, getStderr: () => stderr, failed: null };
  proc.on('error', (err) => { job.failed = err.message; });
  proc.stdin.on('error', () => { /* swallow EPIPE if ffmpeg dies */ });
  jobs.set(id, job);
  return { id };
});

ipcMain.handle('export:frame', async (_e, { id, buffer }) => {
  const job = jobs.get(id);
  if (!job) throw new Error('No such export job');
  if (job.failed) throw new Error('FFmpeg failed: ' + job.failed);
  const buf = Buffer.from(buffer);
  // Respect backpressure: if the pipe is full, wait for it to drain.
  const ok = job.stdin.write(buf);
  if (!ok) {
    await new Promise((resolve) => job.stdin.once('drain', resolve));
  }
  return true;
});

ipcMain.handle('export:end', async (_e, { id }) => {
  const job = jobs.get(id);
  if (!job) throw new Error('No such export job');
  return await new Promise((resolve) => {
    job.proc.on('close', (code) => {
      jobs.delete(id);
      resolve({ ok: code === 0, code, log: job.getStderr() });
    });
    job.stdin.end();
  });
});

ipcMain.handle('export:cancel', async (_e, { id }) => {
  const job = jobs.get(id);
  if (job) {
    try { job.proc.kill('SIGKILL'); } catch {}
    jobs.delete(id);
  }
  return true;
});
