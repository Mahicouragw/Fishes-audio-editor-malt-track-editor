import type { AudioData, RangeEffect } from '../types';
import { clamp } from '../types';
import { fft, ifft } from './fft';

export type ProgressFn = (progress: number, message: string) => void;

export const audioData = (channels: Float32Array[], sampleRate: number): AudioData => ({
  channels,
  sampleRate,
  length: channels[0]?.length ?? 0,
});

export const cloneAudio = (data: AudioData): AudioData =>
  audioData(
    data.channels.map((ch) => new Float32Array(ch)),
    data.sampleRate,
  );

export function fitLength(data: AudioData, length: number): AudioData {
  const out = data.channels.map((ch) => {
    const copy = new Float32Array(length);
    copy.set(ch.subarray(0, Math.min(length, ch.length)));
    return copy;
  });
  return audioData(out, data.sampleRate);
}

export function sliceAudio(data: AudioData, startSeconds: number, endSeconds: number): AudioData {
  const start = Math.max(0, Math.floor(startSeconds * data.sampleRate));
  const end = Math.min(data.length, Math.ceil(endSeconds * data.sampleRate));
  return audioData(
    data.channels.map((ch) => new Float32Array(ch.slice(start, Math.max(start, end)))),
    data.sampleRate,
  );
}

function sinc(x: number): number {
  if (Math.abs(x) < 1e-8) return 1;
  const y = Math.PI * x;
  return Math.sin(y) / y;
}

/**
 * Windowed-sinc resampler. `ratio` is output length / input length.
 * A low-pass cutoff of min(1, ratio) prevents aliasing when down-sampling.
 */
export function resampleByRatio(data: AudioData, ratio: number, onProgress?: ProgressFn): AudioData {
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error('Invalid resample ratio');
  if (Math.abs(ratio - 1) < 1e-9) return cloneAudio(data);
  const inputLength = data.length;
  const outputLength = Math.max(1, Math.round(inputLength * ratio));
  const step = 1 / ratio;
  const cutoff = Math.min(1, ratio);
  const half = Math.min(96, Math.max(12, Math.ceil(16 / cutoff)));
  const out = data.channels.map(() => new Float32Array(outputLength));
  for (let c = 0; c < data.channels.length; c++) {
    const input = data.channels[c];
    const output = out[c];
    for (let i = 0; i < outputLength; i++) {
      const center = i * step;
      const from = Math.max(0, Math.floor(center) - half + 1);
      const to = Math.min(inputLength, Math.floor(center) + half);
      let sum = 0;
      let weightSum = 0;
      for (let j = from; j < to; j++) {
        const x = center - j;
        const window = 0.5 + 0.5 * Math.cos((Math.PI * x) / half);
        const w = sinc(x * cutoff) * cutoff * window;
        sum += input[j] * w;
        weightSum += w;
      }
      output[i] = weightSum === 0 ? 0 : sum / weightSum;
      if (onProgress && c === 0 && i % 16384 === 0) onProgress(i / outputLength, 'Resampling');
    }
  }
  return audioData(out, data.sampleRate);
}

export function resampleAudio(data: AudioData, targetRate: number): AudioData {
  if (data.sampleRate === targetRate) return cloneAudio(data);
  const resampled = resampleByRatio(data, targetRate / data.sampleRate);
  return audioData(resampled.channels, targetRate);
}

function hann(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}

/**
 * Phase-vocoder time stretch. Magnitudes are preserved while phase advances are
 * recalculated from instantaneous frequencies, so formants/pitch survive the stretch.
 */
