import type { AudioData } from '../types';
import { clamp } from '../types';
import { audioData, fitLength, resampleAudio } from './dsp';
import { fft, ifft } from './fft';
import type { ProgressFn } from './dsp';

export interface SeparationResult {
  vocal: AudioData;
  instrumental: AudioData;
  quality: number;
  method: 'local-approximate' | 'demucs-server';
  message: string;
  warning?: string;
}

interface STFTResult {
  magnitudes: Float32Array[];
  phases: Float32Array[];
  frames: number;
  bins: number;
  sampleRate: number;
  length: number;
}

function analyseSTFT(data: AudioData, onProgress?: ProgressFn): STFTResult {
  const N = 1024;
  const hop = N / 4;
  const bins = N / 2 + 1;
  const frames = Math.max(1, Math.floor((data.length - N) / hop) + 1);
  const window = new Float64Array(N);
  for (let i = 0; i < N; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const magnitudes = data.channels.map(() => new Float32Array(frames * bins));
  const phases = data.channels.map(() => new Float32Array(frames * bins));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let frame = 0; frame < frames; frame++) {
    for (let c = 0; c < data.channels.length; c++) {
      const input = data.channels[c];
      for (let n = 0; n < N; n++) {
        re[n] = (input[frame * hop + n] ?? 0) * window[n];
        im[n] = 0;
      }
      fft(re, im);
      for (let k = 0; k < bins; k++) {
        magnitudes[c][frame * bins + k] = Math.hypot(re[k], im[k]);
        phases[c][frame * bins + k] = Math.atan2(im[k], re[k]);
      }
    }
    if (onProgress && frame % 24 === 0) onProgress((frame / frames) * 0.35, 'Analysing spectral content');
  }
  return { magnitudes, phases, frames, bins, sampleRate: data.sampleRate, length: data.length };
}

function reconstruct(mask: Float32Array, stft: STFTResult, channel: number, onProgress?: ProgressFn): Float32Array {
  const N = (stft.bins - 1) * 2;
  const hop = N / 4;
  const window = new Float64Array(N);
  for (let i = 0; i < N; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const output = new Float32Array(stft.length);
  const windowSum = new Float32Array(stft.length);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let frame = 0; frame < stft.frames; frame++) {
    const offset = frame * stft.bins;
    for (let k = 0; k < stft.bins; k++) {
      const mag = stft.magnitudes[channel][offset + k] * mask[offset + k];
      const phase = stft.phases[channel][offset + k];
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
      const position = frame * hop + n;
      if (position < output.length) {
        output[position] += re[n] * window[n];
        windowSum[position] += window[n] * window[n];
      }
    }
    if (onProgress && frame % 24 === 0) onProgress(0.6 + (frame / stft.frames) * 0.2, 'Rebuilding stems');
  }
  for (let i = 0; i < output.length; i++) output[i] = windowSum[i] > 1e-8 ? output[i] / windowSum[i] : 0;
  return output;
}

function medianSample(values: Float32Array, frames: number, bins: number, bin: number): number {
  const count = Math.min(frames, 64);
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    const frame = Math.floor((i * frames) / count);
    samples.push(values[frame * bins + bin]);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? 0;
}

/**
 * Approximate vocal isolation, NOT a trained source-separation model.
 *
 * It combines three real signal-processing cues in the STFT domain:
 *  - a REPET-style repeating-background magnitude estimate (median over time),
 *  - stereo centre coherence (lead vocals are usually panned centre), and
 *  - harmonic salience (vocal energy forms harmonic peaks).
 * A soft mask is applied to the original phase, and the residual becomes the
 * accompaniment. Instruments that are centred/harmonic can remain in the stem;
 * the UI therefore reports an honest quality score and offers whole-track DSP.
 */
