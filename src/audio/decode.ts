import type { AudioData } from '../types';
import { audioData, peak } from './dsp';
import { decodeWav, encodeWavBlob } from './wav';
import { ensurePcmWorklet } from './worklet';
import type { ProgressFn } from './dsp';

export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'webm'];
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'mov'];

let decodingContext: AudioContext | null = null;

function getDecodingContext(): AudioContext {
  if (!globalThis.AudioContext) throw new Error('Web Audio decoding is not available in this browser.');
  if (!decodingContext || decodingContext.state === 'closed') decodingContext = new AudioContext();
  return decodingContext;
}

export function extensionOf(name: string): string {
  return name.toLowerCase().split('.').pop() ?? '';
}

export function validateMediaFile(file: File, kind: 'audio' | 'video', maxSizeMB: number): string | null {
  if (!file || file.size === 0) return 'The selected file is empty.';
  if (file.size > maxSizeMB * 1024 * 1024) {
    return `The file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the current limit is ${maxSizeMB} MB.`;
  }
  const ext = extensionOf(file.name);
  const type = file.type.toLowerCase();
  if (kind === 'audio') {
    const looksAudio = type.startsWith('audio/') || AUDIO_EXTENSIONS.includes(ext) || VIDEO_EXTENSIONS.includes(ext);
    return looksAudio ? null : 'Unsupported audio type. Choose WAV, MP3, M4A/AAC, OGG, FLAC, or a supported WebM file.';
  }
  const looksVideo = type.startsWith('video/') || VIDEO_EXTENSIONS.includes(ext);
  return looksVideo ? null : 'Unsupported video type. Choose MP4 or WebM with a browser-supported audio track.';
}

function audioBufferToData(buffer: AudioBuffer): AudioData {
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => {
    const src = buffer.getChannelData(c) as unknown as ArrayLike<number>;
    return new Float32Array(src as unknown as Float32Array);
  });
  return audioData(channels, buffer.sampleRate);
}

export async function audioDataToAudioBuffer(context: BaseAudioContext, data: AudioData): Promise<AudioBuffer> {
  const buffer = context.createBuffer(data.channels.length, data.length, data.sampleRate);
  for (let c = 0; c < data.channels.length; c++) buffer.copyToChannel(data.channels[c] as unknown as Float32Array<ArrayBuffer>, c);
  return buffer;
}

/** Decode with the browser's real codec support; WAV has a manual PCM fallback. */
export async function decodeAudioFile(file: File, onProgress?: ProgressFn): Promise<AudioData> {
  const arrayBuffer = await file.arrayBuffer();
  onProgress?.(0.2, 'Decoding audio');
  const context = getDecodingContext();
  try {
    const buffer = await context.decodeAudioData(arrayBuffer.slice(0));
    onProgress?.(1, 'Audio decoded');
    return audioBufferToData(buffer);
  } catch (error) {
    if (extensionOf(file.name) === 'wav') {
      try {
        const decoded = decodeWav(arrayBuffer);
        onProgress?.(1, 'WAV decoded with PCM fallback');
        return decoded;
      } catch (fallbackError) {
        throw new Error(`Could not decode WAV: ${(fallbackError as Error).message}`);
      }
    }
    const detail = (error as Error).message ? ` ${(error as Error).message}` : '';
    throw new Error(`This browser cannot decode the audio in this file. Try WAV, MP3, M4A/AAC, OGG, or FLAC.${detail}`);
  }
}

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Video metadata timed out.')), 15_000);
    video.onloadedmetadata = () => {
      clearTimeout(timer);
      resolve();
    };
    video.onerror = () => {
      clearTimeout(timer);
      reject(new Error('The browser could not open this video file.'));
    };
  });
}

/**
 * Extract a real audio track from a video. First tries the browser decoder;
 * otherwise captures PCM through a MediaElementAudioSourceNode in real time.
 * The original video Blob is kept separately by the media store.
 */
export async function extractAudioFromVideo(file: File, onProgress?: ProgressFn): Promise<AudioData> {
  onProgress?.(0.02, 'Reading video');
  try {
    const decoded = await decodeAudioFile(file, (p) => onProgress?.(p * 0.9, 'Decoding embedded audio'));
    onProgress?.(1, 'Extracted embedded audio');
    return decoded;
  } catch {
    // Fall through to real-time PCM capture.
  }
  if (typeof document === 'undefined') throw new Error('Video extraction needs a browser document.');
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.playsInline = true;
  document.body.appendChild(video);
  const metadataReady = waitForMetadata(video);
  video.src = url;
  const context = new AudioContext();
  let source: MediaElementAudioSourceNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  let sink: GainNode | null = null;
  try {
    await metadataReady;
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('The video duration is unavailable.');
    await context.resume();
    await ensurePcmWorklet(context);
    source = context.createMediaElementSource(video);
    worklet = new AudioWorkletNode(context, 'pcm-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    const chunks: Float32Array[][] = [];
    let active = true;
    worklet.port.onmessage = (event: MessageEvent) => {
      if (active && event.data?.type === 'pcm') chunks.push((event.data.channels as Float32Array[]) ?? []);
    };
    worklet.port.postMessage({ type: 'active', value: true });
    sink = context.createGain();
    sink.gain.value = 0;
    source.connect(worklet);
    worklet.connect(sink);
    sink.connect(context.destination);
    onProgress?.(0.08, 'Extracting audio track');
    await video.play();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Audio extraction timed out.')), (video.duration + 20) * 1000);
      const progressTimer = setInterval(() => {
        onProgress?.(0.08 + 0.88 * Math.min(1, video.currentTime / video.duration), 'Extracting audio track');
      }, 250);
      video.onended = () => {
        clearTimeout(timeout);
        clearInterval(progressTimer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timeout);
        clearInterval(progressTimer);
        reject(new Error('Video playback stopped before audio extraction finished.'));
      };
    });
    active = false;
    const frames = chunks.reduce((sum, chunk) => sum + (chunk[0]?.length ?? 0), 0);
    const channelCount = Math.max(1, ...chunks.map((chunk) => chunk.length));
    const channels = Array.from({ length: channelCount }, (_, c) => {
      const out = new Float32Array(frames);
      let offset = 0;
      for (const chunk of chunks) {
        const sourceChannel = chunk[Math.min(c, chunk.length - 1)] ?? chunk[0];
        if (!sourceChannel) continue;
        out.set(sourceChannel, offset);
        offset += sourceChannel.length;
      }
      return out;
    });
    const data = audioData(channels, context.sampleRate);
    if (peak(data) < 1e-5) throw new Error('No audible audio track was found in this video.');
    onProgress?.(1, 'Audio track extracted');
    return data;
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
    source?.disconnect();
    worklet?.disconnect();
    sink?.disconnect();
    if (context.state !== 'closed') await context.close();
  }
}

export function audioDataToWavBlob(data: AudioData): Blob {
  return encodeWavBlob(data, { bitDepth: 16, channels: data.channels.length >= 2 ? 2 : 1 });
}
