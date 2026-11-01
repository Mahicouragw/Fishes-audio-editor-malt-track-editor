import type { AudioData } from '../types';
import type { ProgressFn } from './dsp';
import { audioData, resampleByRatio, timeStretch, cloneAudio } from './dsp';
import { fft, ifft } from './fft';

/**
 * Formant-preserving pitch shifting.
 *
 * ## Why the old shifter sounded like a chipmunk
 *
 * The original `pitchShift()` resampled the signal by `1 / ratio` (which
 * transposes every partial **and every vocal-tract resonance**) and then
 * time-stretched it back to the original duration. Playback speed was
 * restored, but the formants had been moved by the pitch ratio — and formant
 * frequencies are exactly what makes a voice sound human rather than like a
 * sped-up recording. No preset label or UI wording can hide that; the spectrum
 * itself has to be repaired.
 *
 * ## What this implementation does
 *
 * 1. **Shift by resampling, not by changing playback rate.** The signal is
 *    time-stretched by `ratio` (a phase vocoder, tempo is only a working
 *    buffer) and then resampled by `1 / ratio`. The final length is exactly
 *    the source length, so tempo and duration are untouched, and the pitch is
 *    exactly `2 ** (semitones / 12)`. Resampling a stretched buffer is the
 *    classic, low-artefact way to transpose: the analysis/synthesis windows
 *    always see real sinusoids, so overlap-add stays coherent and the level is
 *    preserved (measured amplitude ratio ≈ 1.00, see `pitchShiftFormant`
 *    tests). The earlier "shift bins along the frequency axis" version of
 *    this file smeared every spectral lobe and lost up to 12 dB on some
 *    intervals because copied bins no longer formed a valid window lobe.
 *
 * 2. **Put the vocal tract back.** After the resample, the spectral envelope
 *    (formants) sits at `f * ratio`. The correction stage measures the
 *    cepstrally smoothed log envelope of the *source* and of the shifted
 *    frame, and multiplies the shifted spectrum by
 *    `exp(envSource(f) - envSource(f / ratio))`, clamped to ±18 dB. Because the
 *    shift moved the envelope by exactly `ratio`, the target shape at `f` is
 *    the source's own shape at `f / ratio` — no second measurement of the
 *    shifted signal is needed. Only magnitudes change, never phases, so the
 *    correction cannot introduce overlap-add cancellation. The correction is
 *    static in time: a singer's vocal-tract resonances are stable, and a
 *    static curve cannot pump or warble.
 *
 *     - `formantPreserve = 1` (default) keeps the original formants: a 4th
 *       above still sounds like the same singer.
 *     - `formantPreserve = 0` deliberately lets the formants ride with the
 *       pitch (what a tape-speed change does). It is available because it is
 *       the honest A/B reference in the tests, not because it sounds good.
 *
 * ## The measured limit
 *
 * The envelope is measured by interpolating the harmonic peaks, which is exact
 * for a dense harmonic sound and approximate for a sparse comb (a high voice
 * with a wide harmonic spacing): the correction is a smooth curve, so it can
 * put each harmonic at the right level but cannot fill the gaps between
 * harmonics. The spectral centroid, the objective measure of "chipmunk
 * brightness", moves 45 % for a +7 semitone shift with `formantPreserve = 0`
 * and about 28 % with `formantPreserve = 1` on a test vowel — clearly better,
 * not mathematically perfect. The tests assert exactly these numbers.
 *
 * 3. **Stereo is kept.** Each channel is shifted with the same settings, and the
 *    resampling stage is exactly linear, so the level ratio between the
 *    channels — which is what a pan actually is — survives the shift.
 */

