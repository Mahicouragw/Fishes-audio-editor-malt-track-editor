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
- **Restore the vocal tract.** A log-magnitude spectral envelope of the source (harmonic peaks only — see defect 5 below — smoothed with a kernel sized to the singer's harmonic spacing) is applied to the shifted signal frame by frame: `gain(f) = exp(env(f) − env(f / ratio))`, with cuts allowed down to −48 dB and boosts capped at +18 dB. Only magnitudes change — never phases — so the correction cannot create overlap-add cancellation. `formantPreserve = 0` deliberately disables this and reproduces the old "tape speed" behaviour for A/B comparison.
- **Loudness match.** One broadband gain keeps the whole rendered voice at the source's RMS, so a harmony voice cannot jump in volume or sit at a different level from the lead.

### The second half of the chipmunk bug (fixed in this change)

Restoring the envelope is only correct if the envelope itself is measured
correctly. Five defects in that measurement made the **+7** voice sound like a
chipmunk while +3/+4 almost passed — exactly the pattern reported:

1. **The correction was clamped at −18 dB.** The correction is
   `env(f) − env(f / ratio)`; for a fifth the vocal-tract response falls so
   steeply that the correct cut above 3.5 kHz is 30 dB or more. A flat −18 dB
   gain where the singer had already rolled off left the whole top octave
   transposed.
2. **Above the last detected harmonic the envelope was held flat.** That told
   the correction there was as much energy at 8 kHz as at 4 kHz. The envelope
   now continues with the slope of the last few harmonics (clamped to a
   plausible vocal roll-off).
3. **One average envelope for the whole song.** A single curve measured over
   every vowel of a song is a compromise vowel shape. Each frame is now
   corrected from *that frame's* source envelope (frequency-smoothed, and
   blended over ~30 ms in time so vibrato cannot pump it). On a vowel whose
   formants move, the second formant is now tracked to within 20 % at its
   fastest point where the single average curve is off by 45-53 %.
4. **The time-stretch faded its own first/last 93 ms**, so every harmony voice
   lost the attack of its consonants (a 62 ms fade-in). The shifter now pads
   its input and trims the padding after resampling; the attack measures 0.89×
   the source instead of 0.0× for the first 62 ms.
5. **The analyser was following the window sidelobes.** A Hann-windowed tone
   has hundreds of tiny local maxima 30-50 dB below each partial, and the
   analyser accepted every local maximum as an envelope point. Between two real
   harmonics the measured "envelope" therefore dived into the noise floor, and
   the correction built from it became a comb: alternate partials of the
   shifted voice were boosted 10 dB and the next ones cut 10 dB. The formant
   *positions* looked right on a smoothed curve while the voice sounded
   metallic. The analyser now estimates the singer's harmonic spacing
   (autocorrelation, median of five frames) and only accepts a peak that is the
   loudest bin in its own harmonic slot; the surviving points are interpolated
   and smoothed with a Gaussian of 0.35 × the spacing.

A sixth, smaller decision: material with fewer than six partials (a test tone,
a bass line, a whistle) has no formant structure to restore, and applying a
vocal-tract curve to it only changes its level (measured −3.2 dB on a sine).
The shifter skips the restoration there and leaves such material's level alone.

### Measured result (tests: `src/audio/formantShift.test.ts`, `src/audio/humanVoice.test.ts`)

All numbers below are produced by the shipping code, on a synthetic vowel with
real formants at 600 / 1200 / 2600 Hz and a natural glottal tilt.

| interval | plain resample: to singer / to moved | formant-preserved: to singer / to moved | brightness above 4 kHz (vs singer) | centroid (vs singer) |
|---|---|---|---|---|
| +3 | 12.1 dB / **2.4 dB** | **2.7 dB** / 9.8 dB | +1.8 dB | 1.02× |
| +4 | 14.9 dB / **2.5 dB** | **2.9 dB** / 12.0 dB | +2.1 dB | 0.91× |
| +7 | 18.0 dB / **2.7 dB** | **3.2 dB** / 14.0 dB | +1.3 dB | 0.91× |

