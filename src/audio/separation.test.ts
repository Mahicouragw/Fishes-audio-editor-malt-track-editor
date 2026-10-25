import { describe, it, expect } from 'vitest';
import { audioData } from './dsp';
import { separateVocalsLocal } from './separation';

function sine(sampleRate: number, freq: number, seconds: number): Float32Array {
  const n = Math.round(sampleRate * seconds);
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.5;
  return ch;
}

describe('separation', () => {
  it('produces vocal and instrumental of same length as input', () => {
    const sr = 22050;
    const left = sine(sr, 220, 0.6);
    const right = sine(sr, 220, 0.6);
    const input = audioData([left, right], sr);
    const result = separateVocalsLocal(input);
    expect(result.vocal.length).toBe(input.length);
    expect(result.instrumental.length).toBe(input.length);
    expect(result.quality).toBeGreaterThanOrEqual(0);
    expect(result.quality).toBeLessThanOrEqual(0.72);
    expect(result.message).toMatch(/Approximate/);
    expect(result.warning).toBeTruthy();
    expect(result.method).toBe('local-approximate');
  });
  it('handles mono input with quality warning', () => {
    const sr = 22050;
    const input = audioData([sine(sr, 330, 0.4)], sr);
    const result = separateVocalsLocal(input);
    expect(result.warning).toMatch(/Mono/);
  });
  it('throws for empty input', () => {
    expect(() => separateVocalsLocal(audioData([], 44100))).toThrow();
  });
});