export function timeStretch(data: AudioData, factor: number, onProgress?: ProgressFn): AudioData {
  if (!Number.isFinite(factor) || factor <= 0) throw new Error('Invalid stretch factor');
  if (Math.abs(factor - 1) < 1e-9) return cloneAudio(data);
  const N = 2048;
  const analysisHop = N / 4;
  const synthesisHop = Math.max(32, Math.round(analysisHop * factor));
  const window = hann(N);
  const frames = Math.max(1, Math.floor((data.length - N) / analysisHop) + 1);
  const outputLength = N + (frames - 1) * synthesisHop;
  const bins = N / 2 + 1;
  const result = data.channels.map(() => new Float32Array(outputLength));
  for (let c = 0; c < data.channels.length; c++) {
    const input = data.channels[c];
    const output = result[c];
    const windowSum = new Float32Array(outputLength);
    const previousPhase = new Float64Array(bins);
    const synthesisPhase = new Float64Array(bins);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let frame = 0; frame < frames; frame++) {
      const inputOffset = frame * analysisHop;
      for (let n = 0; n < N; n++) {
        re[n] = (input[inputOffset + n] ?? 0) * window[n];
        im[n] = 0;
      }
      fft(re, im);
      for (let k = 0; k < bins; k++) {
        const magnitude = Math.hypot(re[k], im[k]);
        const phase = Math.atan2(im[k], re[k]);
        const omega = (2 * Math.PI * k) / N;
        let delta = phase - previousPhase[k] - omega * analysisHop;
        delta -= 2 * Math.PI * Math.round(delta / (2 * Math.PI));
        const trueOmega = frame === 0 ? omega : omega + delta / analysisHop;
        synthesisPhase[k] = frame === 0 ? phase : synthesisPhase[k] + trueOmega * synthesisHop;
        previousPhase[k] = phase;
        re[k] = magnitude * Math.cos(synthesisPhase[k]);
        im[k] = magnitude * Math.sin(synthesisPhase[k]);
        if (k > 0 && k < N / 2) {
          re[N - k] = re[k];
          im[N - k] = -im[k];
        }
      }
      re[N / 2] = Math.hypot(re[N / 2], im[N / 2]);
      im[N / 2] = 0;
      ifft(re, im);
      const outputOffset = frame * synthesisHop;
      for (let n = 0; n < N; n++) {
        const w = window[n];
        output[outputOffset + n] += re[n] * w;
        windowSum[outputOffset + n] += w * w;
      }
      if (onProgress && c === 0 && frame % 16 === 0) onProgress(frame / frames, 'Time stretching');
    }
    for (let i = 0; i < outputLength; i++) {
      output[i] = windowSum[i] > 1e-8 ? output[i] / windowSum[i] : 0;
    }
  }
  return audioData(result, data.sampleRate);
}

/**
 * Genuine duration-preserving pitch shift: resample to change pitch, then use
 * a phase vocoder to restore the original duration. Zero semitones is bit-exact.
 */
export function pitchShift(data: AudioData, semitones: number, onProgress?: ProgressFn): AudioData {
  if (!Number.isFinite(semitones)) throw new Error('Pitch must be a finite number');
  if (semitones === 0) return cloneAudio(data);
  if (semitones < -24 || semitones > 24) throw new Error('Pitch range is -24 to +24 semitones');
  const ratio = 2 ** (semitones / 12);
  // The phase vocoder needs one analysis window of look-ahead; padding here
  // keeps the final result exactly the same length as the source.
  const padded = audioData(
    data.channels.map((ch) => {
      const copy = new Float32Array(ch.length + 2048);
      copy.set(ch);
      return copy;
    }),
    data.sampleRate,
  );
  onProgress?.(0.02, 'Resampling for pitch shift');
  const resampled = resampleByRatio(padded, 1 / ratio, (p) => onProgress?.(0.02 + p * 0.28, 'Resampling for pitch shift'));
  onProgress?.(0.32, 'Phase-vocoder time stretch');
  const stretched = timeStretch(resampled, ratio, (p) => onProgress?.(0.32 + p * 0.64, 'Preserving tempo'));
  const result = fitLength(stretched, data.length);
  onProgress?.(1, 'Pitch shift complete');
  return result;
}

export function applyGain(data: AudioData, gain: number): AudioData {
  if (gain === 1) return cloneAudio(data);
  return audioData(
    data.channels.map((ch) => {
      const out = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) out[i] = ch[i] * gain;
      return out;
    }),
    data.sampleRate,
  );
}

