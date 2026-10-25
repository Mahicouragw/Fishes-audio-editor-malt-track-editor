import type { AudioData } from '../types';
import { clamp } from '../types';
import { audioData } from './dsp';

export interface WavOptions {
  bitDepth: 16 | 24 | 32;
  channels: 1 | 2;
  sampleRate?: number;
}

/** Mix or duplicate channels to the requested output layout. */
export function layoutChannels(data: AudioData, channels: 1 | 2): Float32Array[] {
  if (channels === 1) {
    const mono = new Float32Array(data.length);
    for (const ch of data.channels) for (let i = 0; i < data.length; i++) mono[i] += ch[i];
    if (data.channels.length > 1) for (let i = 0; i < data.length; i++) mono[i] /= data.channels.length;
    return [mono];
  }
  if (data.channels.length >= 2) return [new Float32Array(data.channels[0]), new Float32Array(data.channels[1])];
  return [new Float32Array(data.channels[0]), new Float32Array(data.channels[0])];
}

/** Real PCM/float WAV encoder. 32-bit uses IEEE float (format 3), not renamed PCM. */
export function encodeWavBytes(data: AudioData, options: WavOptions): Uint8Array {
  const { bitDepth, channels } = options;
  const sampleRate = options.sampleRate ?? data.sampleRate;
  const channelData = layoutChannels(data, channels);
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const dataSize = data.length * blockAlign;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeText(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < data.length; i++) {
    for (let c = 0; c < channels; c++) {
      const sample = clamp(channelData[c][i] ?? 0, -1, 1);
      if (bitDepth === 16) {
        view.setInt16(offset, Math.round(sample * 32767), true);
        offset += 2;
      } else if (bitDepth === 24) {
        const value = Math.round(sample * 8388607);
        bytes[offset] = value & 0xff;
        bytes[offset + 1] = (value >> 8) & 0xff;
        bytes[offset + 2] = (value >> 16) & 0xff;
        offset += 3;
      } else {
        view.setFloat32(offset, sample, true);
        offset += 4;
      }
    }
  }
  return bytes;
}

export function encodeWavBlob(data: AudioData, options: WavOptions): Blob {
  const bytes = encodeWavBytes(data, options);
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/wav' });
}

/** Decode PCM/float WAV for tests and as a fallback when a browser decoder is unavailable. */
export function decodeWav(buffer: ArrayBuffer): AudioData {
  const view = new DataView(buffer);
  if (view.byteLength < 44) throw new Error('WAV file is too short');
  const text = (offset: number) => String.fromCharCode(...new Uint8Array(buffer, offset, 4));
  if (text(0) !== 'RIFF' || text(8) !== 'WAVE') throw new Error('Not a WAV file');
  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= view.byteLength) {
    const chunk = text(offset);
    const size = view.getUint32(offset + 4, true);
    if (chunk === 'fmt ') {
      format = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true);
    } else if (chunk === 'data') {
      dataOffset = offset + 8;
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset < 0 || !sampleRate || !channels) throw new Error('Invalid WAV header');
  if (!((format === 1 && (bits === 16 || bits === 24)) || (format === 3 && bits === 32))) {
    throw new Error(`Unsupported WAV encoding: format ${format}, ${bits} bit`);
  }
  const bytesPerSample = bits / 8;
  const length = Math.floor(dataSize / (bytesPerSample * channels));
  const output = Array.from({ length: channels }, () => new Float32Array(length));
  let cursor = dataOffset;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < channels; c++) {
      let sample = 0;
      if (bits === 16) {
        sample = view.getInt16(cursor, true) / 32768;
      } else if (bits === 24) {
        const byte = new Uint8Array(buffer, cursor, 3);
        let value = byte[0] | (byte[1] << 8) | (byte[2] << 16);
        if (value & 0x800000) value |= ~0xffffff;
        sample = value / 8388608;
      } else {
        sample = view.getFloat32(cursor, true);
      }
      output[c][i] = sample;
      cursor += bytesPerSample;
    }
  }
  return audioData(output, sampleRate);
}
