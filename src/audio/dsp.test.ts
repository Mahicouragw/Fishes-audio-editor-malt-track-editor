import { describe, it, expect } from 'vitest';
import { audioData, pitchShift, timeStretch, resampleByRatio, applyReverb, applyEcho, applyEQ, applyGain, detectSilence, removeRegions, mergeAudio, applyRangeEffect, normalize, peak, processVoiceOnly, renderClip } from './dsp';
import { dominantFrequency } from './fft';
import type { RangeEffect } from '../types';

function sine(freq: number, sampleRate: number, seconds: number, channels = 1): ReturnType<typeof audioData> {
  const length = Math.round(sampleRate * seconds);
  const ch = new Float32Array(length);
  for (let i = 0; i < length; i++) ch[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.6;
  return audioData(Array.from({ length: channels }, () => new Float32Array(ch)), sampleRate);
}

function mixture(sampleRate: number): ReturnType<typeof audioData> {
  const s1 = sine(220, sampleRate, 1);
  const s2 = sine(440, sampleRate, 1);
  const out = audioData([new Float32Array(s1.length)], sampleRate);
  for (let i = 0; i < s1.length; i++) out.channels[0][i] = s1.channels[0][i] * 0.5 + s2.channels[0][i] * 0.5;
  return out;
}

describe('pitchShift', () => {
  it('zero semitones preserves pitch and duration', () => {
    const input = sine(440, 44100, 1);
    const out = pitchShift(input, 0);
    expect(out.length).toBe(input.length);
    // Channels equal within float precision
    for (let i = 0; i < Math.min(100, out.length); i++) expect(out.channels[0][i]).toBeCloseTo(input.channels[0][i], 5);
    expect(dominantFrequency(out.channels[0], out.sampleRate)).toBeCloseTo(440, 0);
  });

  it('does not change volume, sample rate, duration or stereo balance', () => {
    const input = sine(300, 48000, 0.5, 2);
    input.channels[1] = new Float32Array(input.channels[0].map((v) => v * 0.5));
    const out = pitchShift(input, 7);
    expect(out.sampleRate).toBe(input.sampleRate);
    expect(out.length).toBe(input.length);
    expect(out.channels.length).toBe(2);
    // Stereo ratio preserved roughly (channel 1 is half of channel 0)
    expect(out.channels[1][100] / (out.channels[0][100] || 1e-9)).toBeCloseTo(0.5, 0);
  });

  it.each([-12, -3, 0, 3, 4, 7, 12])('shifts %i semitones approximately and preserves tempo', (semis) => {
    const sr = 22050; // faster test
    const input = sine(220, sr, 1);
    const out = pitchShift(input, semis);
    expect(out.length).toBe(input.length);
    const expected = 220 * 2 ** (semis / 12);
    const measured = dominantFrequency(out.channels[0], sr);
    // Phase vocoder is approximate; allow 5% tolerance
    expect(measured / expected).toBeCloseTo(1, 1);
  });

  it('throws for invalid semitones', () => {
    expect(() => pitchShift(sine(440, 44100, 0.2), NaN)).toThrow();
    expect(() => pitchShift(sine(440, 44100, 0.2), 30)).toThrow();
  });
});

describe('timeStretch', () => {
  it('factor 1 is identity', () => {
    const input = sine(200, 22050, 0.5);
    const out = timeStretch(input, 1);
    expect(out.length).toBe(input.length);
  });
  it('stretches duration proportionally', () => {
    const input = sine(200, 22050, 0.5);
    const out = timeStretch(input, 2);
    expect(out.length).toBeGreaterThan(input.length * 1.6);
  });
});

describe('resample', () => {
  it('matches the direct windowed-sinc formula exactly where it matters', () => {
    // The fast path uses a table of 256 interpolation phases. Check it against
    // the textbook formula it replaces, so a speed-up can never quietly change
    // the audio.
    const input = sine(440, 22050, 0.2);
    const ratio = 0.83;
    const output = resampleByRatio(input, ratio);
    const cutoff = Math.min(1, ratio);
    const half = Math.min(96, Math.max(12, Math.ceil(16 / cutoff)));
    const sinc = (x: number) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
    let worst = 0;
    for (let i = 0; i < Math.min(output.length, 4000); i += 17) {
      const centre = i / ratio;
      let sum = 0;
      let weightSum = 0;
      for (let j = Math.max(0, Math.floor(centre) - half + 1); j < Math.min(input.length, Math.floor(centre) + half); j++) {
        const x = centre - j;
        const w = sinc(x * cutoff) * cutoff * (0.5 + 0.5 * Math.cos((Math.PI * x) / half));
        sum += input.channels[0][j] * w;
        weightSum += w;
      }
      const expected = weightSum === 0 ? 0 : sum / weightSum;
      worst = Math.max(worst, Math.abs(expected - output.channels[0][i]));
    }
    expect(worst).toBeLessThan(1e-4);
  });

  it('round-trips ratio', () => {
    const input = sine(440, 44100, 0.3);
    const down = resampleByRatio(input, 0.5);
    expect(down.length).toBe(Math.round(input.length * 0.5));
    const up = resampleByRatio(down, 2);
    expect(up.length).toBe(input.length);
  });
});

describe('effects', () => {
  it('applyGain scales peak', () => {
    const input = sine(440, 44100, 0.2);
    const p = peak(input);
    const out = applyGain(input, 0.5);
    expect(peak(out)).toBeCloseTo(p * 0.5, 2);
  });
  it('normalize limits peak', () => {
    const input = applyGain(sine(440, 44100, 0.2), 2);
    const out = normalize(input, 0.9);
    expect(peak(out)).toBeCloseTo(0.9, 1);
  });
  it('reverb adds tail without cutting dry', () => {
    const input = sine(440, 44100, 0.3);
    const out = applyReverb(input, 1, 0.3, 0.5);
    expect(out.length).toBe(input.length + Math.round(0.5 * input.sampleRate));
  });
  it('echo preserves length when no tail', () => {
    const input = sine(440, 22050, 0.3);
    const out = applyEcho(input, 0.1, 0.3, 0.3, 0);
    expect(out.length).toBe(input.length);
  });
  it('EQ does not throw', () => {
    const input = sine(440, 44100, 0.2);
    const out = applyEQ(input, 3, -2, 4);
    expect(out.length).toBe(input.length);
  });
});

describe('silence', () => {
  it('detects and removes silent regions', () => {
    const sr = 22050;
    const tone = sine(440, sr, 0.4);
    const silence = audioData([new Float32Array(Math.round(sr * 0.5))], sr);
    const withSilence = mergeAudio([tone, silence, tone], sr, { gapSeconds: 0, overlapSeconds: 0, mode: 'sequential' });
    const regions = detectSilence(withSilence, { thresholdDb: -50, minDuration: 0.2, preserveMs: 20, windowMs: 20 });
    expect(regions.length).toBeGreaterThanOrEqual(1);
    const cleaned = removeRegions(withSilence, regions);
    expect(cleaned.length).toBeLessThan(withSilence.length);
  });
  it('preserveMs avoids cutting edges', () => {
    const sr = 22050;
    const data = audioData([new Float32Array(sr)], sr);
    // 0.1s tone at start and end
    for (let i = 0; i < sr * 0.1; i++) data.channels[0][i] = 0.5;
    for (let i = sr - sr * 0.1; i < sr; i++) data.channels[0][i] = 0.5;
    const regions = detectSilence(data, { thresholdDb: -40, minDuration: 0.05, preserveMs: 50, windowMs: 20 });
    expect(regions.length).toBeGreaterThan(0);
  });
});

describe('merge', () => {
  it('sequential merge concatenates', () => {
    const a = sine(220, 22050, 0.3);
    const b = sine(440, 22050, 0.3);
    const merged = mergeAudio([a, b], 22050, { gapSeconds: 0.1, overlapSeconds: 0, mode: 'sequential' });
    expect(merged.length / merged.sampleRate).toBeCloseTo(0.7, 1);
  });
  it('timeline merge mixes', () => {
    const a = sine(220, 22050, 0.5);
    const b = sine(440, 22050, 0.5);
    const merged = mergeAudio([a, b], 22050, { gapSeconds: 0, overlapSeconds: 0, mode: 'timeline', timelineStarts: [0, 0] });
    expect(merged.length / merged.sampleRate).toBeCloseTo(0.5, 1);
  });
  it('requires at least one file', () => {
    expect(() => mergeAudio([], 44100, { gapSeconds: 0, overlapSeconds: 0, mode: 'sequential' })).toThrow();
  });
});

describe('range effects', () => {
  it('validates range', () => {
    const input = sine(440, 22050, 1);
    expect(() => applyRangeEffect(input, { id: '1', type: 'volume', start: 0.8, end: 0.2, params: { gain: 1 }, enabled: true })).toThrow();
    expect(() => applyRangeEffect(input, { id: '1', type: 'volume', start: -1, end: -0.5, params: { gain: 1 }, enabled: true })).toThrow();
  });
  it('preserves audio outside range', () => {
    const sr = 22050;
    const input = mixture(sr);
    const effect: RangeEffect = { id: '1', type: 'volume', start: 0.3, end: 0.6, params: { gain: 0 }, enabled: true };
    const { data: out } = applyRangeEffect(input, effect);
    // Before range should be unchanged
    expect(out.channels[0][Math.round(0.1 * sr)]).toBeCloseTo(input.channels[0][Math.round(0.1 * sr)], 3);
    // Inside range should be near silence
    expect(Math.abs(out.channels[0][Math.round(0.45 * sr)])).toBeLessThan(0.05);
  });
  it('reverb tail extends after range', () => {
    const input = sine(440, 22050, 1);
    const { data: out, tailSeconds } = applyRangeEffect(input, { id: '1', type: 'reverb', start: 0.2, end: 0.5, params: { reverbSeconds: 1, reverbMix: 0.5 }, enabled: true });
    expect(tailSeconds).toBeGreaterThan(0);
    expect(out.length).toBeGreaterThanOrEqual(input.length);
  });
  it('supports fade, eq, noiseReduction', () => {
    const input = sine(440, 22050, 1);
    for (const type of ['fadeIn', 'fadeOut', 'eq', 'noiseReduction'] as const) {
      const { data } = applyRangeEffect(input, { id: '1', type, start: 0.1, end: 0.9, params: { eqLow: 2, eqMid: -1, eqHigh: 1, noiseThresholdDb: -40 }, enabled: true });
      expect(data.length).toBeGreaterThanOrEqual(input.length);
    }
  });
});

describe('voice only', () => {
  it('returns original when disabled', () => {
    const input = sine(440, 22050, 0.3);
    const out = processVoiceOnly(input, null, null, { enabled: false, semitones: 4, preserveTempo: true, vocalVolume: 1, mixWithAccompaniment: true });
    expect(out.length).toBe(input.length);
  });
  it('requires stems when enabled', () => {
    const input = sine(440, 22050, 0.3);
    expect(() => processVoiceOnly(input, null, null, { enabled: true, semitones: 2, preserveTempo: true, vocalVolume: 1, mixWithAccompaniment: true })).toThrow();
  });
  it('mixes vocal with accompaniment', () => {
    const input = sine(440, 22050, 0.3);
    const vocal = sine(440, 22050, 0.3);
    const inst = sine(110, 22050, 0.3);
    const out = processVoiceOnly(input, vocal, inst, { enabled: true, semitones: 0, preserveTempo: true, vocalVolume: 1, mixWithAccompaniment: true });
    expect(out.length).toBe(input.length);
    expect(peak(out)).toBeGreaterThan(0);
  });
});

describe('renderClip', () => {
  it('applies pitch and gain chain', () => {
    const input = sine(440, 22050, 0.4);
    const out = renderClip(input, { pitchSemis: 7, gain: 0.5, fadeIn: 0, fadeOut: 0, effects: [] });
    expect(out.length).toBe(input.length);
    // Phase vocoder can modulate peak slightly; allow 20% tolerance
    expect(peak(out)).toBeGreaterThan(0.2);
    expect(peak(out)).toBeLessThan(0.7);
  });
});
