import { applyRangeEffect, pitchShift, processVoiceOnly, timeStretch, reduceNoise, detectSilence, removeRegions, mergeAudio, applyReverb, applyEcho, applyEQ, applyGain, resampleByRatio, type ProgressFn } from './dsp';
import { separateVocalsLocal } from './separation';
import type { AudioData } from '../types';
import { decodeWav } from './wav';

export type WorkerRequest =
  | { id: string; kind: 'pitch'; data: AudioData; semitones: number }
  | { id: string; kind: 'timeStretch'; data: AudioData; factor: number }
  | { id: string; kind: 'resample'; data: AudioData; ratio: number }
  | { id: string; kind: 'range'; data: AudioData; effect: import('../types').RangeEffect }
  | { id: string; kind: 'reverb'; data: AudioData; seconds: number; mix: number; tail: number }
  | { id: string; kind: 'echo'; data: AudioData; delay: number; feedback: number; mix: number; tail: number }
  | { id: string; kind: 'eq'; data: AudioData; low: number; mid: number; high: number }
  | { id: string; kind: 'gain'; data: AudioData; gain: number }
  | { id: string; kind: 'noiseReduction'; data: AudioData; thresholdDb: number }
  | { id: string; kind: 'separate'; data: AudioData }
  | { id: string; kind: 'detectSilence'; data: AudioData; options: import('./dsp').SilenceOptions }
  | { id: string; kind: 'removeSilence'; data: AudioData; regions: import('./dsp').SilenceRegion[] }
  | { id: string; kind: 'merge'; datas: AudioData[]; sampleRate: number; options: import('./dsp').MergeOptions }
  | { id: string; kind: 'voiceOnly'; original: AudioData; vocal: AudioData | null; instrumental: AudioData | null; options: import('./dsp').VoiceOnlyOptions }
  | { id: string; kind: 'decodeWav'; buffer: ArrayBuffer };

export type WorkerResponse =
  | { id: string; ok: true; data?: AudioData; datas?: AudioData[]; result?: unknown; transfer?: ArrayBuffer[] }
  | { id: string; ok: false; error: string }
  | { id: string; progress: number; message: string };

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const progress: ProgressFn = (p, m) => ctx.postMessage({ id: request.id, progress: p, message: m } satisfies WorkerResponse);
  try {
    let data: AudioData | undefined;
    let result: unknown;
    switch (request.kind) {
      case 'pitch': data = pitchShift(request.data, request.semitones, progress); break;
      case 'timeStretch': data = timeStretch(request.data, request.factor, progress); break;
      case 'resample': data = resampleByRatio(request.data, request.ratio, progress); break;
      case 'range': {
        const r = applyRangeEffect(request.data, request.effect);
        data = r.data;
        result = r;
        break;
      }
      case 'reverb': data = applyReverb(request.data, request.seconds, request.mix, request.tail); break;
      case 'echo': data = applyEcho(request.data, request.delay, request.feedback, request.mix, request.tail); break;
      case 'eq': data = applyEQ(request.data, request.low, request.mid, request.high); break;
      case 'gain': data = applyGain(request.data, request.gain); break;
      case 'noiseReduction': data = reduceNoise(request.data, request.thresholdDb, progress); break;
      case 'separate': result = separateVocalsLocal(request.data, progress); data = (result as { vocal: AudioData }).vocal; break;
      case 'detectSilence': result = detectSilence(request.data, request.options); break;
      case 'removeSilence': data = removeRegions(request.data, request.regions); break;
      case 'merge': data = mergeAudio(request.datas, request.sampleRate, request.options); break;
      case 'voiceOnly': data = processVoiceOnly(request.original, request.vocal, request.instrumental, request.options); break;
      case 'decodeWav': data = decodeWav(request.buffer); break;
      default: throw new Error('Unknown worker request');
    }
    if (data) ctx.postMessage({ id: request.id, ok: true, data, result } satisfies WorkerResponse);
    else ctx.postMessage({ id: request.id, ok: true, result } satisfies WorkerResponse);
  } catch (error) {
    ctx.postMessage({ id: request.id, ok: false, error: (error as Error).message } satisfies WorkerResponse);
  }
};