export function separateVocalsLocal(input: AudioData, onProgress?: ProgressFn): SeparationResult {
  if (!input.channels.length || input.length === 0) throw new Error('No audio to separate');
  const originalRate = input.sampleRate;
  const workingRate = Math.min(originalRate, 22050);
  const working = resampleAudio(input, workingRate);
  const stft = analyseSTFT(working, onProgress);
  const { frames, bins, magnitudes } = stft;
  const mask = new Float32Array(frames * bins);
  const isStereo = working.channels.length >= 2;
  let coherenceSum = 0;
  let maskSum = 0;
  let maskSquared = 0;
  const background = new Float32Array(bins);
  for (let k = 0; k < bins; k++) background[k] = medianSample(magnitudes[0], frames, bins, k);
  for (let frame = 0; frame < frames; frame++) {
    for (let k = 0; k < bins; k++) {
      const index = frame * bins + k;
      const left = magnitudes[0][index];
      const right = isStereo ? magnitudes[1][index] : left;
      const centre = (left + right) / 2;
      const coherence = isStereo ? 1 - Math.abs(left - right) / (left + right + 1e-8) : 0.45;
      let local = 0;
      let neighbours = 0;
      for (let j = -4; j <= 4; j++) {
        const neighbour = k + j;
        if (neighbour >= 0 && neighbour < bins && j !== 0) {
          local += (magnitudes[0][frame * bins + neighbour] + right) / 2;
          neighbours++;
        }
      }
      const harmonic = centre / (local / Math.max(1, neighbours) + 1e-8);
      const repeating = clamp((centre - background[k] * 1.15) / (centre + 1e-8), 0, 1);
      const frequency = (k * workingRate) / (bins * 2);
      const band = clamp((frequency - 60) / 90, 0, 1) * clamp((5200 - frequency) / 1200, 0, 1);
      const salience = clamp((harmonic - 0.8) / 2.2, 0, 1);
      const value = clamp(repeating * (0.45 + 0.35 * salience + 0.2 * coherence) * (0.35 + 0.65 * band), 0, 1);
      mask[index] = value;
      coherenceSum += coherence;
      maskSum += value;
      maskSquared += value * value;
    }
    if (onProgress && frame % 24 === 0) onProgress(0.35 + (frame / frames) * 0.25, 'Estimating vocal mask');
  }
  // Light 3-frame / 3-bin smoothing reduces musical noise.
  const smoothed = new Float32Array(mask.length);
  for (let frame = 0; frame < frames; frame++) {
    for (let k = 0; k < bins; k++) {
      let sum = 0;
      let count = 0;
      for (let df = -1; df <= 1; df++) {
        for (let dk = -2; dk <= 2; dk++) {
          const f = frame + df;
          const b = k + dk;
          if (f >= 0 && f < frames && b >= 0 && b < bins) {
            sum += mask[f * bins + b];
            count++;
          }
        }
      }
      smoothed[frame * bins + k] = count ? sum / count : 0;
    }
  }
  const vocalChannels = working.channels.map((_, c) => reconstruct(smoothed, stft, c, onProgress));
  const instrumentalChannels = working.channels.map((ch, c) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = ch[i] - vocalChannels[c][i];
    return out;
  });
  const mean = maskSum / (frames * bins);
  const variance = Math.max(0, maskSquared / (frames * bins) - mean * mean);
  const avgCoherence = coherenceSum / (frames * bins);
  const quality = clamp(0.18 + 0.28 * avgCoherence + 0.35 * Math.sqrt(variance) + (isStereo ? 0.08 : 0), 0, 0.72);
  const vocal = fitLength(
    resampleAudio(fitLength(audioData(vocalChannels, workingRate), working.length), originalRate),
    input.length,
  );
  const instrumental = fitLength(
    resampleAudio(fitLength(audioData(instrumentalChannels, workingRate), working.length), originalRate),
    input.length,
  );
  const message = `Approximate local isolation ready — estimated confidence ${(quality * 100).toFixed(0)}%.`;
  const warning = isStereo
    ? 'Centred instruments may remain in the vocal stem. This is signal processing, not a trained vocal-separation model.'
    : 'Mono audio has no stereo centre cue, so isolation quality is low. A Demucs server or whole-track processing is recommended.';
  onProgress?.(1, 'Vocal isolation complete');
  return {
    vocal,
    instrumental,
    quality,
    method: 'local-approximate',
    message,
    warning,
  };
}