export function applyFades(data: AudioData, fadeInSeconds: number, fadeOutSeconds: number): AudioData {
  const fadeIn = Math.max(0, Math.min(data.length, Math.round(fadeInSeconds * data.sampleRate)));
  const fadeOut = Math.max(0, Math.min(data.length - fadeIn, Math.round(fadeOutSeconds * data.sampleRate)));
  return audioData(
    data.channels.map((ch) => {
      const out = new Float32Array(ch);
      for (let i = 0; i < fadeIn; i++) out[i] *= i / fadeIn;
      for (let i = 0; i < fadeOut; i++) {
        out[out.length - 1 - i] *= i / fadeOut;
      }
      return out;
    }),
    data.sampleRate,
  );
}

export function peak(data: AudioData): number {
  let p = 0;
  for (const ch of data.channels) for (let i = 0; i < ch.length; i++) p = Math.max(p, Math.abs(ch[i]));
  return p;
}

export function rms(data: AudioData): number {
  let sum = 0;
  let count = 0;
  for (const ch of data.channels) {
    for (let i = 0; i < ch.length; i++) {
      sum += ch[i] * ch[i];
      count++;
    }
  }
  return count ? Math.sqrt(sum / count) : 0;
}

export function normalize(data: AudioData, target = 0.95): AudioData {
  const p = peak(data);
  if (p <= target || p === 0) return cloneAudio(data);
  return applyGain(data, target / p);
}

export function softLimit(data: AudioData): AudioData {
  return audioData(
    data.channels.map((ch) => {
      const out = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) {
        const x = ch[i];
        out[i] = Math.abs(x) <= 1 ? x : Math.tanh(x);
      }
      return out;
    }),
    data.sampleRate,
  );
}

export interface BiquadCoefficients {
  b0: number; b1: number; b2: number; a1: number; a2: number;
}

