// preview.js — drives the live preview canvas using render.js in real time.
import { renderFrame } from './render.js';

export class Player {
  constructor(canvas, getState, onTick) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getState = getState;       // () => { project, timeline, assets }
    this.onTick = onTick;           // (t, duration) => void
    this.playing = false;
    this.time = 0;                  // current playhead in seconds
    this._raf = null;
    this._last = 0;
    this._scratch = null;
    this.overlay = null;            // optional (ctx, t) => void, drawn on top
  }

  _ensureScratch(w, h) {
    if (!this._scratch || this._scratch.canvas.width !== w || this._scratch.canvas.height !== h) {
      const c = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h });
      this._scratch = { canvas: c, ctx: c.getContext('2d') };
    }
    return this._scratch;
  }

  resizeToProject() {
    const { project } = this.getState();
    if (this.canvas.width !== project.canvas.w || this.canvas.height !== project.canvas.h) {
      this.canvas.width = project.canvas.w;
      this.canvas.height = project.canvas.h;
    }
  }

  drawAt(t) {
    const { project, timeline, assets } = this.getState();
    if (!timeline || !timeline.items.length) {
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      return;
    }
    const scratch = this._ensureScratch(project.canvas.w, project.canvas.h);
    renderFrame(this.ctx, project, timeline, assets, t, scratch);
    if (this.overlay) this.overlay(this.ctx, t);
  }

  seek(t) {
    const { timeline } = this.getState();
    const dur = timeline ? timeline.totalDuration : 0;
    this.time = dur > 0 ? Math.min(Math.max(0, t), dur) : 0;
    this.drawAt(this.time);
    if (this.onTick) this.onTick(this.time, dur);
  }

  redraw() { this.drawAt(this.time); }

  play() {
    if (this.playing) return;
    const { timeline } = this.getState();
    if (!timeline || !timeline.items.length) return;
    this.playing = true;
    this._last = performance.now();
    const loop = (now) => {
      if (!this.playing) return;
      const dt = (now - this._last) / 1000;
      this._last = now;
      const st = this.getState();
      const dur = st.timeline ? st.timeline.totalDuration : 0;
      this.time += dt;
      if (dur > 0) {
        if (this.time >= dur) {
          if (st.project.loop !== false) this.time = this.time % dur;
          else { this.time = dur; this.pause(); }
        }
      }
      this.drawAt(this.time);
      if (this.onTick) this.onTick(this.time, dur);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  pause() {
    this.playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  toggle() { this.playing ? this.pause() : this.play(); }
}
