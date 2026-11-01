import { describe, it, expect } from 'vitest';
import { pitchShiftFormant, averageSpectralEnvelopeDb, estimateFundamental } from './formant';
import { pitchShift } from './dsp';
import { audioData } from './dsp';
import { bandPeak } from '../test/songFixture';
import { fft } from './fft';
import type { AudioData } from '../types';

const SR = 22050;

/**
 * A steady synthetic vowel at 220 Hz with three real formants (600, 1200 and
 * 2600 Hz) and a natural glottal tilt. This is the signal that exposes a
 * chipmunk shifter: a resampler moves those formants by the pitch ratio, and
 * the third formant is what makes the top octave audible.
 */
function vowel(seconds = 1): Float32Array {
  const length = Math.round(SR * seconds);
  const out = new Float32Array(length);
  const f0 = 220;
  for (let i = 0; i < length; i++) {
    const t = i / SR;
    let value = 0;
    for (let h = 1; h * f0 < SR / 2 - 100; h++) {
      const frequency = h * f0;
      const amplitude = (0.02
        + Math.exp(-((frequency - 600) ** 2) / (2 * 100 ** 2))
        + 0.7 * Math.exp(-((frequency - 1200) ** 2) / (2 * 130 ** 2))
        + 0.35 * Math.exp(-((frequency - 2600) ** 2) / (2 * 200 ** 2)))
        / (1 + (frequency / 900) ** 0.9);
      value += amplitude * Math.sin(2 * Math.PI * frequency * t);
    }
    out[i] = 0.25 * value;
  }
  return out;
}

/** Average log spectral envelope (dB), the production measurement. */
function envelope(signal: Float32Array): Float64Array {
  return averageSpectralEnvelopeDb(signal, SR);
}

function envelopeAt(env: Float64Array, frequency: number): number {
  const binHz = SR / 2048;
  const position = frequency / binHz;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return env[lower] * (1 - fraction) + env[Math.min(env.length - 1, lower + 1)] * fraction;
}

/** Correlation of two sampled envelopes (shape comparison, not level). */
function correlation(a: number[], b: number[]): number {
  const meanA = a.reduce((sum, v) => sum + v, 0) / a.length;
  const meanB = b.reduce((sum, v) => sum + v, 0) / b.length;
  let numerator = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < a.length; i++) {
    numerator += (a[i] - meanA) * (b[i] - meanB);
    varianceA += (a[i] - meanA) ** 2;
    varianceB += (b[i] - meanB) ** 2;
  }
  return numerator / Math.sqrt(varianceA * varianceB);
}

const PROBES: number[] = (() => {
  const list: number[] = [];
  for (let f = 300; f <= 4200; f *= 1.06) list.push(f);
  return list;
})();

/** How well the shifted envelope matches the original vs. the transposed one. */
function envelopeScores(signal: Float32Array, sourceEnvelope: Float64Array, ratio: number) {
  const env = envelope(signal);
  const values = PROBES.map((f) => envelopeAt(env, f));
  return {
    preserved: correlation(values, PROBES.map((f) => envelopeAt(sourceEnvelope, f))),
    transposed: correlation(values, PROBES.map((f) => envelopeAt(sourceEnvelope, f / ratio))),
  };
}