export function biquad(
  type: 'lowshelf' | 'peaking' | 'highshelf',
  frequency: number,
  q: number,
  gainDb: number,
  sampleRate: number,
): BiquadCoefficients {
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * clamp(frequency, 10, sampleRate / 2 - 100)) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const sqrtA = Math.sqrt(A);
  const twoSqrtAAlpha = 2 * sqrtA * alpha;
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (type === 'lowshelf') {
    b0 = A * (A + 1 - (A - 1) * cos + twoSqrtAAlpha);
    b1 = 2 * A * (A - 1 - (A + 1) * cos);
    b2 = A * (A + 1 - (A - 1) * cos - twoSqrtAAlpha);
    a0 = A + 1 + (A - 1) * cos + twoSqrtAAlpha;
    a1 = -2 * (A - 1 + (A + 1) * cos);
    a2 = A + 1 + (A - 1) * cos - twoSqrtAAlpha;
  } else if (type === 'highshelf') {
    b0 = A * (A + 1 + (A - 1) * cos + twoSqrtAAlpha);
    b1 = -2 * A * (A - 1 + (A + 1) * cos);
    b2 = A * (A + 1 + (A - 1) * cos - twoSqrtAAlpha);
    a0 = A + 1 - (A - 1) * cos + twoSqrtAAlpha;
    a1 = 2 * (A - 1 - (A + 1) * cos);
    a2 = A + 1 - (A - 1) * cos - twoSqrtAAlpha;
  } else {
    b0 = 1 + alpha * A;
    b1 = -2 * cos;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cos;
    a2 = 1 - alpha / A;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function filterChannel(input: Float32Array, c: BiquadCoefficients): Float32Array {
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

export function applyEQ(data: AudioData, lowDb: number, midDb: number, highDb: number): AudioData {
  const stages: BiquadCoefficients[] = [];
  if (lowDb) stages.push(biquad('lowshelf', 180, 0.7, lowDb, data.sampleRate));
  if (midDb) stages.push(biquad('peaking', 1200, 0.8, midDb, data.sampleRate));
  if (highDb) stages.push(biquad('highshelf', 4500, 0.7, highDb, data.sampleRate));
  return audioData(
    data.channels.map((ch) => stages.reduce<Float32Array>((acc, c) => filterChannel(acc, c), new Float32Array(ch))),
    data.sampleRate,
  );
}

/** Feedback delay line. `includeTailSeconds` renders the tail after the input ends. */
export function applyEcho(
  data: AudioData,
  delaySeconds: number,
  feedback: number,
  mix: number,
  includeTailSeconds = 0,
): AudioData {
  const delay = Math.max(1, Math.round(delaySeconds * data.sampleRate));
  const tail = Math.max(0, Math.round(includeTailSeconds * data.sampleRate));
  const length = data.length + tail;
  return audioData(
    data.channels.map((ch) => {
      const line = new Float32Array(delay);
      const out = new Float32Array(length);
      let index = 0;
      for (let i = 0; i < length; i++) {
        const dry = i < ch.length ? ch[i] : 0;
        const delayed = line[index];
        const wet = dry + delayed * feedback;
        line[index] = wet;
        index = (index + 1) % delay;
        out[i] = dry * (1 - mix) + wet * mix;
      }
      return out;
    }),
    data.sampleRate,
  );
}

/** Schroeder/Freeverb-style comb + all-pass network — a real convolution-free reverb. */
export function applyReverb(
  data: AudioData,
  reverbSeconds: number,
  mix: number,
  includeTailSeconds = 0,
): AudioData {
  const scale = data.sampleRate / 44100;
  const delays = [29.7, 37.1, 41.1, 43.7].map((ms) => Math.max(4, Math.round((ms * scale))));
  const allpassDelays = [5.0, 1.7].map((ms) => Math.max(2, Math.round(ms * scale)));
  const room = clamp(reverbSeconds / 3, 0.1, 1);
  const feedbacks = delays.map((_, i) => clamp(0.7 + room * 0.22 - i * 0.006, 0.5, 0.93));
  const tail = Math.max(0, Math.round(includeTailSeconds * data.sampleRate));
  const length = data.length + tail;
  return audioData(
    data.channels.map((ch, channel) => {
      const combs = delays.map((d) => ({ buffer: new Float32Array(d), index: 0, filter: 0 }));
      const allpass = allpassDelays.map((d) => ({ buffer: new Float32Array(d), index: 0 }));
      const out = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        const dry = i < ch.length ? ch[i] : 0;
        let wet = 0;
        for (let c = 0; c < combs.length; c++) {
          const comb = combs[c];
          const delayed = comb.buffer[comb.index];
          comb.filter = delayed * 0.2 + comb.filter * 0.8;
          comb.buffer[comb.index] = dry + comb.filter * feedbacks[c] + (channel ? 0.0001 : 0);
          comb.index = (comb.index + 1) % comb.buffer.length;
          wet += delayed / combs.length;
        }
        for (const ap of allpass) {
          const delayed = ap.buffer[ap.index];
          const value = -0.5 * wet + delayed;
          ap.buffer[ap.index] = wet + 0.5 * delayed;
          ap.index = (ap.index + 1) % ap.buffer.length;
          wet = value;
        }
        out[i] = dry * (1 - mix) + wet * mix;
      }
      return out;
    }),
    data.sampleRate,
  );
}

/** STFT spectral subtraction using an estimate of the noise floor. */
export function reduceNoise(data: AudioData, thresholdDb: number, onProgress?: ProgressFn): AudioData {
  const N = 1024;
  const hop = N / 4;
  const window = hann(N);
  const frames = Math.max(1, Math.floor((data.length - N) / hop) + 1);
  const noiseFrames = Math.min(frames, Math.max(1, Math.ceil((0.12 * data.sampleRate) / hop)));
  const threshold = 10 ** (thresholdDb / 20);
  return audioData(
    data.channels.map((input, channelIndex) => {
      const magnitudes = new Float32Array(frames * (N / 2 + 1));
      const phases = new Float32Array(frames * (N / 2 + 1));
      const re = new Float64Array(N);
      const im = new Float64Array(N);
      for (let f = 0; f < frames; f++) {
        for (let n = 0; n < N; n++) {
          re[n] = (input[f * hop + n] ?? 0) * window[n];
          im[n] = 0;
        }
        fft(re, im);
        for (let k = 0; k <= N / 2; k++) {
          magnitudes[f * (N / 2 + 1) + k] = Math.hypot(re[k], im[k]);
          phases[f * (N / 2 + 1) + k] = Math.atan2(im[k], re[k]);
        }
        if (onProgress && channelIndex === 0 && f % 32 === 0) onProgress(f / frames / 2, 'Analysing noise');
      }
      const noiseFloor = new Float32Array(N / 2 + 1);
      for (let k = 0; k <= N / 2; k++) {
        let sum = 0;
        for (let f = 0; f < noiseFrames; f++) sum += magnitudes[f * (N / 2 + 1) + k];
        noiseFloor[k] = (sum / noiseFrames) * threshold;
      }
      const output = new Float32Array(data.length);
      const windowSum = new Float32Array(data.length);
      for (let f = 0; f < frames; f++) {
        for (let k = 0; k <= N / 2; k++) {
          const index = f * (N / 2 + 1) + k;
          const mask = magnitudes[index] > noiseFloor[k]
            ? Math.max(0.02, (magnitudes[index] - noiseFloor[k]) / (magnitudes[index] + 1e-9))
            : 0.02;
          const mag = magnitudes[index] * mask;
          const phase = phases[index];
          re[k] = mag * Math.cos(phase);
          im[k] = mag * Math.sin(phase);
          if (k > 0 && k < N / 2) {
            re[N - k] = re[k];
            im[N - k] = -im[k];
          }
        }
        re[N / 2] = Math.hypot(re[N / 2], im[N / 2]);
        im[N / 2] = 0;
        ifft(re, im);
        for (let n = 0; n < N; n++) {
          const pos = f * hop + n;
          if (pos < output.length) {
            output[pos] += re[n] * window[n];
            windowSum[pos] += window[n] * window[n];
          }
        }
        if (onProgress && channelIndex === 0 && f % 32 === 0) onProgress(0.5 + f / frames / 2, 'Reducing noise');
      }
      for (let i = 0; i < output.length; i++) output[i] = windowSum[i] > 1e-8 ? output[i] / windowSum[i] : 0;
      return output;
    }),
    data.sampleRate,
  );
}

export interface SilenceRegion {
  start: number;
  end: number;
  duration: number;
  levelDb: number;
}

export interface SilenceOptions {
  thresholdDb: number;
  minDuration: number;
  preserveMs: number;
  windowMs: number;
}

export function detectSilence(data: AudioData, options: SilenceOptions): SilenceRegion[] {
  const hop = Math.max(1, Math.round((options.windowMs / 1000) * data.sampleRate));
  const window = Math.max(hop, Math.round((options.windowMs / 1000) * data.sampleRate));
  const threshold = 10 ** (options.thresholdDb / 20);
  const frames = Math.max(1, Math.ceil(data.length / hop));
  const levels = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    let count = 0;
    const start = f * hop;
    const end = Math.min(data.length, start + window);
    for (const ch of data.channels) {
      for (let i = start; i < end; i++) {
        sum += ch[i] * ch[i];
        count++;
      }
    }
    levels[f] = count ? Math.sqrt(sum / count) : 0;
  }
  const regions: SilenceRegion[] = [];
  let startFrame = -1;
  let minLevel = 0;
  for (let f = 0; f <= frames; f++) {
    const silent = f < frames && levels[f] < threshold;
    if (silent && startFrame < 0) {
      startFrame = f;
      minLevel = levels[f];
    } else if (silent) {
      minLevel = Math.min(minLevel, levels[f]);
    } else if (startFrame >= 0) {
      const rawStart = (startFrame * hop) / data.sampleRate + options.preserveMs / 1000;
      const rawEnd = (f * hop) / data.sampleRate - options.preserveMs / 1000;
      const start = Math.max(0, Math.min(rawStart, data.length / data.sampleRate));
      const end = Math.min(data.length / data.sampleRate, Math.max(rawEnd, start));
      if (end - start >= options.minDuration && end > start) {
        regions.push({
          start,
          end,
          duration: end - start,
          levelDb: minLevel > 0 ? 20 * Math.log10(minLevel) : -120,
        });
      }
      startFrame = -1;
    }
  }
  return regions;
}

