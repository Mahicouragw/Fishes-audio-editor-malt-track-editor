# Wishes Audio Editor

A browser-first, accessible, multitrack audio editor that runs entirely in your browser. No fake waveforms or placeholder exports — every control does real work.

**Live demo:** <https://mahicouragw.github.io/Fishes-audio-editor-malt-track-editor/> — published by GitHub Actions. Pushes to `main` and to `arena/*` work branches both publish; see `ENABLE_PAGES.md`.

## What it does

- **Home:** Upload Audio (WAV, MP3, M4A/AAC, OGG, FLAC where the browser decoder supports them), Upload Video (MP4/WebM) with real audio extraction, Merge Audio, Remove Silence, Multitrack Editor, Record Voice, Karaoke Recording, Open Recent Project.
- **Multitrack Studio:** Voice 1–4 + unlimited tracks, rename/select/duplicate/delete/mute/solo/volume, numeric start/duration fields (no drag-only editing), zoom, synchronized playback with a single Web Audio clock, undo/redo, autosave to IndexedDB.
- **Transport:** Play/Pause/Stop/Skip backward/forward (configurable, default 5s)/Seek/Restart with clamping and proper cleanup on close.
- **Pitch (tempo preserved, formant preserved):** Real spectral pitch shifting per track, -24 to +24 semitones, tested at -12/-3/0/+3/+4/+7/+12. **Formants stay at the singer's frequencies** — the shifter never resamples the dry signal, so it cannot turn a voice into a chipmunk (see `HARMONIZATION.md` for the measured before/after). Zero semitones is bit-exact; duration, sample rate and stereo balance are preserved, and the level is matched frame by frame.
- **Human Voice Processing:** Real ON/OFF toggle. Turning it ON runs the actual separator (local approximate: STFT + REPET-style background estimate + stereo-centre + harmonic-salience mask, or a connected Demucs server), then pitch-shifts **only** the isolated vocal (tempo preserved) and mixes it back with the untouched accompaniment; the original asset is never modified, so A/B comparison is always possible. Turning it OFF uses ordinary whole-track processing. It reports real confidence and the limits of the method — this is never presented as a filter or a checkbox.
- **Harmonization:** Three editable presets — **A: +0/0 ms/100 %, +4/23 ms/30 %, +7/49 ms/40 %, +0/33 ms/30 %**; **B: +0/0/100 %, +3/23/30 %, +7/19/40 %, +0/5/30 %**; **C: natural double-tracking**, four +0 voices at 0/12/24/36 ms and 100/30/25/20 %.** Every pitch, cent-detune, delay, volume, pan, target track and effect is editable. Applying renders real audio onto tracks created on demand, as one undoable step. The **+0 lead reuses the source audio** (bit-identical) and each +0 *double* is micro-detuned so it cannot comb-filter the lead. Applied voices can be previewed, muted, soloed, panned, delayed, gain-adjusted, re-rendered with reverb/echo, duplicated and removed.
- **Per-track stereo pan:** L / C / R buttons plus a fine −100…+100 slider with spoken labels, applied with a constant-power law in **both** live playback and the exported file. Resolution order is harmony-layer pan → clip pan → track pan. Mono exports have no stereo field and say so.
- **Lead duplicates:** “Duplicate lead (unprocessed)” copies the selected track onto a new track with zero pitch, no effects, no vocal processing and untouched clip timing, ready to be panned or delayed as a double.
- **A/B listening:** mute all harmony voices to hear the original, restore them, solo the harmony, or compare processed vs original per track.
- **Harmonization scope:** **Entire Song** processes the complete media duration (a 3:32 song is processed as 212 s, from the first sample to the last). **Selected Time Ranges** accepts any number of non-contiguous ranges (00:05–00:25, 01:25–01:35, 02:25–02:35, 03:10–03:20, …): add, edit, enable/disable and remove each one with numeric time fields, validated against the real decoded duration. Only samples inside enabled ranges are processed — each is rendered with its own context and short edge fades, and everything outside is digital silence, verified sample by sample. Delays never lengthen the song.
- **Key & scale:** choose the song key and major/minor scale; intervals that fall outside the key are flagged with a concrete suggestion ("+3 is outside C major — suggested +4") and can be snapped, while the lead stays at its original pitch.
- **Time-range effects:** Numeric Start/End (e.g., 00:05.000–00:25.000), Apply to Selection only, with tail handling: pitch, harmony, reverb, echo/delay, EQ, volume, fade in/out, noise reduction.
- **Record/Karaoke:** Real `AudioWorklet` PCM capture (ScriptProcessor fallback), device selection, count-in, level meter, headphone monitoring toggle, retake, synchronized playback.
- **Merge & Silence:** Real sample-accurate merging, gap/overlap, sequential/timeline; real RMS-based silence detection with threshold/min-duration/preserve, preview and selective removal.
- **Library:** Project title, media refs, track order/volume/pitch/effects/harmony, timeline edits/selection/recordings/export prefs, duration/last-modified, persistent via IndexedDB, restore editable state (not just a thumbnail).
- **Export:** Real encoders — WAV (16/24/32), MP3 via LAME (`@breezystack/lamejs`), AAC/M4A via `MediaRecorder` when available (otherwise disabled with explanation; no fake renames). Scope: project/range/track/stems, sample-rate/bit-depth/bitrate/stereo, normalize, soft limiter, progress/cancel, file size, download with URL cleanup.
- **Settings:** Skip interval, master volume, max file size, default export, Demucs server URL, theme/high-contrast/reduce-motion, storage management, Privacy Policy & Terms (accurate to the implementation), app info.