export interface FormantPitchOptions {
  /** 0…1. 1 keeps the original formant frequencies, 0 transposes them. */
  formantPreserve?: number;
  onProgress?: ProgressFn;
  /** Analysis/synthesis hop for the correction stage. */
  hop?: number;
  /** FFT size (power of two) for the correction stage. */
  frameSize?: number;
  /** Cepstral lifter cutoff in milliseconds (envelope smoothness). */
  formantCutoffMs?: number;
  /** Gain limits for formant correction, in linear gain. */
  formantGainMin?: number;
  formantGainMax?: number;
  /** Match the shifted signal's overall loudness to the source (default true). */
  loudnessMatch?: boolean;
  /**
   * `per-frame` (default) measures the formants of every frame of the source,
   * so a harmony voice follows the singer from vowel to vowel. `static` uses a
   * single song-wide average curve; it is kept as the honest A/B reference for
   * the tests (it blurs every vowel into one shape).
   */
  envelope?: 'per-frame' | 'static';
}

/** Floor used for log magnitudes and for envelope smoothing. */
const LOG_FLOOR = 1e-7;

export function hann(size: number): Float64Array {
  const window = new Float64Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return window;
}

/**
 * Log spectral envelope of one frame.
 *
 * A cepstral lifter is the textbook tool, but it has a hard limit here: the
 * quefrency cutoff that separates the vocal tract from the pitch comb must sit
 * below the fundamental's period, and for a high female/child voice (≈ 400 Hz)
 * that leaves almost no resolution — the measured "envelope" then follows the
 * individual harmonics instead of the formants (measured swings of ±20 dB at
 * 2.5 ms). Peak interpolation has no such conflict: the envelope of a harmonic
 * sound is, by definition, the curve through its harmonic peaks, so we locate
 * the local maxima and interpolate the log magnitude between them. That curve
 * is smooth, follows the vocal tract, and survives any F0.
 */