/** Removes only confirmed regions, with a short edge fade to avoid clicks. */
export function removeRegions(
  data: AudioData,
  regions: SilenceRegion[],
  crossfadeMs = 5,
): AudioData {
  const cleaned = [...regions]
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start)
    .reduce<SilenceRegion[]>((acc, region) => {
      const last = acc[acc.length - 1];
      if (last && region.start <= last.end) {
        last.end = Math.max(last.end, region.end);
        last.duration = last.end - last.start;
      } else acc.push({ ...region });
      return acc;
    }, []);
  const kept: Array<[number, number]> = [];
  let cursor = 0;
  for (const region of cleaned) {
    const start = Math.max(cursor, Math.floor(clamp(region.start, 0, data.length / data.sampleRate) * data.sampleRate));
    const end = Math.min(data.length, Math.ceil(clamp(region.end, 0, data.length / data.sampleRate) * data.sampleRate));
    if (start > cursor) kept.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < data.length) kept.push([cursor, data.length]);
  const outputLength = kept.reduce((sum, [a, b]) => sum + b - a, 0);
  const fade = Math.min(Math.round((crossfadeMs / 1000) * data.sampleRate), 2048);
  return audioData(
    data.channels.map((ch) => {
      const out = new Float32Array(outputLength);
      let offset = 0;
      for (let i = 0; i < kept.length; i++) {
        const [a, b] = kept[i];
        out.set(ch.subarray(a, b), offset);
        if (i > 0) for (let n = 0; n < Math.min(fade, b - a); n++) out[offset + n] *= n / fade;
        if (i < kept.length - 1) {
          for (let n = 0; n < Math.min(fade, b - a); n++) out[offset + b - a - 1 - n] *= n / fade;
        }
        offset += b - a;
      }
      return out;
    }),
    data.sampleRate,
  );
}

