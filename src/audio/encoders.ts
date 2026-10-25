import { Mp3Encoder } from '@breezystack/lamejs';
import type { AudioData } from '../types';
import { resampleAudio, softLimit } from './dsp';
import { layoutChannels } from './wav';
import type { ProgressFn } from './dsp';

export interface EncodeOptions {
  onProgress?: ProgressFn;
  signal?: AbortSignal;
  preventClipping?: boolean;
}

const yieldToUI = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function toInt16(data: Float32Array, offset: number, length: number): Int16Array {
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const sample = Math.max(-1, Math.min(1, data[offset + i] ?? 0));
    out[i] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
  }
  return out;
}

/** Actual MPEG-1 Layer III encoding via the LGPL LAME JavaScript port. */
export async function encodeMp3Blob(
  input: AudioData,
  bitrate: number,
  channels: 1 | 2,
  options: EncodeOptions = {},
): Promise<Blob> {
  const supportedRates = [32000, 44100, 48000];
  const targetRate = supportedRates.includes(input.sampleRate)
    ? input.sampleRate
    : supportedRates.reduce((best, rate) =>
        Math.abs(rate - input.sampleRate) < Math.abs(best - input.sampleRate) ? rate : best,
      supportedRates[0]);
  const source = options.preventClipping ? softLimit(resampleAudio(input, targetRate)) : resampleAudio(input, targetRate);
  const channelData = layoutChannels(source, channels);
  const encoder = new Mp3Encoder(channels, targetRate, bitrate);
  const chunks: Uint8Array[] = [];
  const block = 1152;
  for (let offset = 0; offset < source.length; offset += block) {
    if (options.signal?.aborted) throw new DOMException('MP3 encoding cancelled', 'AbortError');
    const length = Math.min(block, source.length - offset);
    const left = toInt16(channelData[0], offset, length);
    const right = channels === 2 ? toInt16(channelData[1], offset, length) : undefined;
    const encoded = encoder.encodeBuffer(left, right);
    if (encoded.length) chunks.push(new Uint8Array(encoded));
    if (offset % (block * 96) === 0) {
      options.onProgress?.(offset / source.length, 'Encoding MP3');
      await yieldToUI();
    }
  }
  const flushed = encoder.flush();
  if (flushed.length) chunks.push(new Uint8Array(flushed));
  if (!chunks.length) throw new Error('The MP3 encoder produced no audio data');
  options.onProgress?.(1, 'MP3 encoding complete');
  return new Blob(chunks.map((c) => c.buffer as ArrayBuffer), { type: 'audio/mpeg' });
}

export const AAC_MIME = 'audio/mp4;codecs=mp4a.40.2';

export function aacEncoderAvailable(): boolean {
  return typeof MediaRecorder !== 'undefined'
    && typeof MediaRecorder.isTypeSupported === 'function'
    && MediaRecorder.isTypeSupported(AAC_MIME);
}

export function aacUnavailableReason(): string {
  if (typeof MediaRecorder === 'undefined') return 'MediaRecorder is not available in this browser.';
  if (!MediaRecorder.isTypeSupported(AAC_MIME)) {
    return 'This browser has no AAC/MP4 encoder. Choose WAV or MP3; renaming a file would not encode AAC.';
  }
  return '';
}

/**
 * Real AAC-in-MP4 encoding when the browser exposes it through MediaRecorder.
 * It runs in real time because MediaRecorder has no offline fast path.
 */
export async function encodeAacBlob(
  input: AudioData,
  bitrate: number,
  channels: 1 | 2,
  options: EncodeOptions = {},
): Promise<Blob> {
  if (!aacEncoderAvailable()) throw new Error(aacUnavailableReason());
  const AudioContextCtor = globalThis.AudioContext;
  if (!AudioContextCtor) throw new Error('Web Audio is not available');
  const context = new AudioContextCtor({ sampleRate: input.sampleRate });
  try {
    const source = options.preventClipping ? softLimit(input) : input;
    const buffer = context.createBuffer(channels, source.length, source.sampleRate);
    const channelData = layoutChannels(source, channels);
    for (let c = 0; c < channels; c++) buffer.copyToChannel(channelData[c] as unknown as Float32Array<ArrayBuffer>, c);
    const node = context.createBufferSource();
    node.buffer = buffer;
    const destination = context.createMediaStreamDestination();
    node.connect(destination);
    const recorder = new MediaRecorder(destination.stream, {
      mimeType: AAC_MIME,
      audioBitsPerSecond: bitrate * 1000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    const done = new Promise<void>((resolve, reject) => {
      recorder.onerror = () => reject(new Error('AAC encoding failed'));
      recorder.onstop = () => resolve();
    });
    const startClock = context.currentTime;
    const progressTimer = setInterval(() => {
      if (options.signal?.aborted) return;
      const p = Math.min(0.98, (context.currentTime - startClock) / Math.max(0.001, source.length / source.sampleRate));
      options.onProgress?.(p, 'Encoding AAC in real time');
    }, 200);
    options.signal?.addEventListener('abort', () => {
      if (recorder.state !== 'inactive') recorder.stop();
    }, { once: true });
    recorder.start(250);
    node.start();
    await new Promise<void>((resolve) => {
      node.onended = () => resolve();
    });
    if (recorder.state !== 'inactive') recorder.stop();
    await done;
    clearInterval(progressTimer);
    if (options.signal?.aborted) throw new DOMException('AAC encoding cancelled', 'AbortError');
    if (!chunks.length) throw new Error('AAC encoder produced no data');
    options.onProgress?.(1, 'AAC encoding complete');
    return new Blob(chunks, { type: 'audio/mp4' });
  } finally {
    await context.close();
  }
}