export function spectralEnvelope(
  magnitude: Float64Array,
  frameSize: number,
  bins: number,
  sampleRate: number,
  scratchRe: Float64Array,
  scratchIm: Float64Array,
  output: Float64Array,
  cutoffMs = 2.5,
  /**
   * Harmonic spacing in bins (the signal's F0). When known, only true harmonics
   * are accepted as envelope points. Without it the analyser accepts *any*
   * local maximum, and a windowed tone has hundreds of tiny sidelobe maxima
   * between its harmonics that sit 40-60 dB down. Those sidelobes were the
   * remaining cause of an unnatural, metallic +7 voice: the measured "envelope"
   * dived into the noise floor between partials, the correction then boost/cut
   * alternate harmonics (a comb), and the result no longer sounded like a
   * singer even though each partial was at roughly the right level.
   */
  harmonicSpacingBins = 0,
): void {
  void scratchRe; void scratchIm;
  // Ignore the DC area; it carries the signal's offset, not the vocal tract.
  const first = Math.max(2, Math.round((60 * frameSize) / (sampleRate || 44100)));
  let maximum = 0;
  for (let k = first; k < bins; k++) maximum = Math.max(maximum, magnitude[k]);
  const peak: number[] = [];
  const peakValue: number[] = [];
  if (maximum > 0) {
    // A bin is a harmonic peak when it is a local maximum and within 50 dB of
    // the frame's loudest bin. Quiet frames simply have no peaks.
    const threshold = maximum * 10 ** (-50 / 20);
    // With a known harmonic spacing, a peak must also be the loudest bin in its
    // own harmonic slot. Window sidelobes live inside a neighbouring harmonic's
    // slot, so this test rejects them without rejecting quiet real harmonics.
    const slot = harmonicSpacingBins >= 3
      ? Math.max(1, Math.round(harmonicSpacingBins / 2))
      : 0;
    const isSlotMaximum = (k: number) => {
      if (!slot) return true;
      const from = Math.max(first, k - slot);
      const to = Math.min(bins - 1, k + slot);
      for (let index = from; index <= to; index++) {
        if (magnitude[index] > magnitude[k]) return false;
      }
      return true;
    };
    for (let k = Math.max(1, first); k < bins - 1; k++) {
      if (magnitude[k] >= magnitude[k - 1] && magnitude[k] > magnitude[k + 1]
        && magnitude[k] > threshold && isSlotMaximum(k)) {
        // Parabolic refinement of the peak position and level (log domain).
        const left = Math.log(magnitude[k - 1] + LOG_FLOOR);
        const centre = Math.log(magnitude[k] + LOG_FLOOR);
        const right = Math.log(magnitude[k + 1] + LOG_FLOOR);
        const denominator = left - 2 * centre + right;
        const offset = denominator === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / denominator));
        peak.push(k + offset);
        peakValue.push(centre - 0.25 * (left - right) * offset);
      }
    }
  }

  if (!peak.length) {
    for (let k = 0; k < bins; k++) output[k] = Math.log(magnitude[k] + LOG_FLOOR);
    return;
  }
  // Beyond the last detected harmonic peak the curve must keep falling: a flat
  // hold would tell the shifter that the singer has just as much energy at
  // 8 kHz as at 4 kHz, so the transposed top octave would never be turned back
  // down (measured +10 dB of "chipmunk" brightness). Continue with the slope of
  // the last few peaks instead, clamped to a plausible vocal roll-off.
  let highSlope = 0;
  if (peak.length >= 2) {
    const count = Math.min(4, peak.length);
    let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
    for (let i = peak.length - count; i < peak.length; i++) {
      sx += peak[i];
      sy += peakValue[i];
      sxx += peak[i] * peak[i];
      sxy += peak[i] * peakValue[i];
    }
    const denominator = count * sxx - sx * sx;
    const slope = denominator !== 0 ? (count * sxy - sx * sy) / denominator : 0;
    highSlope = Math.max(-0.015, Math.min(0, slope));
  }
  // Interpolate in the log domain between successive peaks.
  let cursor = 0;
  for (let k = 0; k < bins; k++) {
    while (cursor + 1 < peak.length && peak[cursor + 1] <= k) cursor++;
    if (k <= peak[0]) {
      output[k] = peakValue[0];
    } else if (cursor + 1 >= peak.length) {
      output[k] = peakValue[peak.length - 1] + highSlope * (k - peak[peak.length - 1]);
    } else {
      const from = peak[cursor];
      const to = peak[cursor + 1];
      const fraction = to > from ? (k - from) / (to - from) : 0;
      output[k] = peakValue[cursor] * (1 - fraction) + peakValue[cursor + 1] * fraction;
    }
  }
  // Smoothing so the curve cannot develop a comb of its own. Interpolating
  // between harmonic peaks leaves a small sawtooth at the harmonic rate (the
  // peaks do not all sit at the same height), and a correction built from that
  // sawtooth colours the shifted voice. The kernel is therefore wide enough to
  // swallow one harmonic period: a Gaussian of 0.35 × the spacing removes the
  // sawtooth by more than 20 dB while leaving a formant (two or three times
  // wider than the spacing) clearly recognisable.
  const radius = harmonicSpacingBins >= 3
    ? Math.max(2, Math.round(harmonicSpacingBins * 1.05))
    : Math.max(1, Math.round((sampleRate * cutoffMs * 0.001) / 8));
  const sigma = harmonicSpacingBins >= 3 ? harmonicSpacingBins * 0.35 : radius / 2;
  const smoothed = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    let sum = 0;
    let weight = 0;
    for (let d = -radius; d <= radius; d++) {
      const index = k + d;
      if (index < 0 || index >= bins) continue;
      const w = Math.exp(-0.5 * (d / sigma) ** 2);
      sum += output[index] * w;
      weight += w;
    }
    smoothed[k] = weight ? sum / weight : output[k];
  }
  for (let k = 0; k < bins; k++) output[k] = smoothed[k];
}

/**
 * Fundamental frequency of a signal, in Hz, or null when it has no clear pitch.
 *
 * The formant analyser needs to know how far apart the harmonics are: that is
 * the only way it can tell a real harmonic from a window sidelobe. Autocorrel-
 * ation is used (not the spectrum) because it finds the period even when the
 * fundamental itself is weak, and because it does not care what the formants
 * look like. Several frames are measured and the median taken, so a single
 * consonant cannot set the analysis width for the whole song.
 */
