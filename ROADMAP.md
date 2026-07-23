# Roadmap

Planned features, in build order. Items 1–2 are tightly coupled (auto-timing is
the engine music needs) and are being built first.

## 1. Background music  🚧 in progress
- Import an audio track; the composition length adapts to the music length.
- Optional **fade in from black** and optional **fade out to black** *or*
  **freeze frame** at the end.
- Loop is turned **off** in music mode.
- Photo durations are auto-distributed to fill the music length (see #2).
- Manually setting one photo's duration re-distributes the remaining time
  across the other photos.

## 2. Fixed total length (auto photo durations)  🚧 in progress
- Independent of music: set a fixed total length; photo durations adjust
  automatically to fill it.
- Manual per-photo duration "locks" that photo; the rest share what's left.

## 3. Built-in title generator  ✅ built (on main)
- Multi-line title card (max 4 lines), e.g. line 1 = name, line 2 = "born –
  died".
- Per-line font size; adjustable line spacing.
- Choice of 5–10 free, elegant fonts (bundled/offline, license-clear).
- Typical use: name + dates as an opening (and/or closing) card.

## 4. Multi-photo collage on wide canvases  ✅ built (on main) — nice to have
- On a wide canvas, show several photos at once in different positions, fading
  in and out independently for a livelier, richer feel.
- Settings such as a maximum number of simultaneous photos.

## 5. Per-photo border / frame  ✅ built (on main)
- Optional decorative frame around each photo so they read like real, classic
  picture frames passing by.
- Choice of **none** or several chic/classic frame styles.

---

## Done (shipped)
- v0.1.0 — core app: import, reorder, Ken Burns, crossfades, blurred background,
  MP4/WebM export, save/load, on-device face protection, photo frame.
- v0.1.1 — background blur as 0–50%, montage shuffle, "keep original" per-photo frame.
- v0.1.2 — portrait-canvas transport fix, montage shuffle genuinely rearranges.
