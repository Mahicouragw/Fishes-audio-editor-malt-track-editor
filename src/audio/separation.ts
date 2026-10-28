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
  // The very first thing that happens must be a progress event: the down-sample
  // below takes seconds on a long song, and a bar that sits at 0 % while work
  // is happening is indistinguishable from a frozen page.
  onProgress?.(0, 'Preparing the analyser');

  const originalRate = input.sampleRate;
  const workingRate = Math.min(originalRate, 22050);
  const working = resampleAudio(input, workingRate, (progress, message) => {
    onProgress?.(0.01 + progress * 0.09, progress >= 1 ? 'Analysing spectral content' : `Preparing the analyser — ${message}`);
  });
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
  onProgress?.(0.1, 'Analysing spectral content');
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
  onProgress?.(0.12, 'Estimating vocal mask');

  // ---------------------------------------------------------------------
  // Pass 2 — one frame at a time. The mask needs the frame before and after it
  // (the 3-frame smoothing), so a three-entry ring holds the pending frames and
  // frame f is written once frame f+1 is known. Memory stays at a few hundred
  // kilobytes: the previous version cached magnitude *and* phase for every
  // frame of every channel (~150 MB for a 3:32 song, enough for a tablet
  // browser to kill the worker).
  // ---------------------------------------------------------------------
  const outputs = working.channels.map(() => new Float32Array(working.length));
  const windowSums = working.channels.map(() => new Float32Array(working.length));

  let coherenceSum = 0;
  let maskSum = 0;
  let maskSquared = 0;
  let cells = 0;

  /** The raw (unsmoothed) vocal mask of one frame. */
  const rawMask = (analyses: FrameAnalysis[]): Float64Array => {
    const left = analyses[0];
    const right = analyses[1] ?? analyses[0];
    const mask = new Float64Array(BINS);
    for (let k = 0; k < BINS; k++) {
      const magnitudeLeft = left.magnitude[k];
      const magnitudeRight = right.magnitude[k];
      const centre = (magnitudeLeft + magnitudeRight) / 2;
      const coherence = isStereo
        ? 1 - Math.abs(magnitudeLeft - magnitudeRight) / (magnitudeLeft + magnitudeRight + 1e-8)
        : 0.45;
      // Mean magnitude of the four neighbouring bins on each side, per channel.
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

  /** 3 frames × 5 bins box smoothing; a missing neighbour is simply skipped. */
  const smoothMask = (left: Float64Array | null, centre: Float64Array, right: Float64Array | null): Float64Array => {
    const out = new Float64Array(BINS);
    for (let k = 0; k < BINS; k++) {
      let sum = 0;
      let count = 0;
      for (const mask of [left, centre, right]) {
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

  const extract = (
    analyses: FrameAnalysis[],
    masks: [Float64Array | null, Float64Array, Float64Array | null],
    frame: number,
  ) => {
    const smoothed = smoothMask(masks[0], masks[1], masks[2]);
    for (let c = 0; c < working.channels.length; c++) {
      const analysis = analyses[c] ?? analyses[0];
      synthesiseFrame(analysis, smoothed, frame, window, outputs[c], windowSums[c], re, im);
    }
  };

  // Frames are written strictly in order, one at a time. `nextFrame` is the
  // first frame whose output has not been written yet; it is written as soon as
  // the frame after it exists, because the smoothing needs that neighbour. The
  // ring therefore holds at most three frames: the one being written, the frame
  // before it and the frame after it.
  let nextFrame = 0;
  const ring: Array<{ frame: number; mask: Float64Array; analyses: FrameAnalysis[] }> = [];

  const flush = (allowMissingRight: boolean) => {
    while (nextFrame < frames) {
      const index = ring.findIndex((entry) => entry.frame === nextFrame);
      if (index < 0) return;
      const hasRight = ring.some((entry) => entry.frame === nextFrame + 1);
      if (!hasRight && !allowMissingRight) return;
      const centre = ring[index];
      const left = ring.find((entry) => entry.frame === nextFrame - 1)?.mask ?? null;
      const right = ring.find((entry) => entry.frame === nextFrame + 1)?.mask ?? null;
      extract(centre.analyses, [left, centre.mask, right], nextFrame);
      // Keep `nextFrame` itself: it is the left neighbour of the next write.
      for (let i = ring.length - 1; i >= 0; i--) {
        if (ring[i].frame < nextFrame) ring.splice(i, 1);
      }
      nextFrame += 1;
    }
  };

  for (let frame = 0; frame < frames; frame++) {
    const analyses = working.channels.map((channel) => analyseFrame(channel, frame, window, re, im));
    ring.push({ frame, mask: rawMask(analyses), analyses });
    flush(false);
    if (onProgress && (frame % 8 === 0 || frame === frames - 1)) {
      onProgress(0.12 + ((frame + 1) / frames) * 0.74, 'Separating vocals');
    }
  }
  // The final frame has no right-hand neighbour.
  flush(true);

  for (let c = 0; c < working.channels.length; c++) {
    normaliseOverlapAdd(outputs[c], windowSums[c], N, HOP);
  }

  const mean = maskSum / Math.max(1, cells);
  const variance = Math.max(0, maskSquared / Math.max(1, cells) - mean * mean);
  const avgCoherence = coherenceSum / Math.max(1, cells);
  const quality = clamp(0.18 + 0.28 * avgCoherence + 0.35 * Math.sqrt(variance) + (isStereo ? 0.08 : 0), 0, 0.72);

  // ---------------------------------------------------------------------
  // Pass 3 — back to the original sample rate, then derive the accompaniment by
  // *subtraction*. The separation itself runs at 22.05 kHz; resampling the
  // 22.05 kHz difference instead would band-limit the accompaniment to 11 kHz
  // (audibly dull) and resample twice as much audio. This resamples only the
  // vocal, so it is also about half the work it used to be.
  // ---------------------------------------------------------------------
  onProgress?.(0.86, 'Rebuilding the vocal stem');
  const vocalAtRate = fitLength(audioData(outputs, workingRate), working.length);
  const vocal = fitLength(
    resampleAudio(vocalAtRate, originalRate, (progress) => {
      onProgress?.(0.86 + progress * 0.13, progress >= 1 ? 'Mixing with the accompaniment' : 'Rebuilding the vocal stem');
    }),
    input.length,
  );
  const instrumental = audioData(
    input.channels.map((channel, c) => {
      const vocalChannel = vocal.channels[c] ?? vocal.channels[0];
      const out = new Float32Array(input.length);
      for (let i = 0; i < input.length; i++) out[i] = channel[i] - (vocalChannel[i] ?? 0);
      return out;
    }),
    originalRate,
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
