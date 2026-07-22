# Slideshow Studio

A small desktop app for turning a folder of photos into a polished, **looping**
tribute slideshow — built for AV work at ceremonies where relatives hand over a
pile of photos in every size and shape.

It handles the tedious part automatically:

- **Any aspect ratio in, one clean canvas out.** Portrait, landscape, square and
  panorama photos are all fitted into your chosen 16:9 (or custom) frame.
- **Blurred background fill.** The empty space around off-shape photos is filled
  with a blurred, dimmed copy of the photo — or a blurred **montage of all the
  photos** — so there are never black bars.
- **Ken Burns motion.** Slow, tasteful zoom/pan on every image (per-photo control).
- **Crossfades.** 1-second (adjustable) dissolves between photos.
- **Seamless loop.** The last photo dissolves back into the first, so the file
  loops without a visible jump on a repeating AV player.
- **License-free export.** MP4 / H.264 (maximum compatibility) or WebM / VP9
  (fully royalty-free). FFmpeg is bundled — nothing to install.

The live preview and the final export share the **same rendering code**, so what
you see is exactly what you get.

## Run it (development)

```bash
npm install
npm start
```

`npm install` downloads Electron and the FFmpeg binary automatically.

Then: **Add photos** (or drag them onto the window) → set duration / crossfade /
motion → scrub the preview → **Export video…**.

Sample images of assorted aspect ratios are generated in `sample-photos/`
(git-ignored) if you want something to test with immediately.

## Build installers

Windows (`.exe`) builds on Windows; macOS (`.dmg`) builds on macOS:

```bash
npm run build:win    # -> dist/*.exe   (run on Windows)
npm run build:mac    # -> dist/*.dmg   (run on macOS)
```

**You cannot build a real Mac installer from Windows.** To get the Mac build
without owning a Mac, use the included GitHub Actions workflow
(`.github/workflows/build.yml`): push a `v*` tag or trigger it manually, and
download the `installer-macos-latest` / `installer-windows-latest` artifacts.

### Signing (optional, for distribution)

Unsigned apps trigger Windows SmartScreen and macOS Gatekeeper warnings on other
people's machines — fine for a colleague, worth doing for wider distribution.

- **macOS:** requires an Apple Developer account ($99/yr) for signing +
  notarization. Add certs as CI secrets and remove `CSC_IDENTITY_AUTO_DISCOVERY`.
- **Windows:** requires a code-signing certificate.

## How it works

```
src/
  main/
    main.js       Electron main process: window, native dialogs, FFmpeg encoder
    preload.js    Safe IPC bridge exposed to the renderer as window.api
  renderer/
    index.html    UI
    styles.css    UI styling
    render.js     ← THE core: timeline math + renderFrame() (used by preview AND export)
    assets.js     Image loading + pre-rendered blurred/montage backgrounds
    preview.js    Real-time preview player (calls render.js)
    exporter.js   Full-res frame generation → streamed to FFmpeg (calls render.js)
    app.js        UI state and wiring
```

**Export pipeline:** the renderer draws every frame at full resolution with
`render.js`, reads the raw RGBA pixels, and streams them over IPC to FFmpeg in
the main process (`-f rawvideo -pix_fmt rgba … -i pipe:0`). FFmpeg is a pure
encoder — no fragile filtergraph that could drift from the preview. Blurred
backgrounds are computed once per photo, so per-frame work stays light.

## Roadmap / easy next steps

- **Background music track** (single audio file, auto-fit to length) — the most
  common next request for this use case.
- Title card / end card with name & dates.
- Per-photo captions.
- Project save/load (`.json`) so a slideshow can be reopened and tweaked.
- Manual crop framing per photo.

## License

MIT. Exported video uses no proprietary assets; H.264 playback is universally
supported and VP9 is fully royalty-free.
