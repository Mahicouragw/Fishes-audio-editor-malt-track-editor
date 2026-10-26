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

interface FrameAnalysis {
  magnitude: Float64Array;
  phase: Float64Array;
  /** Loudest bin of this frame, used to normalise the salience cue. */
  maximum: number;
}

const N = 1024;
const HOP = N / 4;
const BINS = N / 2 + 1;

/** Analyse one frame of a channel into magnitude and phase. */
function analyseFrame(
  input: Float32Array,
  frame: number,
  window: Float64Array,
  re: Float64Array,
  im: Float64Array,
): FrameAnalysis {
  const offset = frame * HOP;
  for (let n = 0; n < N; n++) {
    re[n] = (input[offset + n] ?? 0) * window[n];
    im[n] = 0;
  }
  fft(re, im);
  const magnitude = new Float64Array(BINS);
  const phase = new Float64Array(BINS);
  let maximum = 0;
  for (let k = 0; k < BINS; k++) {
    const mag = Math.hypot(re[k], im[k]);
    magnitude[k] = mag;
    phase[k] = Math.atan2(im[k], re[k]);
    if (mag > maximum) maximum = mag;
  }
  return { magnitude, phase, maximum };
}

/** Add one masked frame into the output buffers (overlap-add). */
function synthesiseFrame(
  analysis: FrameAnalysis,
  mask: Float64Array,
  frame: number,
  window: Float64Array,
  output: Float32Array,
  windowSum: Float32Array,
  re: Float64Array,
  im: Float64Array,
): void {
  for (let k = 0; k < BINS; k++) {
    const mag = analysis.magnitude[k] * mask[k];
    const phase = analysis.phase[k];
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
  const offset = frame * HOP;
  for (let n = 0; n < N; n++) {
    const position = offset + n;
    if (position < output.length) {
      output[position] += re[n] * window[n];
      windowSum[position] += window[n] * window[n];
    }
  }
}

/**
 * Low percentile of a bin's magnitude over time.
 *
 * A plain median is a poor background estimate for singing: a sustained voice
 * is present in most frames, so its median is as high as its peak and the
 * voice looks like "repeating background". A low percentile instead tracks the
 * quiet floor, so a steady instrument stays background while a sustained voice
 * reads as foreground.
 */
function percentileSample(
  values: Float32Array,
  frames: number,
  bins: number,
  bin: number,
  percentile = 0.2,
): number {
  const count = Math.min(frames, 64);
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    const frame = Math.floor((i * frames) / count);
    samples.push(values[frame * bins + bin]);
  }
  samples.sort((a, b) => a - b);
  const index = Math.min(samples.length - 1, Math.max(0, Math.floor(samples.length * percentile)));
  return samples[index] ?? 0;
}

/**
 * Weighted overlap-add normalisation.
 *
 * Dividing by the raw sum of squared windows is only correct where the window
 * sum has reached its steady-state value. At the first and last few hops fewer
 * frames overlap, so the divisor is far smaller and the division turns tiny
 * numbers into full-scale spikes — measured at 5.4× the input peak in the
 * separated vocal stem, which is audible as loud clicks at the start and end of
 * every stem. Dividing by the *steady-state* sum instead can only attenuate,
 * and a short raised-cosine fade removes the step at the two edges.
 */
function normaliseOverlapAdd(
  output: Float32Array,
  windowSum: Float32Array,
  frameSize: number,
  hop: number,
): void {
  // Σ w² for a Hann window with 75 % overlap is 1.5; measure it from the middle
  // of the buffer so any window shape is handled correctly.
  const middle = Math.min(output.length - 1, Math.floor(output.length / 2));
  const steady = Math.max(windowSum[middle] || 0, 0.5);
  for (let i = 0; i < output.length; i++) {
    output[i] = windowSum[i] > 0 ? output[i] / steady : 0;
  }
  const fade = Math.min(Math.round(hop * 3), Math.floor(output.length / 8), frameSize);
  if (fade <= 0) return;
  for (let i = 0; i < fade; i++) {
    const gain = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    output[i] *= gain;
    output[output.length - 1 - i] *= gain;
  }
}

