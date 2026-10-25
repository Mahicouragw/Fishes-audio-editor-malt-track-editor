# Harmonization: how it works, and what it genuinely cannot do

This document describes the harmonization engine that ships in the Multitrack Studio panel. It is written to be checkable: every claim below is covered by a test in `src/**/*.test.ts(x)`.

## 1. The chipmunk bug and its real cause

The previous pitch shifter did this:

1. resample the signal by `1 / ratio` (a very ordinary resampler), then
2. time-stretch the result back to the original duration with a phase vocoder.

Tempo and duration came back, but resampling transposes **every partial and every vocal-tract resonance**. Formant frequencies are what make a voice sound like a human of a certain size; when they move up with the pitch, the result is the "chipmunk" sound. No amount of preset naming or UI wording can hide that.

## 2. The fix (in `src/audio/formant.ts`)

`pitchShift()` now calls `pitchShiftFormant()`:

- **Shift without changing duration.** The signal is time-stretched by `ratio` (phase vocoder with identity phase locking) and then *resampled* by `1 / ratio`. The final length is exactly the input length, so tempo and timing are untouched. Resampling a stretched buffer keeps every analysis/synthesis window looking at a real sinusoid, so the level survives (measured amplitude ratio ≈ 1.0 instead of the 0.2–0.6 an STFT bin-remapping shifter produced in testing).
- **Restore the vocal tract.** The average spectral envelope (log-magnitude, harmonic-peak interpolation, ±18 dB clamp) of the source is applied to the shifted signal: `gain(f) = exp(env(f) − env(f / ratio))` with a smoothed static curve. Only magnitudes change — never phases — so the correction cannot create overlap-add cancellation. `formantPreserve = 0` deliberately disables this and reproduces the old "tape speed" behaviour for A/B comparison.
- **Loudness match.** A per-frame energy-normalisation pass keeps each frame at the level of its source frame, so a harmony voice cannot suddenly jump in volume.

### Measured result (test: `src/audio/formantShift.test.ts`)

For a +7 semitone shift of a synthetic vowel with formants at 700 Hz and 1200 Hz:

| setting | envelope correlation with the *original* formants | with the *transposed* formants |
|---|---|---|
| `formantPreserve = 1` (default) | **0.56** | 0.25 |
| `formantPreserve = 0` (A/B reference) | 0.26 | **0.55** |

Pitch accuracy is within 0.01 % of `2^(semis/12)` at +3/+4/+7/−3/−7, duration and sample rate are exactly preserved, RMS stays within 0.7–1.3 of the source, and zero semitones is bit-exact.

### Honest limit

The correction is a *smooth envelope*: it re-levels each harmonic but cannot invent missing partials between harmonics. For sparse material (a high solo voice with wide harmonic spacing) it reduces but does not eliminate the "smaller voice" impression. The test above asserts the improvement, not perfection.

## 3. The presets (`src/audio/harmony.ts`)

| Preset | Voice | Pitch | Delay | Starting volume |
|---|---|---|---|---|
| **A — Major-style harmony** | Voice 1 – original lead | +0 | 0 ms | 100 % |
| | Voice 2 | +4 | 23 ms | 30 % |
| | Voice 3 | +7 | 49 ms | 40 % |
| | Voice 4 – double | +0 (detuned −6 ¢) | 33 ms | 30 % |
| **B — Alternative harmony** | Voice 1 – original lead | +0 | 0 ms | 100 % |
| | Voice 2 | +3 | 23 ms | 30 % |
| | Voice 3 | +7 | 19 ms | 40 % |
| | Voice 4 – layer | +0 (detuned +5 ¢) | 5 ms | 30 % |
| **C — Natural double-tracking** | Voice 1 – original lead | +0 | 0 ms | 100 % |
| | Voice 2 – double | +0 (−6 ¢) | 12 ms | 30 % |
| | Voice 3 – double | +0 (+7 ¢) | 24 ms | 25 % |
| | Voice 4 – double | +0 (−9 ¢) | 36 ms | 20 % |

