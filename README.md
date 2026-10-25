# Wishes Audio Editor

A browser-first, accessible, multitrack audio editor that runs entirely in your browser. No fake waveforms or placeholder exports — every control does real work.

**Live demo:** enable GitHub Pages for the `main` branch (or deploy `dist/` to any static host). The app is a static Vite site with no required server.

## What it does

- **Home:** Upload Audio (WAV, MP3, M4A/AAC, OGG, FLAC where the browser decoder supports them), Upload Video (MP4/WebM) with real audio extraction, Merge Audio, Remove Silence, Multitrack Editor, Record Voice, Karaoke Recording, Open Recent Project.
- **Multitrack Studio:** Voice 1–4 + unlimited tracks, rename/select/duplicate/delete/mute/solo/volume, numeric start/duration fields (no drag-only editing), zoom, synchronized playback with a single Web Audio clock, undo/redo, autosave to IndexedDB.
- **Transport:** Play/Pause/Stop/Skip backward/forward (configurable, default 5s)/Seek/Restart with clamping and proper cleanup on close.
- **Pitch (tempo preserved):** Real phase-vocoder pitch shifting per track, -24 to +24 semitones, tested at -12/-3/0/+3/+4/+7/+12. Zero is bit-exact. Volume/sample-rate/duration/stereo are preserved.
- **Human Voice Processing:** Real ON/OFF toggle. Turning it ON runs the actual separator (local approximate: STFT + REPET-style background estimate + stereo-centre + harmonic-salience mask, or a connected Demucs server), then pitch-shifts **only** the isolated vocal (tempo preserved) and mixes it back with the untouched accompaniment; the original asset is never modified, so A/B comparison is always possible. Turning it OFF uses ordinary whole-track processing. It reports real confidence and the limits of the method — this is never presented as a filter or a checkbox.
- **Harmonization:** A dedicated panel with the named interval presets (Original +0, minor third +3, major third +4, perfect fifth +7) and free custom intervals including negative semitones. **Preset A = +0/+4/+7** and **Preset B = +0/+3/+7** load a voice list you can edit: enable/disable each voice, set its volume, interval, target track, and preview before applying. The **+0 voice is the original-pitch voice and reuses the source audio** — no duplicated audio is rendered unless you explicitly tick "create a separate track for the original voice". Apply renders every other voice with the phase vocoder (tempo and duration preserved) onto Voice 2, Voice 3, Voice 4 … (created on demand), as one undoable step. Each applied voice can be independently previewed, muted, soloed, gain-adjusted, offset in time, given reverb/echo (re-rendered on demand), duplicated and deleted.
- **Harmonization scope:** **Entire Song** processes the complete media duration (a 3:32 song is processed as 212 s, from the first sample to the last, not just the visible waveform or the playhead). **Selected Time Range** takes exact start/end times (e.g. `00:05.000`–`00:25.000`), validates them against the real decoded media duration, and changes only that interval; outside it the untouched source keeps playing, so nothing is duplicated. A scope summary is shown before applying.
- **Time-range effects:** Numeric Start/End (e.g., 00:05.000–00:25.000), Apply to Selection only, with tail handling: pitch, harmony, reverb, echo/delay, EQ, volume, fade in/out, noise reduction.
- **Record/Karaoke:** Real `AudioWorklet` PCM capture (ScriptProcessor fallback), device selection, count-in, level meter, headphone monitoring toggle, retake, synchronized playback.
- **Merge & Silence:** Real sample-accurate merging, gap/overlap, sequential/timeline; real RMS-based silence detection with threshold/min-duration/preserve, preview and selective removal.
- **Library:** Project title, media refs, track order/volume/pitch/effects/harmony, timeline edits/selection/recordings/export prefs, duration/last-modified, persistent via IndexedDB, restore editable state (not just a thumbnail).
- **Export:** Real encoders — WAV (16/24/32), MP3 via LAME (`@breezystack/lamejs`), AAC/M4A via `MediaRecorder` when available (otherwise disabled with explanation; no fake renames). Scope: project/range/track/stems, sample-rate/bit-depth/bitrate/stereo, normalize, soft limiter, progress/cancel, file size, download with URL cleanup.
- **Settings:** Skip interval, master volume, max file size, default export, Demucs server URL, theme/high-contrast/reduce-motion, storage management, Privacy Policy & Terms (accurate to the implementation), app info.

## Architecture

- **Browser-first:** Web Audio for sync, IndexedDB for projects/assets, Web Workers optional for DSP, LAME for MP3.
- **DSP:** Windowed-sinc resampling, Hann-window phase vocoder (2048-point FFT) with **identity phase locking** and edge-safe overlap-add normalisation (no end-of-buffer spikes, no level drop on amplitude-modulated voices), biquad EQ, feedback delay, Schroeder reverbs, spectral-gate noise reduction, real WAV encode/decode.
- **Pitch shifting:** resample to move the pitch, then restore the duration with the phase vocoder — playback rate is never used as a substitute, so tempo and timing are preserved. Zero semitones is bit-exact.
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

135 tests across 17 files. The harmonization suite runs against an **actual 3:32 (212 s) stereo WAV file written to disk and read back**:

- Entire Song processes the full 212 s, and the last 10 s really is pitch-shifted (proving the tail is not skipped).
- Selected-range processing leaves every sample outside the range untouched (bit-identical) or silent for a voice layer, and shifts only inside it.
- +0 is bit-exact; +3/+4/+7 and -3/-7 land on the expected frequencies with unchanged duration and no level drop.
- Human Voice Processing changes the vocal pitch while the accompaniment stays within ±10% of its original level; with it OFF the whole track moves.
- Both harmony presets load the right intervals, each voice can be disabled independently, and the +0 voice never allocates duplicate audio.
- Exported WAV bytes, decoded back, contain the real processed sound (not the original pitch).
- Save/reopen preserves every harmony voice's interval, gain, mute, solo, offset, scope, effects and its track arrangement.

Also covered: decoding/validation, tempo preservation, track sync/selection, range effects, recording helpers, merge/silence, export encoding, accessibility labels, and error/large-file handling.

## Remaining work for you

1. Enable Pages: repo Settings → Pages → Source: GitHub Actions (or push `dist/` to `gh-pages`).
2. Optional: deploy `server/` for high-quality Demucs separation and set its URL in the app.
3. Verify microphone on your target Android tablet with the installed browser build.