describe('formant-preserving pitch shift', () => {
  it('shifts the pitch by the exact interval without changing the duration', () => {
    const source = vowel(1);
    for (const semitones of [3, 4, 7, -3, -7]) {
      const shifted = pitchShiftFormant(audioData([source], SR), semitones);
      expect(shifted.sampleRate).toBe(SR);
      expect(shifted.length).toBe(source.length);
      const ratio = 2 ** (semitones / 12);
      const expected = 220 * ratio;
      const peak = bandPeak(shifted.channels[0], SR, expected * 0.9, expected * 1.1);
      expect(peak.frequency / expected).toBeGreaterThan(0.99);
      expect(peak.frequency / expected).toBeLessThan(1.01);
      // Every partial moved: nothing is left at the source pitch.
      expect(bandPeak(shifted.channels[0], SR, 210, 230).amplitude).toBeLessThan(peak.amplitude * 0.2);
    }
  });

  it('keeps the formants where the singer put them (no chipmunk)', () => {
    const source = vowel(2);
    const sourceData = audioData([source], SR);
    const envelope = averageSpectralEnvelopeDb(source, SR);
    const ratio = 2 ** (7 / 12);
    const f0 = 220;

    // The envelope is the singer's vocal-tract response. A formant-preserving
    // shift puts every new harmonic at the level that envelope asks for; a
    // transposing shifter puts it at the level of the *old* harmonic, i.e. at
    // envelope(f / ratio). Measuring both hypotheses directly is far stronger
    // than comparing correlations: it says which frequencies each partial
    // actually landed on.
    const preserved = pitchShiftFormant(sourceData, 7, { formantPreserve: 1 });
    const raw = pitchShiftFormant(sourceData, 7, { formantPreserve: 0 });

    const errorTo = (signal: Float32Array, map: (f: number) => number) => {
      const values: number[] = [];
      for (let k = 2; k * f0 * ratio < 4000; k++) {
        const target = k * f0 * ratio;
        values.push(harmonicLevelDb(signal, target) - envelopeAt(envelope, map(target)));
      }
      const median = [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
      const deviations = values.map((v) => v - median);
      return Math.sqrt(deviations.reduce((sum, v) => sum + v * v, 0) / deviations.length);
    };

    // Each output is tested against both hypotheses: does this signal's
    // spectrum follow the singer's own formants, or formants moved up by the
    // shift? The margin between the two is what identifies a chipmunk.
    const preservedToOriginal = errorTo(preserved.channels[0], (f) => f);
    const preservedToTransposed = errorTo(preserved.channels[0], (f) => f / ratio);
    expect(preservedToOriginal).toBeLessThan(preservedToTransposed * 0.5);
    expect(preservedToOriginal).toBeLessThan(6);

    const rawToOriginal = errorTo(raw.channels[0], (f) => f);
    const rawToTransposed = errorTo(raw.channels[0], (f) => f / ratio);
    // Without preservation the output really is the transposed one.
    expect(rawToTransposed).toBeLessThan(rawToOriginal * 0.5);
    // And the production shifter preserves formants by default.
    const production = pitchShift(sourceData, 7);
    expect(errorTo(production.channels[0], (f) => f)).toBeLessThan(errorTo(production.channels[0], (f) => f / ratio));
  });

  it('does not turn a fifth into a bright, thin chipmunk', () => {
    // The measured signature of the old defect: a +7 shift put 18-32 dB more
    // energy above 4 kHz than the singer had, because the formant correction
    // was clamped and the vocal roll-off was never restored.
    const source = audioData([vowel(2)], SR);
    const sourceBalance = highFrequencyBalance(source);
    for (const semitones of [3, 4, 7]) {
      const shifted = pitchShiftFormant(source, semitones, { formantPreserve: 1 });
      const balance = highFrequencyBalance(shifted);
      expect(Math.abs(balance - sourceBalance)).toBeLessThan(4);
    }
    // Without preservation the top octave really does stay transposed.
    const transposed = pitchShiftFormant(source, 7, { formantPreserve: 0 });
    expect(highFrequencyBalance(transposed) - sourceBalance).toBeGreaterThan(5);
  });

  it('keeps the attack instead of fading the first 60 ms', () => {
    // The stretch used to fade its own edges, which softened every consonant
    // of a harmony voice.
    const source = vowel(1);
    const shifted = pitchShiftFormant(audioData([source], SR), 7);
    const head = (signal: Float32Array) => {
      let peak = 0;
      for (let i = 0; i < 1024; i++) peak = Math.max(peak, Math.abs(signal[i]));
      return peak;
    };
    expect(head(shifted.channels[0]) / head(source)).toBeGreaterThan(0.8);
  });

  it('follows a moving vowel, which a single average curve cannot do', () => {
    const source = morphingVowel(3);
    const data = audioData([source], SR);
    const perFrame = pitchShiftFormant(data, 7, { envelope: 'per-frame' });
    const staticCurve = pitchShiftFormant(data, 7, { envelope: 'static' });
    const f2Error = (shifted: AudioData) => {
      let worst = 0;
      for (const time of [0.2, 1.2, 2.2, 2.8]) {
        const at = Math.round(time * SR);
        const want = sliceEnvelopePeak(source, at, 1000, 2400);
        const got = sliceEnvelopePeak(shifted.channels[0], at, 1000, 2400);
        worst = Math.max(worst, Math.abs(got - want) / want);
      }
      return worst;
    };
    expect(f2Error(perFrame)).toBeLessThan(0.22);
    expect(f2Error(staticCurve)).toBeGreaterThan(f2Error(perFrame));
  });

  it('keeps every partial of a flat spectrum after a +7 shift', () => {
    const f0 = 180;
    const source = audioData([pulseTrain(1.5, f0)], SR);
    const shifted = pitchShiftFormant(source, 7);
    const ratio = 2 ** (7 / 12);
    for (let k = 1; k * f0 * ratio < 6000; k++) {
      const delta = harmonicLevelDb(shifted.channels[0], k * f0 * ratio) - harmonicLevelDb(source.channels[0], k * f0);
      expect(delta).toBeGreaterThan(-1.5);
      expect(delta).toBeLessThan(1.5);
    }
  });

  it('keeps the level in the same range instead of dropping or boosting', () => {
    const source = vowel(1);
    const sourceRms = Math.sqrt(source.reduce((sum, v) => sum + v * v, 0) / source.length);
    for (const semitones of [3, 4, 7, -3, -7]) {
      const shifted = pitchShiftFormant(audioData([source], SR), semitones);
      const channel = shifted.channels[0];
      const rms = Math.sqrt(channel.reduce((sum, v) => sum + v * v, 0) / channel.length);
      expect(rms / sourceRms).toBeGreaterThan(0.7);
      expect(rms / sourceRms).toBeLessThan(1.3);
      // No clipping spikes from the overlap-add.
      let peak = 0;
      for (const value of channel) peak = Math.max(peak, Math.abs(value));
      expect(peak).toBeLessThan(1);
      // No NaNs.
      for (let i = 0; i < channel.length; i += 97) expect(Number.isFinite(channel[i])).toBe(true);
    }
  });

  it('is exactly transparent at zero semitones', () => {
    const source = vowel(0.2);
    const shifted = pitchShiftFormant(audioData([source], SR), 0);
    expect(shifted.length).toBe(source.length);
    for (let i = 0; i < source.length; i += 31) expect(shifted.channels[0][i]).toBe(source[i]);
  });

  it('analyses the channel that carries the voice, not a silent one', () => {
    // A voice panned hard right has nothing on the left channel. Analysing the
    // silent side would produce a flat curve (no correction at all), so the
    // analyser must pick the channel with the energy.
    const voice = vowel(1.5);
    const silent = new Float32Array(voice.length);
    const stereo = pitchShiftFormant(audioData([silent, voice], SR), 7).channels[1];
    const centred = pitchShiftFormant(audioData([voice], SR), 7).channels[0];
    let worst = 0;
    for (let i = 0; i < centred.length; i += 97) worst = Math.max(worst, Math.abs(stereo[i] - centred[i]));
    expect(worst).toBeLessThan(0.01);
  });

  it('keeps stereo channels correctly balanced', () => {
    const left = vowel(0.5);
    const right = left.map((v) => v * 0.5);
    const shifted = pitchShiftFormant(audioData([left, Float32Array.from(right)], SR), 4);
    const leftRms = Math.sqrt(shifted.channels[0].reduce((s, v) => s + v * v, 0) / shifted.length);
    const rightRms = Math.sqrt(shifted.channels[1].reduce((s, v) => s + v * v, 0) / shifted.length);
    expect(rightRms / leftRms).toBeGreaterThan(0.35);
    expect(rightRms / leftRms).toBeLessThan(0.65);
  });
});

/**
 * A vowel whose formants move over time ("ah" → "ee" → "ah"), used to prove
 * that the correction follows the singer instead of one song-wide average.
 */
function morphingVowel(seconds: number): Float32Array {
  const length = Math.round(SR * seconds);
  const out = new Float32Array(length);
  const f0 = 180;
  for (let i = 0; i < length; i++) {
    const t = i / SR;
    const bump = Math.sin(Math.PI * (t / seconds));
    const f1 = 420 + 420 * bump;
    const f2 = 2100 - 1150 * bump;
    let value = 0;
    for (let h = 1; h * f0 < SR / 2 - 100; h++) {
      const frequency = h * f0;
      const amplitude = 0.02
        + Math.exp(-((frequency - f1) ** 2) / (2 * 110 ** 2))
        + 0.8 * Math.exp(-((frequency - f2) ** 2) / (2 * 150 ** 2));
      value += amplitude * Math.sin(2 * Math.PI * frequency * t);
    }
    out[i] = 0.25 * value;
  }
  return out;
}

/** A harmonic tone at an arbitrary F0 with the same formants as `vowel`. */
function voiceAt(f0: number, seconds = 1.5): Float32Array {
  const length = Math.round(SR * seconds);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / SR;
    let value = 0;
    for (let h = 1; h * f0 < SR / 2 - 100; h++) {
      const frequency = h * f0;
      const amplitude = (0.02
        + Math.exp(-((frequency - 600) ** 2) / (2 * 100 ** 2))
        + 0.7 * Math.exp(-((frequency - 1200) ** 2) / (2 * 130 ** 2))
        + 0.35 * Math.exp(-((frequency - 2600) ** 2) / (2 * 200 ** 2)))
        / (1 + (frequency / 900) ** 0.9);
      value += amplitude * Math.sin(2 * Math.PI * frequency * t);
    }
    out[i] = 0.25 * value;
  }
  return out;
}