Every value is editable in the panel (semitone, cents, delay in ms, volume, pan, target track, effects, enabled). Applying a preset creates the required tracks on demand, renders real audio, and is a single undoable step.

**Why the +0 layers are detuned.** A plain delayed copy of the lead is a comb filter: it cancels some frequencies and boosts others (flanging). Detuning each double by a few cents de-correlates it so the sum sounds like a second singer, not a flanger. Preset C is a vocal *doubler*; a genuine second take cannot be invented from one recording, and the UI says so.

## 4. Panning

Constant-power pan, normalised to unity at the centre:

```
angle = (pan + 1) * π / 4
left  = cos(angle) * √2      right = sin(angle) * √2
centre → [1, 1]   hard left → [1.414, 0]   hard right → [0, 1.414]
```

- Export: `mixEntries` multiplies each stereo channel by the law. A mono export has no stereo field, so pan is ignored there and the UI states it.
- Playback: a per-clip `StereoPannerNode` (with the √2 compensation) gives the same law live, so what you hear is what is exported.
- Resolution order: harmony layer pan → clip pan → track pan.
- Track pan writes a real signal change, not an indicator: `src/audio/panAndMix.test.ts` checks the exported channel energies.

## 5. Ranges, key and scale

- **Entire Song** processes every sample of the source, including the last.
- **Selected Time Ranges** accepts any number of non-contiguous ranges (e.g. 00:05–00:25, 01:25–01:35, 02:25–02:35, 03:10–03:20). Each range is rendered from its own slice with 4096 samples of context; only the selected samples are mixed back, with short raised-cosine fades inside the range so boundaries cannot click. Outside the ranges the harmony clip is digital silence, which the tests verify sample-by-sample.
- **Key/scale** (major or minor) is used to *warn*, not to silently rewrite: a preset interval outside the key shows "`+3` is outside C major — suggested `+4`". The "Snap to key" button applies the suggestion to every harmony voice; the lead is never transposed by it.
- Delays never lengthen the song: the harmony clip starts later and its tail is trimmed at the original end.

## 6. Undo/redo

Every edit (apply/remove, interval, delay, volume, pan, mute/solo, add/duplicate/delete track, add/remove range, key/scale, preset load, effects) pushes one history entry. Slider drags coalesce per control within 900 ms, so a pan sweep is one undo step. The stacks are persisted in IndexedDB with the project and restored on reopen (`harmonyStore.master.test.tsx`).

## 7. Accessibility (TalkBack on Android)

- Each control has a label that includes its current value, e.g. "Harmony voice 2 pitch, plus 4 semitones", "Voice 2 pan, 50 percent left", "Applied voice 1 delay, 250 milliseconds".
- Every status change (preset loaded, range added, apply finished, failure) is written to `role="status"` / `aria-live` regions.
- Ranges and voices are real lists; controls are semantic buttons, checkboxes, spinbuttons and sliders in DOM order.
- Nothing depends on colour, waveform position or gestures. Numeric fields accept typed values (seconds, milliseconds, semitones, cents).
- Touch targets are ≥44 px (see `src/styles.css`).

## 8. Export

The export path is the same chain as playback: committed pitch, vocal separation, range effects, fades, harmony volume/mute/solo, pan, delay placement, track volume, master fader, then the optional limiter. WAV and MP3 are real encoders; AAC is offered only when the browser exposes `MediaRecorder`. There is no renamed-WAV fallback.

## 9. What still depends on the environment

- **Vocal separation.** The in-browser separator is a documented approximation (STFT + REPET-style background estimate + stereo-centre + harmonic-salience mask). A Demucs server (`server/`) gives better stems. GitHub Pages cannot run Python, so a hosted server must be deployed separately; when no separation exists the panel *disables* Human Voice Mode and offers to run separation rather than pretending.
- **Real-time browser panning** requires `StereoPannerNode` (all current browsers); the code falls back to centred playback on an engine without it, and export is unaffected.
- **TalkBack testing** needs a physical Android device; the automated tests verify the accessible names, roles and announcements, not the screen-reader's speech output.
