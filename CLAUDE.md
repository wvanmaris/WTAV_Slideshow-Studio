# CLAUDE.md — WTAV Slideshow Studio

Working notes for Claude Code. Read this first when resuming work on this repo.
Keep it free of secrets (keys, passwords, private URLs); it travels with the public code.

## What this project is

An **Electron desktop app** (Windows + macOS) that turns a folder of photos into a polished,
looping tribute slideshow: Ken Burns motion, crossfades, blurred backgrounds, music, title
cards, decorative frames, multi-photo collage / photo wall, MP4/WebM export via bundled FFmpeg.
Built for AV work at ceremonies (funerals, memorials) where relatives hand over a pile of
photos in every size and shape.

No framework, no bundler: plain ES modules in the renderer, CommonJS in the main process.

## Files

| Path | Role |
|---|---|
| `src/main/main.js` | Electron main process: window, IPC (dialogs, save/load, export, update check). |
| `src/main/preload.js` | `window.api` bridge (contextIsolation on, nodeIntegration off). |
| `src/main/license.js`, `fingerprint.js` | Licence keys + demo mode (WTAV shared model, product `wss`). |
| `src/renderer/index.html` | The whole UI. Settings panel is tabbed via `data-tab="photo|canvas|style|timing|export|license"`. |
| `src/renderer/app.js` | UI state + wiring: the `project` model, control listeners, save/load, export driver. |
| `src/renderer/render.js` | **Single source of truth for how a frame looks.** Preview and export both call `renderFrame()`. |
| `src/renderer/preview.js` | `Player` (rAF loop, seek/play/pause) around `renderFrame`. |
| `src/renderer/exporter.js` | Frame-by-frame export through FFmpeg (via IPC). |
| `src/renderer/assets.js` | Image loading, per-slide blurred backgrounds, the blurred montage. |
| `src/renderer/faces.js` | On-device face detection (face-api.js, SSD MobileNet v1) for face-safe Ken Burns. |
| `ROADMAP.md` | Feature roadmap + "Done (shipped)" list per version. Update it with every release. |
| `.github/workflows/build.yml` | CI: builds installers; a `v*` tag publishes them as a GitHub Release. |

## Code map (renderer)

- **Project model:** the `project` object at the top of `app.js`. Anything new must be added in
  four places: the model defaults, `serializeProject()` (save), `loadProjectData()` (load, with
  defaults for old files), and `syncControlsFromProject()` (UI restore). Controls get their
  `addEventListener` next to the related section and call `rebuild()` (timeline) or
  `player.redraw()` (looks only).
- **Timeline:** `buildTimeline(project)` in `render.js` lays every slide on a circular timeline
  (crossfade back into the first slide → seamless loop). Multi-photo modes bypass it: they
  return `{ items: [], collage: <schedule>, cycle, totalDuration, loop }`.
- **Multi-photo modes** (v0.4.0): `normalizeCollage()`, `buildCollageSchedule()`, `drawGrid()`,
  `drawWall()` in `render.js`. `project.collage.mode` is `'off' | 'grid' | 'wall'`.
  - `grid` = Collage: 2–7 non-overlapping cells (`gridCells()` picks rows/cols for the canvas
    aspect, short rows centred); photos keep their own aspect inside a cell; swap
    `'one'` (one photo per interval, slots visited round-robin in a seeded order) or `'all'`
    (all cells together every interval).
  - `wall` = Photo wall: photos pasted on top of each other at seeded spots; `wallDepth`
    layers kept (oldest fades out as the newest fades in); Loop on → wall starts full
    (previous cycle underneath), Loop off → starts empty and fills up.
  - `randomness` (0–100 %) only jitters *when* swaps happen (±45 % of the interval max), never
    the cycle length, so loops still close exactly. Everything is seeded from
    `project.montageSeed` (the background **Shuffle** button re-rolls it).
  - Legacy files (≤ v0.3.x, `{enabled, maxConcurrent, photoSec}`) are mapped by
    `normalizeCollage()` to `grid` mode.
- **Determinism rule:** never use `Math.random()` in render code; use `seededRandom(seed)`.
  Preview and export must produce identical frames.
- **End fades** (fade in from / out to black) apply in one-shot mode only, via `applyEndFades()`.

## Versioning & release workflow

1. Bump `"version"` in `package.json` (and the two matching entries at the top of
   `package-lock.json`). That is the only place the version lives; the About dialog and the
   update checker read it from the app.
2. Update `ROADMAP.md` ("Done (shipped)" list) and, if user-facing, `README.md`.
3. Commit, then tag `vX.Y.Z` and push the tag: CI builds the Windows `.exe` and macOS `.dmg`
   and publishes a GitHub Release with auto-generated notes. The in-app start-up update check
   compares against `releases/latest`, so **a tag is a public release** — only tag when Walter
   has confirmed.
4. Local installer build: `npm run build:win` / `build:mac` (output in `dist/`, git-ignored).

## Local testing

- `npm install` once (downloads Electron + FFmpeg). `npm run dev` starts the app with detached
  DevTools **and prints renderer console messages to stdout**, so a headless launch can be
  checked for `[renderer:error]` lines.
- Render logic can be tested without Electron: `render.js` has no DOM/IPC dependencies. Serve
  the repo folder with any static server and load a scratch HTML page that imports
  `./src/renderer/render.js`, builds a fake `project` (canvas, slides, assets with canvas
  images) and calls `buildTimeline()` + `renderFrame()`. Useful checks: loop closure
  (frame at `t=0.02` equals frame at `t=L+0.02`), no overlapping grid cells, schedule times.
  Do not commit such scratch pages.
- Files are CRLF on Windows checkouts (`core.autocrlf=true`). When patching with node/sed
  scripts, normalise to LF for matching and write back with the original line endings.

## Repo / git notes

- Remote: `wvanmaris/WTAV_Slideshow-Studio`, single `main` branch, releases are tags.
- Licensing shares the WTAV model with `wvanmaris/wtav-licensing` (product code `wss`).
- Feedback mail and update URLs live in `app.js` / `main.js`; no server-side deploy exists for
  this app (installers only).
