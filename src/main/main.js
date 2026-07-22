// main.js — Electron main process. Owns the window, native dialogs, and the
// FFmpeg encoder. Rendering happens in the renderer; this process just receives
// finished RGBA frames and pipes them into bundled FFmpeg.
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
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
    title: 'Slideshow Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
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

// --- Native dialogs --------------------------------------------------------
ipcMain.handle('dialog:openImages', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Add photos',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tiff', 'heic'] }],
  });
  return res.canceled ? [] : res.filePaths;
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

// --- FFmpeg export ---------------------------------------------------------
function buildFfmpegArgs({ width, height, fps, format, outputPath, quality }) {
  const input = [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${width}x${height}`,
    '-r', String(fps),
    '-i', 'pipe:0',
  ];
  if (format === 'webm') {
    return [
      ...input,
      '-c:v', 'libvpx-vp9',
      '-pix_fmt', 'yuv420p',
      '-b:v', '0',
      '-crf', String(quality ?? 30),
      '-row-mt', '1',
      outputPath,
    ];
  }
  // Default: MP4 / H.264 for maximum player compatibility.
  return [
    ...input,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'medium',
    '-crf', String(quality ?? 18),
    '-movflags', '+faststart',
    outputPath,
  ];
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