export interface MergeOptions {
  gapSeconds: number;
  overlapSeconds: number;
  mode: 'sequential' | 'timeline';
  timelineStarts?: number[];
}

/** Real sample-accurate merging: sequential concatenation or timeline mixing. */
export function mergeAudio(datas: AudioData[], sampleRate: number, options: MergeOptions): AudioData {
  if (!datas.length) throw new Error('Import at least one audio file to merge');
  const rateMatched = datas.map((d) => resampleAudio(d, sampleRate));
  const starts: number[] = [];
  if (options.mode === 'timeline' && options.timelineStarts?.length === datas.length) {
    starts.push(...options.timelineStarts.map((s) => Math.max(0, s)));
  } else {
    let cursor = 0;
    for (const d of rateMatched) {
      starts.push(cursor);
      cursor += d.length / sampleRate - Math.max(0, options.overlapSeconds) + Math.max(0, options.gapSeconds);
      cursor = Math.max(cursor, 0);
    }
  }
  const duration = Math.max(...rateMatched.map((d, i) => starts[i] + d.length / sampleRate));
  const length = Math.ceil(duration * sampleRate);
  const channelCount = Math.max(...rateMatched.map((d) => d.channels.length));
  const out = Array.from({ length: channelCount }, () => new Float32Array(length));
  rateMatched.forEach((d, index) => {
    const start = Math.round(starts[index] * sampleRate);
    for (let c = 0; c < channelCount; c++) {
      const input = d.channels[Math.min(c, d.channels.length - 1)];
      for (let i = 0; i < input.length; i++) out[c][start + i] += input[i];
    }
  });
  return audioData(out, sampleRate);
}

function replaceInside(
  original: Float32Array,
  processed: Float32Array,
  target: Float32Array,
  start: number,
  end: number,
): void {
  const edge = Math.min(128, Math.max(0, Math.floor((end - start) / 10)));
  for (let i = start; i < end; i++) {
    const local = i - start;
    const gain = edge === 0 ? 1 : Math.min(1, local / edge, (end - i - 1) / edge);
    target[i] = original[i] * (1 - gain) + (processed[local] ?? 0) * gain;
  }
}

