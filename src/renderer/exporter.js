// exporter.js — renders every frame at full resolution using the SAME
// render.js the preview uses, and streams raw RGBA frames to FFmpeg in main.
import { renderFrame } from './render.js';

export async function exportVideo(project, timeline, assets, opts) {
  const { format, quality, fps, outputPath, onProgress, shouldCancel } = opts;
  const cw = project.canvas.w, ch = project.canvas.h;
  const totalFrames = Math.max(1, Math.round(timeline.totalDuration * fps));

  const canvas = new OffscreenCanvas(cw, ch);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const scratchCanvas = new OffscreenCanvas(cw, ch);
  const scratch = { canvas: scratchCanvas, ctx: scratchCanvas.getContext('2d') };

  const { id } = await window.api.exportBegin({ width: cw, height: ch, fps, format, outputPath, quality });

  try {
    for (let f = 0; f < totalFrames; f++) {
      if (shouldCancel && shouldCancel()) {
        await window.api.exportCancel(id);
        return { canceled: true };
      }
      const t = f / fps;
      renderFrame(ctx, project, timeline, assets, t, scratch);
      const frame = ctx.getImageData(0, 0, cw, ch);
      // Hand the frame's bytes to FFmpeg (structured-cloned across IPC).
      await window.api.exportFrame(id, frame.data.buffer);
      if (onProgress) onProgress((f + 1) / totalFrames, f + 1, totalFrames);
    }
    const res = await window.api.exportEnd(id);
    return res;
  } catch (err) {
    try { await window.api.exportCancel(id); } catch {}
    throw err;
  }
}
