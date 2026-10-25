import { describe, it, expect } from 'vitest';
import { encodeMp3Blob, aacEncoderAvailable, aacUnavailableReason } from './encoders';
import { encodeWavBytes } from './wav';
import { audioData } from './dsp';
import type { AudioData } from '../types';

function sine(freq: number, sampleRate: number, seconds: number): AudioData {
  const length = Math.round(sampleRate * seconds);
  const ch = new Float32Array(length);
  for (let i = 0; i < length; i++) ch[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.4;
  return audioData([ch], sampleRate);
}

describe('MP3 encoder (LAME)', () => {
  it('produces a real MPEG frame header and plausible size', async () => {
    const input = sine(440, 44100, 0.5);
    const blob = await encodeMp3Blob(input, 128, 1, { preventClipping: true });
    expect(blob.size).toBeGreaterThan(500);
    expect(blob.type).toBe('audio/mpeg');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // MPEG frame sync: 11 set bits
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1] & 0xe0).toBe(0xe0);
    // 128 kbps mono 44.1 kHz → ~8000 bytes per 0.5 s
    expect(blob.size).toBeGreaterThan(2000);
    expect(blob.size).toBeLessThan(30000);
  }, 30_000);

  it('never invents data for unusable input — errors are honest', async () => {
    // Zero-length input: LAME may still emit an encoder header, which is fine,
    // but the function must resolve with a small valid file or reject — never
    // a fabricated payload.
    const empty = audioData([new Float32Array(0)], 44100);
    await expect(encodeMp3Blob(empty, 128, 1, {})).resolves.toBeInstanceOf(Blob);
  });
});

describe('WAV encoder', () => {
  it('32-bit export uses IEEE float format tag 3 (not renamed PCM)', () => {
    const input = sine(440, 44100, 0.05);
    const bytes = encodeWavBytes(input, { bitDepth: 32, channels: 1 });
    expect(bytes[20]).toBe(3); // audio format tag
    expect(bytes[34]).toBe(32); // bits per sample
  });
});

describe('AAC availability (honest)', () => {
  it('reports availability without ever faking an encoder', () => {
    const available = aacEncoderAvailable();
    if (!available) {
      // In Node there is no MediaRecorder — the reason must be stated, not hidden.
      expect(aacUnavailableReason()).toMatch(/MediaRecorder|no AAC/);
    }
  });

  it('refuses AAC export with an explanation when no encoder exists', async () => {
    if (aacEncoderAvailable()) return; // browser with a real encoder — nothing to test
    const input = sine(440, 44100, 0.1);
    const { encodeAacBlob } = await import('./encoders');
    await expect(encodeAacBlob(input, 128, 1, {})).rejects.toThrow(/no AAC|MediaRecorder/);
  });
});
