import {
  applyEQ, applyEcho, applyGain, applyRangeEffect, applyReverb,
  detectSilence, mergeAudio, pitchShift, processVoiceOnly, reduceNoise,
  removeRegions, resampleByRatio, timeStretch,
  type MergeOptions, type ProgressFn, type SilenceOptions, type SilenceRegion, type VoiceOnlyOptions,
} from './dsp';
import { separateVocalsLocal, type SeparationResult } from './separation';
import { decodeWav } from './wav';
import type { AudioData, RangeEffect } from '../types';

/**
 * The DSP job contract shared by the Web Worker and the main-thread fallback.
 * Every long-running operation in the app is a job here so that real browsers
 * run it off the main thread while test environments (no Worker) run the exact
 * same code synchronously.
 */
export type PitchJob = { kind: 'pitch'; data: AudioData; semitones: number };
export type TimeStretchJob = { kind: 'timeStretch'; data: AudioData; factor: number };
export type ResampleJob = { kind: 'resample'; data: AudioData; ratio: number };
export type RangeJob = { kind: 'range'; data: AudioData; effect: RangeEffect };
export type ReverbJob = { kind: 'reverb'; data: AudioData; seconds: number; mix: number; tail: number };
export type EchoJob = { kind: 'echo'; data: AudioData; delay: number; feedback: number; mix: number; tail: number };
export type EqJob = { kind: 'eq'; data: AudioData; low: number; mid: number; high: number };
export type GainJob = { kind: 'gain'; data: AudioData; gain: number };
export type NoiseJob = { kind: 'noiseReduction'; data: AudioData; thresholdDb: number };
export type SeparateJob = { kind: 'separate'; data: AudioData };
export type DetectSilenceJob = { kind: 'detectSilence'; data: AudioData; options: SilenceOptions };
export type RemoveSilenceJob = { kind: 'removeSilence'; data: AudioData; regions: SilenceRegion[] };
export type MergeJob = { kind: 'merge'; datas: AudioData[]; sampleRate: number; options: MergeOptions };
export type VoiceOnlyJob = { kind: 'voiceOnly'; original: AudioData; vocal: AudioData | null; instrumental: AudioData | null; options: VoiceOnlyOptions };
export type DecodeWavJob = { kind: 'decodeWav'; buffer: ArrayBuffer };

export type WorkerJob =
  | PitchJob | TimeStretchJob | ResampleJob | RangeJob | ReverbJob | EchoJob
  | EqJob | GainJob | NoiseJob | SeparateJob | DetectSilenceJob | RemoveSilenceJob
  | MergeJob | VoiceOnlyJob | DecodeWavJob;

export type WorkerRequest = WorkerJob & { id: string };

export type WorkerResponse =
  | { id: string; ok: true; data?: AudioData; result?: unknown }
  | { id: string; ok: false; error: string }
  | { id: string; progress: number; message: string };

/** What a completed job returns. `result` carries non-audio outcomes (silence regions, separation metadata). */
export interface JobOutcome {
  data?: AudioData;
  result?: unknown;
}

/** Execute one DSP job. Pure and synchronous — callers decide threading (worker vs main thread). */
export function executeJob(request: WorkerJob, onProgress?: ProgressFn): JobOutcome {
  const progress: ProgressFn = onProgress ?? (() => undefined);
  let data: AudioData | undefined;
  let result: unknown;
  switch (request.kind) {
    case 'pitch':
      data = pitchShift(request.data, request.semitones, progress);
      break;
    case 'timeStretch':
      data = timeStretch(request.data, request.factor, progress);
      break;
    case 'resample':
      data = resampleByRatio(request.data, request.ratio, progress);
      break;
    case 'range': {
      const r = applyRangeEffect(request.data, request.effect);
      data = r.data;
      result = r;
      break;
    }
    case 'reverb':
      data = applyReverb(request.data, request.seconds, request.mix, request.tail);
      break;
    case 'echo':
      data = applyEcho(request.data, request.delay, request.feedback, request.mix, request.tail);
      break;
    case 'eq':
      data = applyEQ(request.data, request.low, request.mid, request.high);
      break;
    case 'gain':
      data = applyGain(request.data, request.gain);
      break;
    case 'noiseReduction':
      data = reduceNoise(request.data, request.thresholdDb, progress);
      break;
    case 'separate':
      result = separateVocalsLocal(request.data, progress);
      data = (result as SeparationResult).vocal;
      break;
    case 'detectSilence':
      result = detectSilence(request.data, request.options);
      break;
    case 'removeSilence':
      data = removeRegions(request.data, request.regions);
      break;
    case 'merge':
      data = mergeAudio(request.datas, request.sampleRate, request.options);
      break;
    case 'voiceOnly':
      data = processVoiceOnly(request.original, request.vocal, request.instrumental, request.options);
      break;
    case 'decodeWav':
      data = decodeWav(request.buffer);
      break;
    default:
      throw new Error(`Unknown DSP job: ${(request as { kind: string }).kind}`);
  }
  return data ? { data, result } : { result };
}
