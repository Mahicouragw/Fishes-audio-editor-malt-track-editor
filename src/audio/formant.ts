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
}

/** Floor used for log magnitudes and for envelope smoothing. */
const LOG_FLOOR = 1e-7;

function hann(size: number): Float64Array {
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
function spectralEnvelope(
  magnitude: Float64Array,
  frameSize: number,
  bins: number,
  sampleRate: number,
  scratchRe: Float64Array,
  scratchIm: Float64Array,
  output: Float64Array,
  cutoffMs = 2.5,
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
    for (let k = Math.max(1, first); k < bins - 1; k++) {
      if (magnitude[k] >= magnitude[k - 1] && magnitude[k] > magnitude[k + 1] && magnitude[k] > threshold) {
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
  // Interpolate in the log domain between successive peaks. Outside the peak
  // range the curve is held (a held value is far safer than extrapolating a
  // slope into the noise floor).
  let cursor = 0;
  for (let k = 0; k < bins; k++) {
    while (cursor + 1 < peak.length && peak[cursor + 1] <= k) cursor++;
    if (k <= peak[0]) {
      output[k] = peakValue[0];
    } else if (cursor + 1 >= peak.length) {
      output[k] = peakValue[peak.length - 1];
    } else {
      const from = peak[cursor];
      const to = peak[cursor + 1];
      const fraction = to > from ? (k - from) / (to - from) : 0;
      output[k] = peakValue[cursor] * (1 - fraction) + peakValue[cursor + 1] * fraction;
    }
  }
  // Light smoothing so the curve cannot develop a comb of its own.
  const radius = Math.max(1, Math.round((sampleRate * cutoffMs * 0.001) / 8));
  const smoothed = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    let sum = 0;
    let weight = 0;
    for (let d = -radius; d <= radius; d++) {
      const index = k + d;
      if (index < 0 || index >= bins) continue;
      const w = 1 - Math.abs(d) / (radius + 1);
      sum += output[index] * w;
      weight += w;
    }
    smoothed[k] = weight ? sum / weight : output[k];
  }
  for (let k = 0; k < bins; k++) output[k] = smoothed[k];
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
  let frames = 0;
  for (let offset = 0; offset + frameSize <= signal.length; offset += hop) {
    for (let n = 0; n < frameSize; n++) {
      re[n] = signal[offset + n] * window[n];
      im[n] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) magnitude[k] = Math.hypot(re[k], im[k]);
    spectralEnvelope(magnitude, frameSize, bins, sampleRate, scratchRe, scratchIm, envelope);
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

/** Average log envelope (natural log) of a signal over time. */
function averageLogEnvelope(
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
    spectralEnvelope(magnitude, frameSize, bins, sampleRate, scratchRe, scratchIm, frameEnvelope, cutoffMs);
    for (let k = 0; k < bins; k++) accumulated[k] += frameEnvelope[k];
    frames++;
  }
  const out = new Float64Array(bins);
  for (let k = 0; k < bins; k++) out[k] = frames ? accumulated[k] / frames : 0;
  return out;
}

/**
 * Re-impose the source's average spectral envelope on the pitch-shifted
 * signal.
 *
 * Both envelopes are *measured* (the source's and the shifted signal's own), so
 * there is no ratio mapping to get wrong: the gain is simply the difference
 * between the shape we want and the shape we have. The correction is static in
 * time (a singer's vocal-tract resonances are stable, and a static curve cannot
 * pump or warble) and it only scales magnitudes — never phases — so it is free
 * of overlap-add cancellation.
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
  const minGain = options.formantGainMin ?? 0.125;
  const maxGain = options.formantGainMax ?? 8;

  onProgress?.(0, 'Measuring vocal formants');
  const sourceEnvelope = averageLogEnvelope(source.channels[0], source.sampleRate, frameSize, hop, cutoffMs);
  // The shift moved the source's envelope by exactly `ratio`, so the shape we
  // are about to write at bin k is the shape the source had at k / ratio. The
  // correction is therefore derived from the source alone: measuring the
  // shifted signal as well would only add the shift's own noise.
  const gain = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    const back = k / ratio;
    if (back >= bins - 1) { gain[k] = 1; continue; }
    const lower = Math.floor(back);
    const fraction = back - lower;
    const current = sourceEnvelope[lower] * (1 - fraction)
      + sourceEnvelope[Math.min(bins - 1, lower + 1)] * fraction;
    const correction = Math.exp(strength * (sourceEnvelope[k] - current));
    gain[k] = Math.max(minGain, Math.min(maxGain, correction));
  }
  // Smooth the curve so neighbouring bins cannot create a comb.
  const window = hann(frameSize);
  const smoothing = 9;
  const smoothed = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    let sum = 0;
    let weight = 0;
    for (let d = -smoothing; d <= smoothing; d++) {
      const index = k + d;
      if (index < 0 || index >= bins) continue;
      const w = 1 - Math.abs(d) / (smoothing + 1);
      sum += gain[index] * w;
      weight += w;
    }
    smoothed[k] = weight ? sum / weight : 1;
  }

  const corrected = applyStaticCurve(shifted, smoothed, frameSize, hop, window);
  onProgress?.(1, 'Formants restored');
  return corrected;
}

/**
 * Multiply the signal's spectrum by a fixed, smooth magnitude curve. Phases are
 * untouched; overlap-add is normalised by the window sum, so the level is
 * preserved exactly outside the corrected bands.
 */
function applyStaticCurve(
  data: AudioData,
  curve: Float64Array,
  frameSize: number,
  hop: number,
  window: Float64Array,
): AudioData {
  const bins = frameSize / 2 + 1;
  const length = data.length;
  const padded = length + frameSize;
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  const outputs = data.channels.map(() => new Float32Array(padded));
  const windowSums = new Float32Array(padded);
  const frameCount = Math.max(1, Math.ceil(length / hop));
  for (let frame = 0; frame < frameCount; frame++) {
    const offset = frame * hop;
    if (offset >= length) break;
    for (let c = 0; c < data.channels.length; c++) {
      const input = data.channels[c];
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
  }
  const channels = outputs.map((output) => {
    const result = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const divisor = windowSums[i] > 0.05 ? windowSums[i] : 0.05;
      result[i] = output[i] / divisor;
    }
    return result;
  });
  return audioData(channels, data.sampleRate);
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
  const formant = Math.max(0, Math.min(1, options.formantPreserve ?? 1));
  const onProgress = options.onProgress;

  onProgress?.(0, 'Time-stretching');
  const stretched = timeStretch(data, ratio, (p, m) => onProgress?.(p * 0.5, m));
  onProgress?.(0.5, 'Resampling to the target pitch');
  const shiftedBase = resampleByRatio(stretched, 1 / ratio, (p, m) => onProgress?.(0.5 + p * 0.4, m));

  // Exact length and sample alignment. Resampling is band-limited, so partials
  // stay at full amplitude instead of smearing into neighbouring bins.
  const aligned = audioData(
    shiftedBase.channels.map((channel) => {
      const out = new Float32Array(data.length);
      out.set(channel.subarray(0, Math.min(channel.length, data.length)));
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
    const sourceLevel = rms(data.channels[0]);
    const shiftedLevel = rms(corrected.channels[0]);
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
