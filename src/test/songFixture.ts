import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audioData } from '../audio/dsp';
import type { AudioData } from '../types';
import { fft } from '../audio/fft';
import { decodeWav, encodeWavBytes } from '../audio/wav';

/** 3 minutes 32 seconds — the duration the specification calls out. */
export const FULL_SONG_SECONDS = 212;

/** Deterministic pseudo-random generator so every run produces the same song. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export interface SongParts {
  /** Lead voice: a drifting, syllable-shaped harmonic tone, centred. */
  vocal: AudioData;
  /** Accompaniment: a steady bass plus percussion-like noise, panned wide. */
  accompaniment: AudioData;
  /** The full stereo mix, exactly what a user uploads. */
  mix: AudioData;
}

/** The lead voice's fundamental, in Hz. */
export const VOCAL_FREQUENCY = 330;
/** The accompaniment bass, in Hz. */
export const ACCOMPANIMENT_FREQUENCY = 110;

/**
 * Build a test song with a separable lead voice over a steady accompaniment.
 * The voice is shaped by a syllable envelope, while the accompaniment stays
 * constant — the cues a real separator relies on. The voice is centred and the
 * accompaniment is panned, like a real mix.
 *
 * `drift` adds a slow vibrato to the voice. It makes the fixture more
 * realistic (and helps the separator), but it also makes the voice
 * non-stationary, so pitch-accuracy measurements use `drift = 0`.
 */
export function buildSong(
  seconds: number,
  sampleRate: number,
  baseFrequency = VOCAL_FREQUENCY,
  drift = 0.01,
): SongParts {
  const length = Math.round(seconds * sampleRate);
  const vocal = new Float32Array(length);
  const accompaniment = new Float32Array(length);
  const mixLeft = new Float32Array(length);
  const mixRight = new Float32Array(length);
  const random = seededRandom(20241015);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const voiceFrequency = baseFrequency * (1 + drift * Math.sin(2 * Math.PI * 0.25 * t));
    const envelope = 0.5 * (1 + Math.sin(2 * Math.PI * 2.5 * t));
    const voice = envelope * 0.35 * (
      Math.sin(2 * Math.PI * voiceFrequency * t)
      + 0.4 * Math.sin(4 * Math.PI * voiceFrequency * t)
      + 0.2 * Math.sin(6 * Math.PI * voiceFrequency * t)
    );
    const bass = 0.2 * Math.sin(2 * Math.PI * ACCOMPANIMENT_FREQUENCY * t);
    const noise = (random() * 2 - 1) * 0.08 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t));
    vocal[i] = voice;
    accompaniment[i] = bass + noise;
    mixLeft[i] = voice + (bass + noise) * 0.6;
    mixRight[i] = voice + (bass + noise) * 0.2 + noise * 0.1;
  }
  return {
    vocal: audioData([vocal], sampleRate),
    accompaniment: audioData([accompaniment], sampleRate),
    mix: audioData([mixLeft, mixRight], sampleRate),
  };
}

const tempDirs: string[] = [];

/**
 * Write real PCM bytes to a real file on disk and read them back. The tests
 * therefore run against an actual audio file, not an in-memory stand-in.
 */
export function writeAudioFile(data: AudioData, name = 'song.wav'): string {
  const dir = mkdtempSync(join(tmpdir(), 'wishes-harmony-'));
  tempDirs.push(dir);
  const path = join(dir, name);
  const bytes = encodeWavBytes(data, { bitDepth: 16, channels: data.channels.length >= 2 ? 2 : 1 });
  writeFileSync(path, bytes);
  return path;
}