export function estimateFundamental(signal: Float32Array, sampleRate: number): number | null {
  const size = 4096;
  if (signal.length < size * 2) return null;
  const minLag = Math.max(2, Math.floor(sampleRate / 800));
  const maxLag = Math.min(size - 2, Math.ceil(sampleRate / 60));
  const estimates: number[] = [];
  const frames = 5;
  for (let f = 0; f < frames; f++) {
    const offset = Math.floor(((signal.length - size) * f) / Math.max(1, frames - 1));
    let energy = 0;
    for (let i = 0; i < size; i++) energy += signal[offset + i] * signal[offset + i];
    if (energy / size < 1e-7) continue;
    // Normalised autocorrelation over the pitch range.
    const correlations = new Float64Array(maxLag + 1);
    let zero = 0;
    for (let lag = 0; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i + lag < size; i++) sum += signal[offset + i] * signal[offset + i + lag];
      correlations[lag] = sum;
      if (lag === 0) zero = sum;
    }
    if (zero <= 0) continue;
    const normalised = new Float64Array(maxLag + 1);
    for (let lag = 0; lag <= maxLag; lag++) {
      // Unbiased: divide by the number of samples that overlapped.
      normalised[lag] = correlations[lag] / ((size - lag) / size) / zero;
    }
    let best = minLag;
    let bestValue = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (normalised[lag] > bestValue) {
        bestValue = normalised[lag];
        best = lag;
      }
    }
    if (bestValue < 0.3) continue;
    // Prefer the shortest period that is nearly as good as the winner: a
    // periodic signal also correlates at 2T, 3T... and picking those would
    // halve the apparent spacing.
    const candidate = normalised[best];
    for (let lag = minLag; lag < best; lag++) {
      if (normalised[lag] >= candidate * 0.9
        && normalised[lag] >= normalised[lag - 1]
        && normalised[lag] >= normalised[lag + 1]) {
        best = lag;
        break;
      }
    }
    estimates.push(sampleRate / best);
  }
  if (!estimates.length) return null;
  estimates.sort((a, b) => a - b);
  return estimates[Math.floor(estimates.length / 2)];
}

/**
 * How many separate partials a signal has in its loudest frames (capped at 32).
 *
 * A voice has dozens; a test tone, a whistle or a sub-bass line has one or two.
 * Formant restoration only makes sense when there is a harmonic series to
 * shape: applying a vocal-tract curve to a single sine can only change its
 * level (measured: −3.2 dB on a 330 Hz tone), which is colouration, not
 * correction. The shifter therefore leaves such material alone.
 */
export function harmonicCount(signal: Float32Array, sampleRate: number, frameSize = 2048): number {
  if (signal.length < frameSize) return 0;
  const bins = frameSize / 2 + 1;
  const magnitude = new Float64Array(bins);
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  const window = hann(frameSize);
  const frames = 5;
  for (let f = 0; f < frames; f++) {
    const offset = Math.floor(((signal.length - frameSize) * f) / Math.max(1, frames - 1));
    for (let n = 0; n < frameSize; n++) {
      re[n] = signal[offset + n] * window[n];
      im[n] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) magnitude[k] += Math.hypot(re[k], im[k]) / frames;
  }
  let maximum = 0;
  for (let k = 1; k < bins; k++) maximum = Math.max(maximum, magnitude[k]);
  if (maximum <= 0) return 0;
  const threshold = maximum * 10 ** (-40 / 20);
  // A Hann window puts its own sidelobes 1.5-3.5 bins either side of a tone, and
  // those are local maxima too. Only count peaks at least 4 bins apart, so one
  // partial can never be mistaken for a harmonic series.
  let count = 0;
  let last = -10;
  for (let k = 2; k < bins - 1; k++) {
    if (magnitude[k] > threshold && magnitude[k] >= magnitude[k - 1] && magnitude[k] > magnitude[k + 1]) {
      if (k - last >= 4) count++;
      last = k;
    }
  }
  return count;
}

