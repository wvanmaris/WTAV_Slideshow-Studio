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

## 4. Multi-photo collage on wide canvases  ✅ built (v0.2.0), redesigned in v0.4.0
- Collage mode: 2–7 photos **side by side** in non-overlapping cells (the v0.2
  version placed them at random and they often covered each other).
- Replace **one photo at a time** or **all together**; an **Interval** slider
  and a **Randomness** slider (so swaps don't tick like a clock). Loops stay
  seamless.

## 6. Photo wall  ✅ built (v0.4.0)
- Photos are pasted on top of each other at random spots; the wall keeps
  filling up and new photos cover older ones.
- Settings: photos kept on the wall, photo size, interval, randomness.
- With **Loop** on the wall starts full; with Loop off it starts empty.

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
- v0.2.0 — background music + fixed total length, title cards, photo borders, collage mode.
- v0.2.1 — collage black-preview fix.
- v0.3.0 — tabbed settings, New button, WTAV branding, app icon, About dialog.
- v0.3.1 — licensing + demo mode. v0.3.2 — start-up update check. v0.3.3 — better face detection (SSD MobileNet).
- v0.4.0 — **Multi-photo** section replaces "Collage": Collage grid (side by side, no overlap,
  one-at-a-time / all-together, interval + randomness) and new **Photo wall** mode. Old project
  files with the v0.2 collage settings load as Collage grid.
