import { describe, it, expect } from 'vitest';
import { executeJob, type WorkerJob } from './dspJobs';
import { audioData, mergeAudio, type SilenceRegion } from './dsp';
import { dominantFrequency } from './fft';
import { encodeWavBytes, decodeWav } from './wav';
import type { AudioData } from '../types';

function sine(freq: number, sampleRate: number, seconds: number): AudioData {
  const length = Math.round(sampleRate * seconds);
  const ch = new Float32Array(length);
  for (let i = 0; i < length; i++) ch[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.5;
  return audioData([ch], sampleRate);
}

describe('executeJob (shared by worker and main-thread fallback)', () => {
  it('pitch job shifts frequency and preserves duration', () => {
    const input = sine(220, 22050, 0.8);
    const progress: number[] = [];
    const out = executeJob({ kind: 'pitch', data: input, semitones: 7 }, (p) => progress.push(p));
    expect(out.data?.length).toBe(input.length);
    expect(dominantFrequency(out.data!.channels[0], 22050) / (220 * 2 ** (7 / 12))).toBeCloseTo(1, 1);
    // progress is real and monotone-ish, ending at 1
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(1);
  });

  it('pitch job rejects out-of-range semitones', () => {
    expect(() => executeJob({ kind: 'pitch', data: sine(220, 22050, 0.2), semitones: 30 })).toThrow();
  });

  it('range job applies an effect only inside the range', () => {
    const input = sine(440, 22050, 1);
    const before = input.channels[0][Math.round(0.1 * 22050)];
    const out = executeJob({
      kind: 'range',
      data: input,
      effect: { id: 'e', type: 'volume', start: 0.3, end: 0.6, params: { gain: 0 }, enabled: true },
    });
    expect(out.data?.channels[0][Math.round(0.1 * 22050)]).toBeCloseTo(before, 3);
    expect(Math.abs(out.data!.channels[0][Math.round(0.45 * 22050)])).toBeLessThan(0.05);
  });

  it('range job validates start < end', () => {
    expect(() => executeJob({
      kind: 'range',
      data: sine(440, 22050, 1),
      effect: { id: 'e', type: 'volume', start: 0.8, end: 0.2, params: { gain: 1 }, enabled: true },
    })).toThrow(/earlier than end/);
  });

  it('detectSilence + removeSilence jobs chain', () => {
    const sr = 22050;
    const tone = sine(440, sr, 0.4);
    const silence = audioData([new Float32Array(Math.round(sr * 0.5))], sr);
    const withSilence = mergeAudio([tone, silence, tone], sr, { gapSeconds: 0, overlapSeconds: 0, mode: 'sequential' });
    const detected = executeJob({
      kind: 'detectSilence',
      data: withSilence,
      options: { thresholdDb: -50, minDuration: 0.2, preserveMs: 20, windowMs: 20 },
    });
    const regions = (detected.result as SilenceRegion[]);
    expect(regions.length).toBeGreaterThanOrEqual(1);
    const removed = executeJob({ kind: 'removeSilence', data: withSilence, regions });
    expect(removed.data?.length).toBeLessThan(withSilence.length);
  });

  it('merge job concatenates with gaps', () => {
    const a = sine(220, 22050, 0.3);
    const b = sine(440, 22050, 0.3);
    const out = executeJob({ kind: 'merge', datas: [a, b], sampleRate: 22050, options: { gapSeconds: 0.1, overlapSeconds: 0, mode: 'sequential' } });
    expect(out.data!.length / 22050).toBeCloseTo(0.7, 1);
  });

  it('voiceOnly job requires stems when enabled', () => {
    const input = sine(440, 22050, 0.3);
    expect(() => executeJob({
      kind: 'voiceOnly', original: input, vocal: null, instrumental: null,
      options: { enabled: true, semitones: 2, preserveTempo: true, vocalVolume: 1, mixWithAccompaniment: true },
    })).toThrow();
    const off = executeJob({
      kind: 'voiceOnly', original: input, vocal: null, instrumental: null,
      options: { enabled: false, semitones: 2, preserveTempo: true, vocalVolume: 1, mixWithAccompaniment: true },
    });
    expect(off.data?.length).toBe(input.length);
  });

  it('separate job returns vocal + instrumental stems of the same length', () => {
    const sr = 22050;
    const left = sine(330, sr, 0.4).channels[0];
    const right = sine(330, sr, 0.4).channels[0];
    const input = audioData([left, right], sr);
    const out = executeJob({ kind: 'separate', data: input });
    expect(out.data?.length).toBe(input.length);
    const separation = out.result as { vocal: AudioData; instrumental: AudioData; quality: number };
    expect(separation.instrumental.length).toBe(input.length);
    expect(separation.quality).toBeGreaterThanOrEqual(0);
    expect(separation.quality).toBeLessThanOrEqual(0.72);
  });

  it('decodeWav job round-trips PCM', () => {
    const input = sine(440, 44100, 0.1);
    const bytes = encodeWavBytes(input, { bitDepth: 16, channels: 1 });
    const out = executeJob({ kind: 'decodeWav', buffer: bytes.buffer as ArrayBuffer });
    expect(out.data?.length).toBe(input.length);
    expect(out.data?.sampleRate).toBe(44100);
  });

  it('eq, gain, echo, reverb, noiseReduction jobs all produce audio', () => {
    const input = sine(440, 22050, 0.3);
    const jobs: WorkerJob[] = [
      { kind: 'eq', data: input, low: 3, mid: -2, high: 4 },
      { kind: 'gain', data: input, gain: 0.5 },
      { kind: 'echo', data: input, delay: 0.1, feedback: 0.3, mix: 0.3, tail: 0 },
      { kind: 'reverb', data: input, seconds: 1, mix: 0.3, tail: 0.5 },
      { kind: 'noiseReduction', data: input, thresholdDb: -40 },
      { kind: 'timeStretch', data: input, factor: 2 },
      { kind: 'resample', data: input, ratio: 0.5 },
    ];
    for (const job of jobs) {
      const out = executeJob(job);
      expect(out.data, job.kind).toBeTruthy();
    }
    const gainOut = executeJob(jobs[1])!.data!;
    expect(Math.max(...Array.from(gainOut.channels[0].subarray(0, 500), Math.abs))).toBeCloseTo(0.25, 1);
  });

  it('decodeWav job rejects garbage', () => {
    expect(() => executeJob({ kind: 'decodeWav', buffer: new ArrayBuffer(10) })).toThrow();
    void decodeWav;
  });

  it('unknown job kinds throw', () => {
    expect(() => executeJob({ kind: 'nope' } as unknown as WorkerJob)).toThrow(/Unknown DSP job/);
  });
});