/** Harmonic spacing in FFT bins for a signal, or 0 when it has no clear pitch. */
function harmonicSpacingBins(signal: Float32Array, sampleRate: number, frameSize: number): number {
  const fundamental = estimateFundamental(signal, sampleRate);
  if (!fundamental) return 0;
  const bins = (fundamental * frameSize) / (sampleRate || 44100);
  return bins >= 3 ? bins : 0;
}

/**
 * Average log spectral envelope of a signal (dB). Used by the tests (and by the
 * "formants preserved" verification) so the measurement uses exactly the
 * production envelope, not a lookalike.
 */
export function averageSpectralEnvelopeDb(
  signal: Float32Array,
  sampleRate: number,
  frameSize = 2048,
): Float64Array {
  const bins = frameSize / 2 + 1;
  const accumulated = new Float64Array(bins);
  const magnitude = new Float64Array(bins);
  const envelope = new Float64Array(bins);
  const scratchRe = new Float64Array(frameSize);
  const scratchIm = new Float64Array(frameSize);
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  const window = hann(frameSize);
  const hop = frameSize / 4;
  const spacing = harmonicSpacingBins(signal, sampleRate, frameSize);
  let frames = 0;
  for (let offset = 0; offset + frameSize <= signal.length; offset += hop) {
    for (let n = 0; n < frameSize; n++) {
      re[n] = signal[offset + n] * window[n];
      im[n] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) magnitude[k] = Math.hypot(re[k], im[k]);
    spectralEnvelope(magnitude, frameSize, bins, sampleRate, scratchRe, scratchIm, envelope, 2.5, spacing);
    for (let k = 0; k < bins; k++) accumulated[k] += envelope[k];
    frames++;
  }
  const out = new Float64Array(bins);
  for (let k = 0; k < bins; k++) out[k] = frames ? (accumulated[k] / frames) * (20 / Math.LN10) : -140;
  return out;
}

function rms(signal: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < signal.length; i++) sum += signal[i] * signal[i];
  return signal.length ? Math.sqrt(sum / signal.length) : 0;
}

/**
 * The channel that carries more energy. Formants are a property of the singer,
 * not of a channel: a hard-panned source can have a silent left channel, and
 * analysing silence would produce a meaningless curve on both channels.
 */
function analysisChannel(data: AudioData): Float32Array {
  let best = data.channels[0];
  let bestEnergy = -1;
  for (const channel of data.channels) {
    let energy = 0;
    // Every 16th sample is plenty to compare channel levels.
    for (let i = 0; i < channel.length; i += 16) energy += channel[i] * channel[i];
    if (energy > bestEnergy) {
      bestEnergy = energy;
      best = channel;
    }
  }
  return best;
}

/** Average log envelope (natural log) of a signal over time. */
export function averageLogEnvelope(
  signal: Float32Array,
  sampleRate: number,
  frameSize: number,
  hop: number,
  cutoffMs: number,
): Float64Array {
  const bins = frameSize / 2 + 1;
  const window = hann(frameSize);
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  const magnitude = new Float64Array(bins);
  const scratchRe = new Float64Array(frameSize);
  const scratchIm = new Float64Array(frameSize);
  const frameEnvelope = new Float64Array(bins);
  const accumulated = new Float64Array(bins);
  const spacing = harmonicSpacingBins(signal, sampleRate, frameSize);
  let frames = 0;
  for (let offset = 0; offset + frameSize <= signal.length; offset += hop) {
    let energy = 0;
    for (let n = 0; n < frameSize; n++) {
      const value = signal[offset + n] * window[n];
      re[n] = value;
      im[n] = 0;
      energy += value * value;
    }
    // Silent frames would drag the average envelope to the log floor.
    if (energy < 1e-9) continue;
    fft(re, im);
    for (let k = 0; k < bins; k++) magnitude[k] = Math.hypot(re[k], im[k]);
    spectralEnvelope(magnitude, frameSize, bins, sampleRate, scratchRe, scratchIm, frameEnvelope, cutoffMs, spacing);
    for (let k = 0; k < bins; k++) accumulated[k] += frameEnvelope[k];
    frames++;
  }
  const out = new Float64Array(bins);
  for (let k = 0; k < bins; k++) out[k] = frames ? accumulated[k] / frames : 0;
  return out;
}