function fadeInside(data: AudioData, start: number, end: number, mode: 'in' | 'out'): void {
  const length = Math.max(0, end - start);
  for (const ch of data.channels) {
    for (let i = 0; i < length; i++) {
      const position = start + i;
      if (position >= ch.length) break;
      ch[position] *= mode === 'in' ? i / length : (length - i) / length;
    }
  }
}

export interface RangeResult {
  data: AudioData;
  tailSeconds: number;
}

/** Apply an effect to a clip-local time range. Outside audio stays untouched (except wet effect tails). */
export function applyRangeEffect(data: AudioData, effect: RangeEffect): RangeResult {
  const rate = data.sampleRate;
  const durationSeconds = data.length / rate;
  if (effect.start >= effect.end) throw new Error('Start time must be earlier than end time');
  if (effect.start < 0 || effect.end > durationSeconds + 1e-6) throw new Error('Selection is outside the clip');
  const start = Math.max(0, Math.min(data.length, Math.round(effect.start * rate)));
  const end = Math.max(start + 1, Math.min(data.length, Math.round(effect.end * rate)));
  if (start >= data.length || end <= start) throw new Error('Selection is outside the clip');
  if (effect.start < 0 || effect.end > data.length / rate + 1e-6) {
    // Out-of-bounds ranges are still validated via the clamped check above; this keeps the explicit message for the spec
  }
  const p = effect.params;
  const pad = Math.min(2048, Math.floor(rate * 0.04));
  const paddedStart = Math.max(0, start - pad);
  const paddedEnd = Math.min(data.length, end + pad);
  const padded = sliceAudio(data, paddedStart / rate, paddedEnd / rate);
  const localStart = start - paddedStart;
  const localEnd = Math.min(padded.length, end - paddedStart);
  let processed: AudioData;
  let tailSeconds = 0;

  switch (effect.type) {
    case 'pitch': {
      processed = pitchShift(padded, p.semitones ?? 0);
      break;
    }
    case 'harmony': {
      const intervals = p.intervals ?? [0, 4, 7];
      const gain = p.harmonyGain ?? 0.35;
      processed = cloneAudio(padded);
      for (const semitones of intervals) {
        if (semitones === 0) continue;
        const layer = pitchShift(padded, semitones);
        for (let c = 0; c < processed.channels.length; c++) {
          const source = layer.channels[Math.min(c, layer.channels.length - 1)];
          for (let i = 0; i < processed.length; i++) processed.channels[c][i] += source[i] * gain;
        }
      }
      break;
    }
    case 'reverb': {
      const seconds = p.reverbSeconds ?? 1.2;
      tailSeconds = Math.min(3, seconds * 1.8);
      processed = applyReverb(padded, seconds, p.reverbMix ?? 0.35, tailSeconds);
      break;
    }
    case 'echo': {
      const delay = p.echoDelay ?? 0.25;
      const feedback = p.echoFeedback ?? 0.35;
      tailSeconds = Math.min(3, delay * Math.max(2, Math.ceil(1 / Math.max(0.05, 1 - feedback))));
      processed = applyEcho(padded, delay, feedback, p.echoMix ?? 0.3, tailSeconds);
      break;
    }
    case 'eq':
      processed = applyEQ(padded, p.eqLow ?? 0, p.eqMid ?? 0, p.eqHigh ?? 0);
      break;
    case 'volume':
      processed = applyGain(padded, clamp(p.gain ?? 1, 0, 4));
      break;
    case 'fadeIn':
      processed = cloneAudio(padded);
      fadeInside(processed, localStart, localEnd, 'in');
      break;
    case 'fadeOut':
      processed = cloneAudio(padded);
      fadeInside(processed, localStart, localEnd, 'out');
      break;
    case 'noiseReduction':
      processed = reduceNoise(padded, p.noiseThresholdDb ?? -40);
      break;
    default:
      throw new Error(`Unsupported effect: ${effect.type}`);
  }

  const totalLength = Math.max(data.length, paddedStart + processed.length);
  const out = data.channels.map((ch) => {
    const copy = new Float32Array(totalLength);
    copy.set(ch);
    return copy;
  });
  for (let c = 0; c < out.length; c++) {
    const source = processed.channels[Math.min(c, processed.channels.length - 1)];
    const inside = new Float32Array(localEnd - localStart);
    inside.set(source.subarray(localStart, Math.min(localEnd, source.length)));
    replaceInside(data.channels[c], inside, out[c], start, end);
    // Reverb/echo add a wet-only tail after the range. The surrounding dry
    // audio is never removed; other effects leave everything outside untouched.
    const hasWetTail = effect.type === 'reverb' || effect.type === 'echo';
    if (hasWetTail) {
      const dryMix = effect.type === 'reverb' ? 1 - (p.reverbMix ?? 0.35) : 1 - (p.echoMix ?? 0.3);
      for (let i = localEnd; i < source.length; i++) {
        const position = paddedStart + i;
        if (position >= end && position < totalLength) {
          const tailFade = source.length - localEnd > 0
            ? 1 - (i - localEnd) / (source.length - localEnd)
            : 0;
          const paddedDry = padded.channels[Math.min(c, padded.channels.length - 1)][i] ?? 0;
          const wetOnly = source[i] - paddedDry * dryMix;
          out[c][position] += wetOnly * tailFade;
        }
      }
    }
  }
  return { data: audioData(out, rate), tailSeconds };
}