/** Flat-spectrum pulse train: every harmonic at the same level. */
function pulseTrain(seconds: number, f0: number): Float32Array {
  const length = Math.round(SR * seconds);
  const out = new Float32Array(length);
  const count = Math.floor(6000 / f0);
  for (let i = 0; i < length; i++) {
    const t = i / SR;
    let value = 0;
    for (let k = 1; k <= count; k++) value += Math.sin(2 * Math.PI * k * f0 * t + k * 0.7);
    out[i] = value * 0.02;
  }
  return out;
}

/**
 * Level of one partial, averaged over many windows. A single window can land
 * in the trough of the slow amplitude beating a phase vocoder leaves on an
 * individual partial, which would make the measurement, not the audio, look
 * broken.
 */
function harmonicLevelDb(signal: Float32Array, frequency: number): number {
  const size = 4096;
  const windows: number[] = [];
  for (let start = 0; start + size <= signal.length; start += size) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < size; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
      const phase = (2 * Math.PI * frequency * (start + i)) / SR;
      re += signal[start + i] * w * Math.cos(phase);
      im += signal[start + i] * w * Math.sin(phase);
    }
    windows.push((re * re + im * im) / (size * size));
  }
  const power = windows.reduce((sum, v) => sum + v, 0) / Math.max(1, windows.length);
  return 10 * Math.log10(power + 1e-20);
}