/** Read a real audio file back from disk. */
export function readAudioFile(path: string): AudioData {
  const buffer = readFileSync(path);
  return decodeWav(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
}

/** Remove every temporary directory created by the helpers above. */
export function cleanupAudioFiles(): void {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Amplitude of a specific frequency, measured with a Goertzel filter.
 * Used to prove that a pitch really moved (or really did not move).
 */
export function amplitudeAt(signal: Float32Array, sampleRate: number, frequency: number, from = 0, to = signal.length): number {
  const start = Math.max(0, Math.floor(from));
  const end = Math.min(signal.length, Math.floor(to));
  const n = end - start;
  if (n <= 1) return 0;
  const k = (2 * Math.PI * frequency) / sampleRate;
  const coeff = 2 * Math.cos(k);
  let s1 = 0;
  let s2 = 0;
  for (let i = start; i < end; i++) {
    const s0 = signal[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (2 * Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2)) / n;
}

/**
 * Find the strongest partial inside a frequency band.
 *
 * A single-bin DFT is too narrow to measure a tone that drifts by even a
 * fraction of a hertz, so the tests scan a band around the expected
 * frequency. The amplitude is calibrated for the Hann analysis window.
 */
export function bandPeak(
  signal: Float32Array,
  sampleRate: number,
  minHz: number,
  maxHz: number,
): { frequency: number; amplitude: number } {
  const n = 2 ** Math.floor(Math.log2(signal.length || 1));
  if (n < 64) return { frequency: 0, amplitude: 0 };
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    re[i] = signal[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    im[i] = 0;
  }
  fft(re, im);
  const bins = n / 2;
  const lowest = Math.max(1, Math.floor((minHz * n) / sampleRate));
  const highest = Math.min(bins - 1, Math.ceil((maxHz * n) / sampleRate));
  let bestBin = lowest;
  let bestMagnitude = 0;
  for (let k = lowest; k <= highest; k++) {
    const magnitude = Math.hypot(re[k], im[k]);
    if (magnitude > bestMagnitude) {
      bestMagnitude = magnitude;
      bestBin = k;
    }
  }
  // Parabolic interpolation for a sub-bin frequency estimate.
  const left = Math.hypot(re[bestBin - 1] ?? 0, im[bestBin - 1] ?? 0);
  const center = bestMagnitude;
  const right = Math.hypot(re[bestBin + 1] ?? 0, im[bestBin + 1] ?? 0);
  const denominator = left - 2 * center + right;
  const rawDelta = denominator === 0 ? 0 : (0.5 * (left - right)) / denominator;
  const delta = Math.max(-0.5, Math.min(0.5, rawDelta));
  const frequency = ((bestBin + delta) * sampleRate) / n;

  // A single FFT bin loses up to 1.4 dB depending on where the tone falls
  // between bins (scalloping loss). Integrating the Hann main lobe instead
  // gives an amplitude that does not depend on the tone's phase or position.
  let energy = 0;
  for (let k = bestBin - 2; k <= bestBin + 2; k++) {
    if (k < 1 || k >= bins) continue;
    energy += re[k] * re[k] + im[k] * im[k];
  }
  // Parseval for a real tone with a Hann window: sum|X|^2 = 3 A^2 n^2 / 32.
  const amplitude = (4 * Math.sqrt(energy / 3)) / n;
  return { frequency, amplitude };
}

/**
 * Cross-correlate the short-time envelopes of two signals and return the lag
 * (in seconds) at which they line up best. A tempo-preserving pitch shift
 * lines up at lag 0; a speed change would not.
 */
export function envelopeLag(reference: Float32Array, other: Float32Array, sampleRate: number, maxLagSeconds = 0.25): number {
  const frame = Math.max(1, Math.round(0.01 * sampleRate));
  const frames = Math.min(Math.floor(reference.length / frame), Math.floor(other.length / frame));
  if (frames < 4) return 0;
  const envelope = (signal: Float32Array): Float64Array => {
    const out = new Float64Array(frames);
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      for (let i = 0; i < frame; i++) {
        const value = signal[f * frame + i];
        sum += value * value;
      }
      out[f] = Math.sqrt(sum / frame);
    }
    return out;
  };
  const a = envelope(reference);
  const b = envelope(other);
  const maxLag = Math.min(frames - 2, Math.round(maxLagSeconds / 0.01));
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let score = 0;
    let count = 0;
    let meanA = 0;
    let meanB = 0;
    for (let f = 0; f < frames; f++) {
      const j = f + lag;
      if (j < 0 || j >= frames) continue;
      meanA += a[f];
      meanB += b[j];
      count++;
    }
    if (!count) continue;
    meanA /= count;
    meanB /= count;
    for (let f = 0; f < frames; f++) {
      const j = f + lag;
      if (j < 0 || j >= frames) continue;
      score += (a[f] - meanA) * (b[j] - meanB);
    }
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return bestLag * 0.01;
}

/** Peak frequency of the strongest partial inside a band. */
export const bandPeakFrequency = (
  signal: Float32Array,
  sampleRate: number,
  minHz: number,
  maxHz: number,
): number => bandPeak(signal, sampleRate, minHz, maxHz).frequency;

/** Peak amplitude of the strongest partial inside a band. */
export const bandPeakAmplitude = (
  signal: Float32Array,
  sampleRate: number,
  minHz: number,
  maxHz: number,
): number => bandPeak(signal, sampleRate, minHz, maxHz).amplitude;

/**
 * Detect the pitch of a periodic signal with autocorrelation.
 *
 * Autocorrelation finds the *fundamental* even when the signal carries
 * strong harmonics, which a plain FFT peak cannot do reliably. This is what
 * the tests use to prove that a voice really moved by N semitones.
 */
export function detectPitch(signal: Float32Array, sampleRate: number, minHz = 60, maxHz = 1200): number {
  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(signal.length - 1, Math.ceil(sampleRate / minHz));
  if (maxLag <= minLag) return 0;
  let mean = 0;
  for (let i = 0; i < signal.length; i++) mean += signal[i];
  mean /= signal.length;
  const centred = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) centred[i] = signal[i] - mean;

  const correlations = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < centred.length; i++) sum += centred[i] * centred[i + lag];
    correlations[lag] = sum;
  }
  let bestLag = minLag;
  let bestValue = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (correlations[lag] > bestValue) {
      bestValue = correlations[lag];
      bestLag = lag;
    }
  }
  // Parabolic refinement around the winning lag.
  const left = correlations[bestLag - 1] ?? bestValue;
  const center = correlations[bestLag];
  const right = correlations[bestLag + 1] ?? bestValue;
  const denominator = left - 2 * center + right;
  const rawDelta = denominator === 0 ? 0 : (0.5 * (left - right)) / denominator;
  const delta = Math.max(-0.5, Math.min(0.5, rawDelta));
  return sampleRate / (bestLag + delta);
}

/** Semitone ratio helper. */
export const semitoneRatio = (semitones: number): number => 2 ** (semitones / 12);