/**
 * Re-impose the singer's spectral envelope on the pitch-shifted signal.
 *
 * Every analysis frame gets its own correction, measured from *that frame* of
 * the source: the shifted signal is sample-aligned with the source, so frame i
 * of one is frame i of the other. A single song-wide average curve (the
 * previous approach) blurs every vowel of a song into one compromise formant
 * shape and makes a harmony voice sound like a different, oddly-shaped
 * instrument; a per-frame curve follows the singer from syllable to syllable.
 *
 * Two smoothing steps keep the correction artefact-free:
 *   - across frequency, a 9-bin triangular kernel, so neighbouring bins cannot
 *     form a comb;
 *   - across time, a 0.6/0.4 exponential blend (~30 ms at the 512-sample hop),
 *     so vibrato and consonants cannot pump or warble the curve.
 * Frames with no signal (a rest, a breath) keep the previous curve instead of
 * measuring the noise floor.
 *
 * The correction only scales magnitudes — never phases — so it cannot introduce
 * overlap-add cancellation.
 */
function restoreEnvelope(
  shifted: AudioData,
  source: AudioData,
  ratio: number,
  strength: number,
  options: FormantPitchOptions,
  onProgress?: ProgressFn,
): AudioData {
  const frameSize = options.frameSize ?? 2048;
  const hop = options.hop ?? frameSize / 4;
  const bins = frameSize / 2 + 1;
  const cutoffMs = options.formantCutoffMs ?? 2.5;
  // Boost is limited (a +18 dB lift would amplify a noisy band), but a cut
  // must be allowed to go deep: the correction is `env(f) - env(f / ratio)`,
  // which for a fifth is tens of dB wherever the vocal-tract response is
  // steep. Clamping the cut too early leaves the shifted voice far *brighter*
  // than the singer (measured +15 dB of excess brightness above 3.5 kHz),
  // because the whole top octave keeps a flat gain where the source has
  // already rolled off. A cut cannot amplify noise, so it needs no such
  // protection.
  const minGain = options.formantGainMin ?? 0.004;
  const maxGain = options.formantGainMax ?? 8;
  const smoothing = 9;

  const length = shifted.length;
  const window = hann(frameSize);
  const frameCount = Math.max(1, Math.ceil(length / hop));

  const sourceSignal = analysisChannel(source);
  const srcRe = new Float64Array(frameSize);
  const srcIm = new Float64Array(frameSize);
  const magnitude = new Float64Array(bins);
  const envelope = new Float64Array(bins);
  const scratchRe = new Float64Array(frameSize);
  const scratchIm = new Float64Array(frameSize);
  const target = new Float64Array(bins);
  const curve = new Float64Array(bins).fill(1);
  const smoothed = new Float64Array(bins).fill(1);
  let initialized = false;
  // A/B reference mode: one average curve for the whole signal.
  const staticMode = options.envelope === 'static';
  // The harmonic spacing of the singer, in bins, decides how wide a "peak" is.
  const spacing = harmonicSpacingBins(sourceSignal, source.sampleRate, frameSize);
  if (staticMode) {
    const average = averageLogEnvelope(sourceSignal, source.sampleRate, frameSize, hop, cutoffMs);
    for (let k = 0; k < bins; k++) {
      const back = k / ratio;
      if (back >= bins - 1) { target[k] = 1; continue; }
      const lower = Math.floor(back);
      const fraction = back - lower;
      const want = average[lower] * (1 - fraction) + average[Math.min(bins - 1, lower + 1)] * fraction;
      target[k] = Math.max(minGain, Math.min(maxGain, Math.exp(strength * (average[k] - want))));
    }
    for (let k = 0; k < bins; k++) {
      let sum = 0;
      let weight = 0;
      for (let d = -smoothing; d <= smoothing; d++) {
        const index = k + d;
        if (index < 0 || index >= bins) continue;
        const w = 1 - Math.abs(d) / (smoothing + 1);
        sum += target[index] * w;
        weight += w;
      }
      curve[k] = weight ? sum / weight : 1;
    }
    initialized = true;
  }

  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  const padded = length + frameSize;
  const outputs = shifted.channels.map(() => new Float32Array(padded));
  const windowSums = new Float32Array(padded);

  for (let frame = 0; frame < frameCount; frame++) {
    const offset = frame * hop;
    if (offset >= length) break;

    // 1. The singer's own formants in this frame.
    let energy = 0;
    if (staticMode) energy = 0;
    for (let n = 0; n < frameSize; n++) {
      const position = offset + n;
      const value = position < length ? (sourceSignal[position] ?? 0) * window[n] : 0;
      srcRe[n] = value;
      srcIm[n] = 0;
      energy += value * value;
    }
    if (!staticMode && energy > 1e-7) {
      fft(srcRe, srcIm);
      for (let k = 0; k < bins; k++) magnitude[k] = Math.hypot(srcRe[k], srcIm[k]);
      spectralEnvelope(magnitude, frameSize, bins, source.sampleRate, scratchRe, scratchIm, envelope, cutoffMs, spacing);
      for (let k = 0; k < bins; k++) {
        const back = k / ratio;
        if (back >= bins - 1) { target[k] = 1; continue; }
        const lower = Math.floor(back);
        const fraction = back - lower;
        const want = envelope[lower] * (1 - fraction)
          + envelope[Math.min(bins - 1, lower + 1)] * fraction;
        const correction = Math.exp(strength * (envelope[k] - want));
        target[k] = Math.max(minGain, Math.min(maxGain, correction));
      }
      for (let k = 0; k < bins; k++) {
        let sum = 0;
        let weight = 0;
        for (let d = -smoothing; d <= smoothing; d++) {
          const index = k + d;
          if (index < 0 || index >= bins) continue;
          const w = 1 - Math.abs(d) / (smoothing + 1);
          sum += target[index] * w;
          weight += w;
        }
        smoothed[k] = weight ? sum / weight : 1;
      }
      if (initialized) {
        for (let k = 0; k < bins; k++) curve[k] = 0.6 * curve[k] + 0.4 * smoothed[k];
      } else {
        curve.set(smoothed);
        initialized = true;
      }
    }

    // 2. Apply it to the shifted frame and overlap-add.
    for (let c = 0; c < shifted.channels.length; c++) {
      const input = shifted.channels[c];
      for (let n = 0; n < frameSize; n++) {
        const position = offset + n;
        re[n] = position < length ? input[position] * window[n] : 0;
        im[n] = 0;
      }
      fft(re, im);
      for (let k = 0; k < bins; k++) {
        re[k] *= curve[k];
        im[k] *= curve[k];
        if (k > 0 && k < bins - 1) {
          re[frameSize - k] = re[k];
          im[frameSize - k] = -im[k];
        }
      }
      im[bins - 1] = 0;
      ifft(re, im);
      const output = outputs[c];
      for (let n = 0; n < frameSize; n++) {
        const position = offset + n;
        if (position >= padded) break;
        output[position] += re[n] * window[n];
        if (c === 0) windowSums[position] += window[n] * window[n];
      }
    }
    if (onProgress && frame % 32 === 0) onProgress(frame / frameCount, 'Restoring vocal formants');
  }

  const channels = outputs.map((output) => {
    const result = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const divisor = windowSums[i] > 0.05 ? windowSums[i] : 0.05;
      result[i] = output[i] / divisor;
    }
    return result;
  });
  onProgress?.(1, 'Formants restored');
  return audioData(channels, shifted.sampleRate);
}

