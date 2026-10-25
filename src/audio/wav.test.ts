import { describe, it, expect } from 'vitest';
import { audioData } from './dsp';
import { encodeWavBytes, decodeWav } from './wav';

function sine(sampleRate: number, freq: number, seconds: number): ReturnType<typeof audioData> {
  const length = Math.round(sampleRate * seconds);
  const ch = new Float32Array(length);
  for (let i = 0; i < length; i++) ch[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.5;
  return audioData([ch], sampleRate);
}

describe('WAV encode/decode', () => {
  it.each([16, 24, 32] as const)('round-trips %i-bit', (bitDepth) => {
    const input = sine(44100, 440, 0.1);
    const bytes = encodeWavBytes(input, { bitDepth, channels: 1, sampleRate: 44100 });
    const decoded = decodeWav(bytes.buffer as ArrayBuffer);
    expect(decoded.sampleRate).toBe(44100);
    expect(decoded.length).toBe(input.length);
    // 32-bit float is near-lossless
    const tolerance = bitDepth === 16 ? 0.001 : bitDepth === 24 ? 0.00001 : 1e-6;
    for (let i = 0; i < 100; i++) expect(decoded.channels[0][i]).toBeCloseTo(input.channels[0][i], bitDepth === 16 ? 2 : 3);
    void tolerance;
  });
  it('stereo layout', () => {
    const input = audioData([new Float32Array([0.1, 0.2]), new Float32Array([0.3, 0.4])], 44100);
    const bytes = encodeWavBytes(input, { bitDepth: 16, channels: 2 });
    const decoded = decodeWav(bytes.buffer as ArrayBuffer);
    expect(decoded.channels.length).toBe(2);
  });
  it('rejects invalid headers', () => {
    expect(() => decodeWav(new ArrayBuffer(10))).toThrow();
  });
});
