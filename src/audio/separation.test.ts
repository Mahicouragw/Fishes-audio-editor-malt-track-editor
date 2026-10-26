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

  it('never amplifies the signal: the stems stay inside the input peak', () => {
    // Regression: the overlap-add divided by the *partial* window sum at the
    // first and last hops, which turned tiny numbers into full-scale clicks —
    // measured at 5.4x the input peak, audible at the start of every stem.
    const sr = 22050;
    const seconds = 3;
    const n = Math.round(sr * seconds);
    const build = () => {
      const ch = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        let v = 0;
        for (let h = 1; h * 220 < 5000; h++) v += Math.sin((2 * Math.PI * h * 220 * t) / h);
        ch[i] = 0.1 * v;
      }
      return ch;
    };
    const input = audioData([build(), build()], sr);
    const result = separateVocalsLocal(input);
    const peakOf = (channels: Float32Array[]) => {
      let peak = 0;
      for (const channel of channels) for (const value of channel) peak = Math.max(peak, Math.abs(value));
      return peak;
    };
    const inputPeak = peakOf(input.channels);
    expect(peakOf(result.vocal.channels)).toBeLessThanOrEqual(inputPeak * 1.05);
    expect(peakOf(result.instrumental.channels)).toBeLessThanOrEqual(inputPeak * 1.05);
    // And the two stems reconstruct the original exactly (the mask conserves
    // energy), so the accompaniment is not a guess.
    let worst = 0;
    for (let c = 0; c < input.channels.length; c++) {
      for (let i = 0; i < input.length; i++) {
        worst = Math.max(worst, Math.abs(result.vocal.channels[c][i] + result.instrumental.channels[c][i] - input.channels[c][i]));
      }
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('reports monotonic progress from 0 to 100 % on stereo input', () => {
    // Regression: the progress bar stayed at 0 % for an entire song because no
    // events were emitted at all; a non-monotonic sequence makes the bar jump
    // backwards, which looks just as broken.
    const sr = 22050;
    const n = sr * 2;
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) ch[i] = Math.sin((2 * Math.PI * 220 * i) / sr) * 0.4;
    const events: Array<{ p: number; message: string }> = [];
    separateVocalsLocal(audioData([ch, ch], sr), (p, message) => events.push({ p, message }));
    expect(events.length).toBeGreaterThan(5);
    expect(events[0].p).toBe(0);
    expect(events[events.length - 1].p).toBe(1);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].p).toBeGreaterThanOrEqual(events[i - 1].p);
    }
    expect(events.every((event) => event.message.trim().length > 0)).toBe(true);
    expect(new Set(events.map((event) => event.message)).size).toBeGreaterThan(2);
  });
});