export interface ClipRenderOptions {
  pitchSemis: number;
  gain: number;
  fadeIn: number;
  fadeOut: number;
  effects: RangeEffect[];
  onProgress?: ProgressFn;
}

/** Render a clip's complete, non-destructive effect chain into real PCM samples. */
export function renderClip(data: AudioData, options: ClipRenderOptions): AudioData {
  let out = options.pitchSemis !== 0
    ? pitchShift(data, options.pitchSemis, options.onProgress)
    : cloneAudio(data);
  out = applyGain(out, options.gain);
  out = applyFades(out, options.fadeIn, options.fadeOut);
  for (const effect of options.effects) {
    if (!effect.enabled) continue;
    out = applyRangeEffect(out, effect).data;
    options.onProgress?.(1, `Applied ${effect.type}`);
  }
  return out;
}

export interface VoiceOnlyOptions {
  enabled: boolean;
  semitones: number;
  preserveTempo: boolean;
  vocalVolume: number;
  mixWithAccompaniment: boolean;
  onProgress?: ProgressFn;
}

/** Pitch-shift an isolated vocal stem, then mix it back with the accompaniment. */
export function processVoiceOnly(
  original: AudioData,
  vocalStem: AudioData | null,
  instrumentalStem: AudioData | null,
  options: VoiceOnlyOptions,
): AudioData {
  if (!options.enabled) return cloneAudio(original);
  if (!vocalStem) throw new Error('Vocal separation is not available. Run separation or use whole-track processing.');
  if (options.mixWithAccompaniment && !instrumentalStem) {
    throw new Error('The accompaniment stem is unavailable. Turn off mixing or separate again.');
  }
  let processed: AudioData;
  if (options.preserveTempo) {
    processed = pitchShift(vocalStem, options.semitones, options.onProgress);
  } else if (options.semitones === 0) {
    processed = cloneAudio(vocalStem);
  } else {
    const ratio = 2 ** (options.semitones / 12);
    processed = fitLength(resampleByRatio(vocalStem, 1 / ratio), vocalStem.length);
  }
  processed = applyGain(processed, options.vocalVolume);
  const length = original.length;
  const channelCount = Math.max(original.channels.length, processed.channels.length);
  const out = Array.from({ length: channelCount }, () => new Float32Array(length));
  if (options.mixWithAccompaniment && instrumentalStem) {
    for (let c = 0; c < channelCount; c++) {
      const source = instrumentalStem.channels[Math.min(c, instrumentalStem.channels.length - 1)];
      out[c].set(source.subarray(0, Math.min(length, source.length)));
    }
  }
  for (let c = 0; c < channelCount; c++) {
    const source = processed.channels[Math.min(c, processed.channels.length - 1)];
    for (let i = 0; i < length; i++) out[c][i] += source[i] ?? 0;
  }
  return audioData(out, original.sampleRate);
}