## Architecture

- **Browser-first:** Web Audio for sync, IndexedDB for projects/assets, Web Workers optional for DSP, LAME for MP3.
- **DSP:** Windowed-sinc resampling, Hann-window phase vocoder (2048-point FFT) with **identity phase locking** and edge-safe overlap-add normalisation (no end-of-buffer spikes), biquad EQ, feedback delay, Schroeder reverbs, spectral-gate noise reduction, real WAV encode/decode.
- **Pitch shifting:** time-stretch → resample → **re-impose the source spectral envelope** (`src/audio/formant.ts`). Tempo and duration are restored exactly, and the formants stay where the singer put them; `formantPreserve: 0` keeps the raw transposition as an honest A/B reference. See `HARMONIZATION.md`.
- **Mixdown:** one shared constant-power pan law in playback and export, per-frame loudness matching, layer/clip/track pan resolution, layer gain, mute/solo, master fader and a soft limiter.
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

174 tests across 20 files (`npx vitest run`). The harmonization suite runs against an **actual 3:32 (212 s) stereo WAV file written to disk and read back**:

- Entire Song processes the full 212 s, and the last 10 s really is pitch-shifted (proving the tail is not skipped).
- Selected-range processing leaves every sample outside the range untouched (bit-identical) or silent for a voice layer, and shifts only inside it.
- +0 is bit-exact; +3/+4/+7 and -3/-7 land on the expected frequencies with unchanged duration and no level drop.
- Human Voice Processing changes the vocal pitch while the accompaniment stays within ±10% of its original level; with it OFF the whole track moves.
- All three presets load their exact pitch/delay/volume values, each voice can be disabled independently, and the +0 lead never allocates duplicate audio.
- Preset C's doubles add level instead of comb-filtering the lead.
- Every listed range is shifted independently and the gaps between them are **digitally silent**, with fades at the boundaries.
- Formant preservation beats raw transposition (0.56 vs 0.25 envelope correlation at +7), pitch lands within 0.01 %, and level stays in 0.7–1.3×.
- Pan is real: a hard-left exported track leaks < 1e-9 into the right channel, centre is bit-identical, and the live playback graph uses the matching constant-power compensation.
- Exported WAV bytes, decoded back, contain the real processed sound (not the original pitch).
- Save/reopen preserves every harmony voice's interval, gain, mute, solo, offset, scope, effects, pan, ranges, key/scale and its track arrangement.
- Undo/redo runs in order across pan, key, preset and range edits, coalesces slider drags, and **the history stacks are restored when a saved project is reopened**.
- An unprocessed lead duplicate really is unprocessed: zero pitch, zero cents, no effects, same asset and timing.

Also covered: decoding/validation, tempo preservation, track sync/selection, range effects, recording helpers, merge/silence, export encoding, accessibility labels, and error/large-file handling.

The engine's behaviour and limits, including the corrected root cause of the old chipmunk sound, are documented in [`HARMONIZATION.md`](HARMONIZATION.md).

## Remaining work for you

1. Pages is already enabled (GitHub Actions source) and the live site tracks the latest deploy; see `ENABLE_PAGES.md`.
2. Optional: deploy `server/` for high-quality Demucs separation and set its URL in the app.
3. Verify microphone on your target Android tablet with the installed browser build.
