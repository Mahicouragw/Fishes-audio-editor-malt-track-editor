# Wishes Audio Editor

A browser-first, accessible, multitrack audio editor that runs entirely in your browser. No fake waveforms or placeholder exports — every control does real work.

**Live demo:** enable GitHub Pages for the `main` branch (or deploy `dist/` to any static host). The app is a static Vite site with no required server.

## What it does

- **Home:** Upload Audio (WAV, MP3, M4A/AAC, OGG, FLAC where the browser decoder supports them), Upload Video (MP4/WebM) with real audio extraction, Merge Audio, Remove Silence, Multitrack Editor, Record Voice, Karaoke Recording, Open Recent Project.
- **Multitrack Studio:** Voice 1–4 + unlimited tracks, rename/select/duplicate/delete/mute/solo/volume, numeric start/duration fields (no drag-only editing), zoom, synchronized playback with a single Web Audio clock, undo/redo, autosave to IndexedDB.
- **Transport:** Play/Pause/Stop/Skip backward/forward (configurable, default 5s)/Seek/Restart with clamping and proper cleanup on close.
- **Pitch (tempo preserved):** Real phase-vocoder pitch shifting per track, -24 to +24 semitones, tested at -12/-3/0/+3/+4/+7/+12. Zero is bit-exact. Volume/sample-rate/duration/stereo are preserved.
- **Human Voice Processing:** Real ON/OFF toggle, local approximate separation (STFT + REPET + stereo + harmonic cues) with quality/warning, vocal/instrumental stems, vocal-only pitch (tempo-preserved or resample), volume, mix, restore. Not a simple EQ/filter — and it says so.
- **Harmony:** Real processed layers (e.g., +3/+4/+7/-3/-4/-7 plus custom -24…+24), per-layer mute/duplicate/remove, optional vocals-only.
- **Time-range effects:** Numeric Start/End (e.g., 00:05.000–00:25.000), Apply to Selection only, with tail handling: pitch, harmony, reverb, echo/delay, EQ, volume, fade in/out, noise reduction.
- **Record/Karaoke:** Real `AudioWorklet` PCM capture (ScriptProcessor fallback), device selection, count-in, level meter, headphone monitoring toggle, retake, synchronized playback.
- **Merge & Silence:** Real sample-accurate merging, gap/overlap, sequential/timeline; real RMS-based silence detection with threshold/min-duration/preserve, preview and selective removal.
- **Library:** Project title, media refs, track order/volume/pitch/effects/harmony, timeline edits/selection/recordings/export prefs, duration/last-modified, persistent via IndexedDB, restore editable state (not just a thumbnail).
- **Export:** Real encoders — WAV (16/24/32), MP3 via LAME (`@breezystack/lamejs`), AAC/M4A via `MediaRecorder` when available (otherwise disabled with explanation; no fake renames). Scope: project/range/track/stems, sample-rate/bit-depth/bitrate/stereo, normalize, soft limiter, progress/cancel, file size, download with URL cleanup.
- **Settings:** Skip interval, master volume, max file size, default export, Demucs server URL, theme/high-contrast/reduce-motion, storage management, Privacy Policy & Terms (accurate to the implementation), app info.

## Architecture

- **Browser-first:** Web Audio for sync, IndexedDB for projects/assets, Web Workers optional for DSP, LAME for MP3.
- **DSP:** Windowed-sinc resampling, Hann-window phase vocoder (2048-point FFT), biquad EQ, feedback delay, Schroeder reverbs, spectral-gate noise reduction, real WAV encode/decode.
- **Vocal separation:** Local approximate (documented) + optional Demucs server (`server/`). See `server/README.md` for setup, `POST /separate`, randomized job IDs, cleanup, and FFmpeg prerequisites.

## Development

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # vitest
npm run build    # dist/
```

`base: './'` in `vite.config.ts` works both at domain root and GitHub Pages project paths.

## Vocal separation server (optional)

```bash
cd server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000
# then paste http://localhost:8000 into Settings → Demucs server URL
```

GitHub Pages cannot run Python — deploy the server to Fly.io/Render/Railway/etc. if you need hosted separation.

## Accessibility

Dark charcoal studio theme with purple accents, large transport, keyboard/focus order, semantic buttons, `aria-label`/`aria-pressed`/`aria-selected`/`role=switch`, live announcements, 44px targets, reduced-motion support, no focus-stealing waveforms.

## Tests

Automated tests cover decoding/validation, pitch accuracy & tempo preservation, track sync/selection, vocal ON/OFF, harmony intervals, range effects (validation, outside-preservation, tails), recording helpers, save/reopen, merge/silence, export encoding, accessibility labels, and error/large-file handling.

## Remaining work for you

1. Enable Pages: repo Settings → Pages → Source: GitHub Actions (or push `dist/` to `gh-pages`).
2. Optional: deploy `server/` for high-quality Demucs separation and set its URL in the app.
3. Verify microphone on your target Android tablet with the installed browser build.