For comparison, the plain resample at +7 (the old behaviour, still available as
`formantPreserve = 0` for A/B listening) measures **+9.8 dB** of added
high-frequency energy and a **1.50×** spectral centroid: that is the chipmunk
signature.

The lower the error against the singer's formants and the higher against the
"formants moved" hypothesis, the more clearly the voice is a natural voice of
the same size. A plain resampler scores the other way round, which is the
chipmunk.

Presets A (major) and B (minor), measured voice by voice through the same job
the panel and the worker run:

| voice | error to the singer's formants | error if the shift had moved them | strongest partial near 600 Hz | brightness vs singer |
|---|---|---|---|---|
| A major third +4 | **2.9 dB** | 12.0 dB | 554 Hz | +2.1 dB |
| A fifth +7 | **3.2 dB** | 14.0 dB | 659 Hz | +1.3 dB |
| B minor third +3 | **2.7 dB** | 9.8 dB | 523 Hz | +1.8 dB |
| B fifth +7 | **3.2 dB** | 14.0 dB | 659 Hz | +1.3 dB |

The singer's first formant is at 600 Hz. A plain resampler puts the +7 voice's
at 899 Hz; here the loudest partial near it is 659 Hz, one 330 Hz harmonic away.
The four-voice preset mix stays inside full scale after the limiter (peak
0.44 at the presets' own 30-40 % voice gains, RMS unchanged), and the lead's
samples pass through bit-exactly.

Pitch accuracy is within 0.01 % of `2^(semis/12)` at +3/+4/+7/−3/−7, duration
and sample rate are exactly preserved, RMS stays within 0.7–1.3 of the source,
and zero semitones is bit-exact. A flat-spectrum pulse train keeps every
partial within ±0.7 dB through a +7 shift, so no harmonic is dropped or doubled.

### Honest limit

The correction is a *smooth envelope*: it re-levels each harmonic but cannot
invent partials between the harmonics of a sparse spectrum. Two limits are
worth naming:

- **Boosts are capped at +18 dB** (cuts are allowed far deeper, because a cut
  cannot amplify noise). When a shifted partial comes from a part of the
  singer's spectrum far quieter than where it lands — typically the top of the
  second formant — the voice is left a few dB *duller* than ideal rather than
  boosted into hiss. That is why the preserved +4/+7 voices measure a 0.91×
  spectral centroid: about 9 % darker than the singer, the opposite error to
  the old chipmunk.
- **It cannot create a second singer.** Preset C is a doubler (detune + delay),
  not a second take.

The tests assert these numbers, not perfection.

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

## 10. Playback, pause and TalkBack

- **One clock.** `PlaybackEngine` schedules every clip against a single
  `AudioContext` time. `pause()` stops the sources, keeps the exact playhead and
  pushes it to React; `resume()` re-schedules from that sample. A request token
  makes a `play()` that is still waiting for the audio context to wake up
  harmless, so pressing Play or Resume twice can never start a second copy.
- **Playhead display is throttled** to 5 updates per second and is **not** a live
  region. The same is true of progress percentages and the recording timer.
  This is the fix for the TalkBack problem where the cursor could not move while
  audio played: a polite live region that changes 25 times a second keeps the
  screen reader talking forever. Only one event-based announcement channel
  remains ("Playing from 0:12", "Paused at 0:12", "Resumed playback",
  "Stopped", "Playing preview: …").
- **Pause is always reachable**: the transport's main button reads
  *Pause playback* / *Resume playback* / *Play*, and the harmonization panel
  shows *Pause preview* / *Resume preview* / *Stop preview* right next to the
  Preview button while a preview is playing, without moving focus anywhere.
- No code path calls `.focus()` or scrolls the page during playback, so nothing
  moves the TalkBack cursor.