/** Energy above 4 kHz relative to the whole band, in dB. */
function highFrequencyBalance(data: AudioData): number {
  const size = 4096;
  const bins = size / 2 + 1;
  const power = new Float64Array(bins);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const signal = data.channels[0];
  let frames = 0;
  for (let offset = 0; offset + size <= signal.length; offset += size) {
    for (let n = 0; n < size; n++) {
      re[n] = signal[offset + n] * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / size));
      im[n] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) power[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  let high = 0;
  let total = 0;
  for (let k = 1; k < bins; k++) {
    const frequency = (k * data.sampleRate) / size;
    if (frequency < 100) continue;
    total += power[k];
    if (frequency >= 4000) high += power[k];
  }
  return 10 * Math.log10((high + 1e-20) / (total + 1e-20));
}

/** Peak of the production envelope in a short slice around `at`. */
function sliceEnvelopePeak(signal: Float32Array, at: number, lo: number, hi: number): number {
  const half = 3072;
  const from = Math.max(0, at - half);
  const envelope = averageSpectralEnvelopeDb(signal.subarray(from, Math.min(signal.length, at + half)), SR);
  const binHz = SR / 2048;
  let best = -Infinity;
  let at2 = lo;
  for (let k = 1; k < envelope.length; k++) {
    const frequency = k * binHz;
    if (frequency < lo || frequency > hi) continue;
    if (envelope[k] > best) {
      best = envelope[k];
      at2 = frequency;
    }
  }
  return at2;
}

/**
 * The analyser itself is part of the pitch shifter: if the measured envelope
 * dips into the noise between harmonics, the correction becomes a comb and the
 * shifted voice turns metallic even though the formant *positions* are right.
 */
describe('formant analyser', () => {
  it('finds the harmonic spacing of a voice', () => {
    // Integer-lag autocorrelation: within 1 % is all the analyser needs.
    expect(Math.abs((estimateFundamental(voiceAt(180), SR) ?? 0) - 180)).toBeLessThan(2);
    expect(Math.abs((estimateFundamental(vowel(1), SR) ?? 0) - 220)).toBeLessThan(2);
  });

  it('measures a smooth envelope between the harmonics, not the noise floor', () => {
    // A steady 180 Hz harmonic tone: the bins at 450 Hz and 630 Hz sit exactly
    // between two partials. A windowed tone has sidelobe maxima there, 30-50 dB
    // down, and an analyser that trusts every local maximum reports a comb —
    // which is what turned the +7 voice metallic.
    const signal = voiceAt(180);
    const envelope = averageSpectralEnvelopeDb(signal, SR);
    const level = (f: number) => envelope[Math.round(f / (SR / 2048))];
    for (const between of [450, 630, 810, 990]) {
      const either = Math.max(level(between - 90), level(between + 90));
      expect(level(between)).toBeGreaterThan(either - 12);
    }
  });

  it('does not colour material that has no formants to preserve', () => {
    // One partial is not a voice: restoring a "vocal tract" can only change its
    // level, so the shifter leaves the level alone instead.
    const tone = new Float32Array(Math.round(SR * 1.5));
    for (let i = 0; i < tone.length; i++) tone[i] = 0.3 * Math.sin((2 * Math.PI * 330 * i) / SR);
    const shifted = pitchShiftFormant(audioData([tone], SR), 4).channels[0];
    const level = (signal: Float32Array) => {
      let sum = 0;
      for (let i = Math.round(SR * 0.2); i < Math.round(SR * 1.3); i++) sum += signal[i] * signal[i];
      return Math.sqrt(sum / Math.round(SR * 1.1));
    };
    expect(level(shifted) / level(tone)).toBeGreaterThan(0.94);
    expect(level(shifted) / level(tone)).toBeLessThan(1.06);
    // And the pitch still moved.
    expect(bandPeak(shifted, SR, 415 * 0.97, 415 * 1.03).frequency / 415.3).toBeGreaterThan(0.99);
  });
});
