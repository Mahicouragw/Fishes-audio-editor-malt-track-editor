import { describe, it, expect } from 'vitest';
import { pitchShiftFormant, averageSpectralEnvelopeDb } from './formant';
import { pitchShift } from './dsp';
import { audioData } from './dsp';
import { bandPeak } from '../test/songFixture';

const SR = 22050;

/**
 * A steady synthetic vowel at 220 Hz whose spectral envelope has two real
 * formants (700 Hz, 1200 Hz). This is the signal that exposes a chipmunk
 * shifter: a resampler moves those formants by the pitch ratio.
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
      const amplitude = 0.02
        + Math.exp(-((frequency - 700) ** 2) / (2 * 120 ** 2))
        + 0.7 * Math.exp(-((frequency - 1200) ** 2) / (2 * 150 ** 2));
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
    const sourceEnvelope = averageSpectralEnvelopeDb(source, SR);
    const ratio = 2 ** (7 / 12);

    const preserved = pitchShiftFormant(audioData([source], SR), 7, { formantPreserve: 1 });
    const preservedScores = envelopeScores(preserved.channels[0], sourceEnvelope, ratio);
    // The output envelope follows the *original* formant positions.
    expect(preservedScores.preserved).toBeGreaterThan(preservedScores.transposed + 0.15);
    expect(preservedScores.preserved).toBeGreaterThan(0.4);

    // Without preservation the shifter behaves like the old resampler: the
    // formants ride up with the pitch. That is the chipmunk effect, and the
    // test proves the difference is real rather than cosmetic.
    const raw = pitchShiftFormant(audioData([source], SR), 7, { formantPreserve: 0 });
    const rawScores = envelopeScores(raw.channels[0], sourceEnvelope, ratio);
    expect(rawScores.transposed).toBeGreaterThan(rawScores.preserved + 0.15);

    // The production shifter preserves formants by default.
    const production = pitchShift(audioData([source], SR), 7);
    const productionScores = envelopeScores(production.channels[0], sourceEnvelope, ratio);
    expect(productionScores.preserved).toBeGreaterThan(productionScores.transposed);
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
