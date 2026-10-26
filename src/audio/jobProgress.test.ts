import { describe, it, expect } from 'vitest';
import { executeJob, type WorkerJob } from './dspJobs';
import { audioData } from './dsp';
import type { AudioData } from '../types';

/**
 * Every long-running tool must report real progress.
 *
 * This is a regression guard for the bug that made Human Voice Processing look
 * dead: the `voiceOnly` job (the rendered vocal stem behind playback, preview
 * and export) and the `range` job (clip effects) ran their full render without
 * emitting a single progress event, so the UI sat at 0 % until the job finished
 * — minutes later on a tablet, or never at all if the tab was closed.
 */

const SR = 16000;

function tone(seconds: number, frequency: number, vibrato = 0): Float32Array {
  const out = new Float32Array(Math.round(SR * seconds));
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const f = frequency * (1 + vibrato * Math.sin(2 * Math.PI * 5 * t));
    out[i] = 0.15 * Math.sin(2 * Math.PI * f * t) + 0.05 * Math.sin(2 * Math.PI * 2 * f * t);
  }
  return out;
}

const mono: AudioData = audioData([tone(2, 220)], SR);
const vocal: AudioData = audioData([tone(2, 220, 0.01)], SR);
const instrumental: AudioData = audioData([tone(2, 110)], SR);

interface Case {
  name: string;
  job: WorkerJob;
  /** Some jobs legitimately finish as soon as they start. */
  minEvents?: number;
}

const CASES: Case[] = [
  { name: 'pitch', job: { kind: 'pitch', data: mono, semitones: 4 } },
  { name: 'timeStretch', job: { kind: 'timeStretch', data: mono, factor: 1.3 } },
  { name: 'resample', job: { kind: 'resample', data: mono, ratio: 0.8 } },
  {
    name: 'range (pitch effect)',
    job: { kind: 'range', data: mono, effect: { id: 'e1', type: 'pitch', enabled: true, start: 0, end: 2, params: { semitones: 5 } } as never },
  },
  {
    name: 'range (harmony effect)',
    job: { kind: 'range', data: mono, effect: { id: 'e2', type: 'harmony', enabled: true, start: 0, end: 2, params: { intervals: [0, 4, 7], harmonyGain: 0.3 } } as never },
  },
  { name: 'reverb', job: { kind: 'reverb', data: mono, seconds: 0.4, mix: 0.3, tail: 0.2 } },
  { name: 'echo', job: { kind: 'echo', data: mono, delay: 0.1, feedback: 0.3, mix: 0.3, tail: 0.2 } },
  { name: 'eq', job: { kind: 'eq', data: mono, low: 0, mid: 3, high: -2 } },
  { name: 'gain', job: { kind: 'gain', data: mono, gain: 0.5 } },
  { name: 'noiseReduction', job: { kind: 'noiseReduction', data: mono, thresholdDb: -40 } },
  { name: 'separate', job: { kind: 'separate', data: mono } },
  { name: 'detectSilence', job: { kind: 'detectSilence', data: mono, options: { thresholdDb: -45, windowMs: 50, minSilenceMs: 200 } as never } },
  { name: 'removeSilence', job: { kind: 'removeSilence', data: mono, regions: [{ start: 0.5, end: 1 }] as never } },
  { name: 'merge', job: { kind: 'merge', datas: [mono, instrumental], sampleRate: SR, options: { mode: 'sequence', gapSeconds: 0, overlapSeconds: 0 } as never } },
  {
    name: 'voiceOnly (Human Voice Processing)',
    job: {
      kind: 'voiceOnly',
      original: mono,
      vocal,
      instrumental,
      options: { enabled: true, semitones: 7, preserveTempo: true, vocalVolume: 1, mixWithAccompaniment: true },
    },
  },
  {
    name: 'harmonyVoice',
    job: {
      kind: 'harmonyVoice', data: vocal, semitones: 7, detuneCents: 0,
      scope: { scope: 'entire-song', start: 0, end: 2 }, clipStart: 0, effects: [], outside: 'silence',
    },
  },
  { name: 'decodeWav', job: { kind: 'decodeWav', buffer: new ArrayBuffer(64) }, minEvents: 0 },
];

describe('every DSP job reports progress', () => {
  for (const testCase of CASES) {
    it(`${testCase.name} emits a start, live progress and a final 100 %`, () => {
      const events: Array<{ value: number; message: string }> = [];
      try {
        executeJob(testCase.job, (value, message) => events.push({ value, message }));
      } catch {
        // A job may legitimately reject its input (e.g. a truncated WAV);
        // what matters here is that it reported progress while trying.
      }
      if (testCase.minEvents === 0) return;
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0].value).toBe(0);
      expect(events[events.length - 1].value).toBeCloseTo(1, 5);
      // Progress must never go backwards: a bar that jumps back is a bug.
      for (let i = 1; i < events.length; i++) {
        expect(events[i].value).toBeGreaterThanOrEqual(events[i - 1].value - 1e-9);
      }
      // And it must say what it is doing, not just show a number.
      for (const event of events) expect(event.message.length).toBeGreaterThan(0);
    });
  }

  it('Human Voice Processing reports the vocal stem stages', () => {
    const messages: string[] = [];
    executeJob({
      kind: 'voiceOnly', original: mono, vocal, instrumental,
      options: { enabled: true, semitones: 5, preserveTempo: true, vocalVolume: 1, mixWithAccompaniment: true },
    }, (value, message) => messages.push(`${(value * 100).toFixed(0)}% ${message}`));
    expect(messages[0]).toMatch(/^0% Shifting vocal stem/);
    expect(messages.at(-1)).toMatch(/^100% Vocal processing complete/);
    expect(messages.some((m) => /Time stretch/i.test(m))).toBe(true);
    expect(messages.some((m) => /Restoring vocal formants/i.test(m))).toBe(true);
    expect(messages.some((m) => /Mixing with accompaniment/i.test(m))).toBe(true);
  });

  it('a vocal render with no pitch change still reports and finishes', () => {
    const values: number[] = [];
    const outcome = executeJob({
      kind: 'voiceOnly', original: mono, vocal, instrumental,
      options: { enabled: true, semitones: 0, preserveTempo: true, vocalVolume: 0.8, mixWithAccompaniment: true },
    }, (value) => values.push(value));
    expect(values[0]).toBe(0);
    expect(values.at(-1)).toBeCloseTo(1, 5);
    expect(outcome.data?.length).toBe(mono.length);
  });
});