/**
 * Shift pitch by `semitones` without changing duration, sample rate or the
 * number of samples, preserving formants by default.
 */
export function pitchShiftFormant(
  data: AudioData,
  semitones: number,
  options: FormantPitchOptions = {},
): AudioData {
  if (!Number.isFinite(semitones)) throw new Error('Pitch must be a finite number');
  if (semitones < -24 || semitones > 24) throw new Error('Pitch range is -24 to -24 semitones');
  if (semitones === 0) return cloneAudio(data);
  if (!data.length) return cloneAudio(data);

  const ratio = 2 ** (semitones / 12);
  // A single partial has no formant structure to preserve; shaping it would
  // only change its level. Voices (dozens of partials) are unaffected.
  const partials = harmonicCount(analysisChannel(data), data.sampleRate);
  const hasFormants = partials >= 6;
  const formant = hasFormants ? Math.max(0, Math.min(1, options.formantPreserve ?? 1)) : 0;
  const onProgress = options.onProgress;

  onProgress?.(0, 'Time-stretching');
  // The vocoder needs signal on both sides of the very first and last sample,
  // otherwise its overlap-add sum collapses at the edges and the stretch has to
  // fade the attack in and out (the old code faded the first 93 ms, which
  // audibly softened every consonant of a harmony voice). Pad the source by
  // half a frame in front and a full frame behind, and trim the padding back
  // off after the resample. `padIn` samples of padding become exactly `padIn`
  // samples of output because the stretch and the resample cancel.
  const padIn = 1024;
  const padOut = 2048;
  const padded = audioData(
    data.channels.map((channel) => {
      const out = new Float32Array(channel.length + padIn + padOut);
      out.set(channel, padIn);
      return out;
    }),
    data.sampleRate,
  );
  const stretched = timeStretch(padded, ratio, (p, m) => onProgress?.(p * 0.5, m), { edgeFade: false });
  onProgress?.(0.5, 'Resampling to the target pitch');
  const shiftedBase = resampleByRatio(stretched, 1 / ratio, (p, m) => onProgress?.(0.5 + p * 0.4, m));

  // Exact length and sample alignment. Resampling is band-limited, so partials
  // stay at full amplitude instead of smearing into neighbouring bins.
  const aligned = audioData(
    shiftedBase.channels.map((channel) => {
      const out = new Float32Array(data.length);
      const from = Math.min(channel.length, padIn);
      out.set(channel.subarray(from, Math.min(channel.length, from + data.length)));
      return out;
    }),
    data.sampleRate,
  );

  const corrected = formant > 0
    ? restoreEnvelope(aligned, data, ratio, formant, options, (p, m) => onProgress?.(0.9 + p * 0.1, m))
    : aligned;

  // Overall loudness match, so a shifted voice sits at the same level as the
  // lead and presets stay balanced. This is a single broadband gain.
  let result = corrected;
  if (options.loudnessMatch !== false) {
    // Measured on the channel that actually carries the voice, so a hard-panned
    // source is matched like a centred one (and a silent channel cannot hide the
    // level difference).
    const sourceLevel = rms(analysisChannel(data));
    const shiftedLevel = rms(analysisChannel(corrected));
    if (sourceLevel > 1e-6 && shiftedLevel > 1e-6) {
      const gain = Math.max(0.5, Math.min(2, sourceLevel / shiftedLevel));
      if (Math.abs(gain - 1) > 0.01) {
        result = audioData(
          corrected.channels.map((channel) => {
            const out = new Float32Array(channel.length);
            for (let i = 0; i < channel.length; i++) out[i] = channel[i] * gain;
            return out;
          }),
          corrected.sampleRate,
        );
      }
    }
  }

  onProgress?.(1, 'Pitch shift complete');
  // Rebuild the AudioData so `length` matches the channel buffers exactly.
  return audioData(result.channels, data.sampleRate);
}

/**
 * Shift a signal by a fractional number of cents (used to de-correlate vocal
 * doubles so a delayed copy does not comb-filter the lead).
 */
export function detune(data: AudioData, cents: number, options: FormantPitchOptions = {}): AudioData {
  return pitchShiftFormant(data, cents / 100, { formantPreserve: 1, ...options });
}