/**
 * Approximate vocal isolation, NOT a trained source-separation model.
 *
 * It combines three real signal-processing cues in the STFT domain:
 *  - a REPET-style repeating-background magnitude estimate (low percentile over
 *    sampled frames),
 *  - stereo centre coherence (lead vocals are usually panned centre), and
 *  - harmonic salience (vocal energy forms harmonic peaks).
 * A soft mask is applied to the original phase, and the residual becomes the
 * accompaniment. Instruments that are centred/harmonic can remain in the stem;
 * the UI therefore reports an honest quality score and offers whole-track DSP.
 *
 * The analysis runs in a stream of single frames. The previous version stored
 * every frame's magnitude and phase for every channel, which for a 3½-minute
 * stereo song is roughly a quarter of a gigabyte — enough for a tablet browser
 * to kill the worker outright, leaving the UI on a progress bar that never
 * moves. Two sampled passes (a background estimate, then a mask-and-overlap-add
 * pass with a three-frame ring buffer) keep the working set at a few hundred
 * kilobytes with the same output.
 */
export function separateVocalsLocal(input: AudioData, onProgress?: ProgressFn): SeparationResult {
  if (!input.channels.length || input.length === 0) throw new Error('No audio to separate');
  const originalRate = input.sampleRate;
  const workingRate = Math.min(originalRate, 22050);
  const working = resampleAudio(input, workingRate);
  const isStereo = working.channels.length >= 2;
  const frames = Math.max(1, Math.floor((working.length - N) / HOP) + 1);
  const window = new Float64Array(N);
  for (let i = 0; i < N; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

  const re = new Float64Array(N);
  const im = new Float64Array(N);

  // ---------------------------------------------------------------------
  // Pass 1 — the repeating background. A few dozen frames spread across the
  // song are enough: the background estimate is a low percentile per bin, and
  // sampling cannot bias it towards one section of the track.
  // ---------------------------------------------------------------------
  onProgress?.(0, 'Analysing spectral content');
  const sampleCount = Math.min(frames, 64);
  const sampled: Float64Array[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const frame = Math.floor((i * frames) / sampleCount);
    sampled.push(analyseFrame(working.channels[0], frame, window, re, im).magnitude);
  }
  const background = new Float64Array(BINS);
  for (let k = 0; k < BINS; k++) {
    const values = sampled.map((magnitude) => magnitude[k]).sort((a, b) => a - b);
    background[k] = values[Math.min(values.length - 1, Math.max(0, Math.floor(values.length * 0.15)))] ?? 0;
  }
  sampled.length = 0;
  onProgress?.(0.1, 'Estimating vocal mask');

  // ---------------------------------------------------------------------
  // Pass 2 — mask each frame and overlap-add it straight away. The mask needs
  // one frame of look-ahead on each side (the 3-frame smoothing), so a small
  // ring buffer holds the pending masks. The output of frame f is written once
  // all three contributing masks are known.
  // ---------------------------------------------------------------------
  const outputs = working.channels.map(() => new Float32Array(working.length));
  const windowSums = working.channels.map(() => new Float32Array(working.length));
  // Frame-tagged analyses: the frame that gets written must be the one the mask
  // was smoothed around, not simply the oldest one still pending.
  const analyses: Array<Array<{ frame: number; analysis: FrameAnalysis }>> = working.channels.map(() => []);

  let coherenceSum = 0;
  let maskSum = 0;
  let maskSquared = 0;
  let cells = 0;

  /** Compute the raw (unsmoothed) mask for one frame, for every channel. */
  const rawMask = (frame: number): Float64Array => {
    const left = analyseFrame(working.channels[0], frame, window, re, im);
    const right = isStereo
      ? analyseFrame(working.channels[1], frame, window, re, im)
      : left;
    analyses[0].push({ frame, analysis: left });
    if (working.channels.length > 1) analyses[1].push({ frame, analysis: right });
    const mask = new Float64Array(BINS);
    for (let k = 0; k < BINS; k++) {
      const magnitudeLeft = left.magnitude[k];
      const magnitudeRight = right.magnitude[k];
      const centre = (magnitudeLeft + magnitudeRight) / 2;
      const coherence = isStereo
        ? 1 - Math.abs(magnitudeLeft - magnitudeRight) / (magnitudeLeft + magnitudeRight + 1e-8)
        : 0.45;
      let local = 0;
      let neighbours = 0;
      for (let j = -4; j <= 4; j++) {
        const neighbour = k + j;
        if (neighbour >= 0 && neighbour < BINS && j !== 0) {
          local += (left.magnitude[neighbour] + right.magnitude[neighbour]) / 2;
          neighbours++;
        }
      }
      const harmonic = centre / (local / Math.max(1, neighbours) + 1e-8);
      const repeating = clamp((centre - background[k]) / (centre + 1e-8), 0, 1);
      const frequency = (k * workingRate) / (BINS * 2);
      const band = clamp((frequency - 60) / 90, 0, 1) * clamp((5200 - frequency) / 1200, 0, 1);
      const salience = clamp((harmonic - 0.8) / 2.2, 0, 1);
      const value = clamp(repeating * (0.35 + 0.3 * salience + 0.35 * coherence) * (0.35 + 0.65 * band), 0, 1);
      mask[k] = value;
      coherenceSum += coherence;
      maskSum += value;
      maskSquared += value * value;
    }
    cells += BINS;
    return mask;
  };

  /** 3 frames × 5 bins box smoothing, as the single-frame version did. */
  const smoothMask = (masks: Float64Array[], index: number): Float64Array => {
    const out = new Float64Array(BINS);
    for (let k = 0; k < BINS; k++) {
      let sum = 0;
      let count = 0;
      for (let df = -1; df <= 1; df++) {
        const mask = masks[index + df];
        if (!mask) continue;
        for (let dk = -2; dk <= 2; dk++) {
          const bin = k + dk;
          if (bin >= 0 && bin < BINS) {
            sum += mask[bin];
            count++;
          }
        }
      }
      out[k] = count ? sum / count : 0;
    }
    return out;
  };

  /** Masks still waiting for their right-hand neighbour, oldest first. */
  const pending: Array<{ frame: number; mask: Float64Array }> = [];
  const emit = (frame: number) => {
    // The smoothed mask of `frame` needs frames -1, 0, +1; a neighbour outside
    // the song is skipped, matching the previous edge behaviour.
    const masks = pending.slice(0, 3);
    const centre = masks.findIndex((entry) => entry.frame === frame);
    const smoothed = smoothMask(masks.map((entry) => entry.mask), Math.max(0, centre));
    for (let c = 0; c < working.channels.length; c++) {
      const index = analyses[c].findIndex((entry) => entry.frame === frame);
      if (index < 0) continue;
      synthesiseFrame(analyses[c][index].analysis, smoothed, frame, window, outputs[c], windowSums[c], re, im);
      // Everything older than this frame will never be written.
      analyses[c].splice(0, index + 1);
    }
    while (pending.length && pending[0].frame <= frame) pending.shift();
  };

  for (let frame = 0; frame < frames; frame++) {
    // rawMask() records the analysis for this frame, so the two stay in step.
    pending.push({ frame, mask: rawMask(frame) });
    // Frame f-1 can only be written once frame f is known.
    if (pending.length === 3) emit(frame - 1);
    if (onProgress && frame % 24 === 0) {
      onProgress(0.1 + (frame / frames) * 0.8, 'Separating vocals');
    }
  }
  // Flush the remaining frames (the last one has no right-hand neighbour).
  while (pending.length) emit(pending[0].frame);

  for (let c = 0; c < working.channels.length; c++) {
    const output = outputs[c];
    const windowSum = windowSums[c];
    normaliseOverlapAdd(output, windowSum, N, HOP);
  }

  const vocalChannels = outputs;
  const instrumentalChannels = working.channels.map((channel, c) => {
    const out = new Float32Array(channel.length);
    for (let i = 0; i < channel.length; i++) out[i] = channel[i] - vocalChannels[c][i];
    return out;
  });
  onProgress?.(0.92, 'Rebuilding stems');

  const mean = maskSum / Math.max(1, cells);
  const variance = Math.max(0, maskSquared / Math.max(1, cells) - mean * mean);
  const avgCoherence = coherenceSum / Math.max(1, cells);
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
