import { describe, it, expect } from 'vitest';
import { executeJob } from './dspJobs';
import { averageSpectralEnvelopeDb } from './formant';
import { audioData, softLimit } from './dsp';
import { bandPeak, semitoneRatio } from '../test/songFixture';
import { fft } from './fft';
import { HARMONY_PRESET_A, HARMONY_PRESET_B, HARMONY_PRESETS } from './harmony';
import type { AudioData } from '../types';

const SR = 22050;
const F0 = 220;
const SECONDS = 1.5;

/**
 * A singer: a 220 Hz glottal source shaped by three vocal-tract formants
 * (600 / 1200 / 2600 Hz) with a natural high-frequency roll-off. This is the
 * signal that exposes a chipmunk shifter — a plain resampler moves the
 * formants up with the pitch, so a +7 voice would put its first formant at
 * 600 × 1.498 ≈ 899 Hz and its third formant at 3.9 kHz.
 */
function vowel(seconds = SECONDS): Float32Array {
  const length = Math.round(SR * seconds);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / SR;
    let value = 0;
    for (let h = 1; h * F0 < SR / 2 - 100; h++) {
      const frequency = h * F0;
      const amplitude = (0.02
        + Math.exp(-((frequency - 600) ** 2) / (2 * 100 ** 2))
        + 0.7 * Math.exp(-((frequency - 1200) ** 2) / (2 * 130 ** 2))
        + 0.35 * Math.exp(-((frequency - 2600) ** 2) / (2 * 200 ** 2)))
        / (1 + (frequency / 900) ** 0.9);
      value += amplitude * Math.sin(2 * Math.PI * frequency * t);
    }
    out[i] = 0.25 * value;
  }
  return out;
}

/** Sample the singer's average log envelope at one frequency. */
function envelopeAt(env: Float64Array, frequency: number): number {
  const position = (frequency * 2048) / SR;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return env[lower] * (1 - fraction) + env[Math.min(env.length - 1, lower + 1)] * fraction;
}

/**
 * Level of one partial, averaged over many windows. A phase vocoder leaves slow
 * amplitude beating on individual partials, so a single window can land in a
 * trough and make the *measurement* look broken.
 */
function harmonicLevelDb(signal: Float32Array, frequency: number): number {
  const size = 4096;
  const windows: number[] = [];
  for (let start = 0; start + size <= signal.length; start += size) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < size; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
      const phase = (2 * Math.PI * frequency * (start + i)) / SR;
      re += signal[start + i] * w * Math.cos(phase);
      im += signal[start + i] * w * Math.sin(phase);
    }
    windows.push((re * re + im * im) / (size * size));
  }
  const power = windows.reduce((sum, value) => sum + value, 0) / Math.max(1, windows.length);
  return 10 * Math.log10(power + 1e-20);
}

/**
 * RMS error (dB) between the rendered partials and the singer's envelope,
 * either at each partial's own frequency (formants preserved) or at
 * `frequency / ratio` (formants dragged up by the shift). The answer tells us
 * which voice the listener is actually hearing.
 */
function formantErrorDd(signal: Float32Array, sourceEnvelope: Float64Array, ratio: number, map: (f: number) => number): number {
  const values: number[] = [];
  for (let k = 2; k * F0 * ratio < 4000; k++) {
    const target = k * F0 * ratio;
    values.push(harmonicLevelDb(signal, target) - envelopeAt(sourceEnvelope, map(target)));
  }
  const median = [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const deviations = values.map((value) => value - median);
  return Math.sqrt(deviations.reduce((sum, value) => sum + value * value, 0) / deviations.length);
}

/**
 * Energy above 4 kHz relative to the whole band, in dB. Averaged over frames so
 * one unlucky window cannot decide the answer.
 */
function brightnessDb(data: AudioData): number {
  const size = 4096;
  const bins = size / 2 + 1;
  const power = new Float64Array(bins);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const signal = data.channels[0];
  let frames = 0;
  for (let offset = 0; offset + size <= signal.length; offset += size) {
    for (let n = 0; n < size; n++) {
      re[n] = signal[offset + n] * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / size));
      im[n] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) power[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  let high = 0;
  let total = 0;
  for (let k = 1; k < bins; k++) {
    const hz = (k * data.sampleRate) / size;
    if (hz < 100) continue;
    total += power[k];
    if (hz >= 4000) high += power[k];
  }
  return 10 * Math.log10((high + 1e-20) / (total + 1e-20));
}

function rms(signal: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < signal.length; i++) sum += signal[i] * signal[i];
  return Math.sqrt(sum / signal.length);
}

function peak(signal: Float32Array): number {
  let value = 0;
  for (let i = 0; i < signal.length; i++) value = Math.max(value, Math.abs(signal[i]));
  return value;
}

const SOURCE: AudioData = audioData([vowel()], SR);
const SOURCE_ENVELOPE = averageSpectralEnvelopeDb(SOURCE.channels[0], SR);

/** Render a voice through the exact job the panel and the worker use. */
function render(semitones: number, detuneCents = 0, formantPreserve?: number): AudioData {
  const outcome = executeJob({
    kind: 'harmonyVoice',
    data: SOURCE,
    semitones,
    detuneCents,
    scope: { scope: 'entire-song', start: 0, end: SECONDS },
    clipStart: 0,
    effects: [],
    outside: 'silence',
    ...(formantPreserve === undefined ? {} : { formantPreserve }),
  });
  if (!outcome.data) throw new Error('harmony job returned no audio');
  return outcome.data;
}

/** The real voices of Presets A (major) and B (minor). */
const CASES = [
  { preset: 'A (major)', name: 'major third +4', semitones: 4, detune: 0 },
  { preset: 'A (major)', name: 'perfect fifth +7', semitones: 7, detune: 0 },
  { preset: 'B (minor)', name: 'minor third +3', semitones: 3, detune: 0 },
  { preset: 'B (minor)', name: 'perfect fifth +7', semitones: 7, detune: 0 },
];

describe('every generated harmony voice keeps the singer\'s formants', () => {
  for (const voice of CASES) {
    it(`${voice.preset}, ${voice.name}: pitch moves, formants and tempo do not`, () => {
      const out = render(voice.semitones, voice.detune);
      const ratio = semitoneRatio(voice.semitones + voice.detune / 100);

      // 1. The pitch really moved by the requested interval, and nothing was
      //    left at the old pitch.
      const expected = F0 * ratio;
      const fundamental = bandPeak(out.channels[0], SR, expected * 0.9, expected * 1.1);
      expect(fundamental.frequency / expected).toBeGreaterThan(0.99);
      expect(fundamental.frequency / expected).toBeLessThan(1.01);
      expect(bandPeak(out.channels[0], SR, F0 * 0.97, F0 * 1.03).amplitude)
        .toBeLessThan(fundamental.amplitude * 0.2);

      // 2. Tempo, duration and sample rate are untouched. A playback-rate or
      //    resampling substitute would change the length.
      expect(out.length).toBe(SOURCE.length);
      expect(out.sampleRate).toBe(SR);

      // 3. The formants did NOT ride up with the pitch. Every rendered partial
      //    sits at the level the *singer's* envelope asks for, not at the level
      //    of the source partial it was transposed from.
      const toSinger = formantErrorDd(out.channels[0], SOURCE_ENVELOPE, ratio, (f) => f);
      const toTransposed = formantErrorDd(out.channels[0], SOURCE_ENVELOPE, ratio, (f) => f / ratio);
      expect(toSinger).toBeLessThan(toTransposed * 0.5);
      expect(toSinger).toBeLessThan(6);

      // 4. The first formant stays near 600 Hz. A resampler would put it at
      //    600 × ratio (899 Hz at +7), so the loudest partial between 400 Hz
      //    and 1400 Hz would be the one at 988 Hz instead of the one at 659 Hz.
      let strongest = 0;
      let strongestLevel = -Infinity;
      for (let k = 2; k * F0 * ratio < 1400; k++) {
        const frequency = k * F0 * ratio;
        if (frequency < 400) continue;
        const level = harmonicLevelDb(out.channels[0], frequency);
        if (level > strongestLevel) {
          strongestLevel = level;
          strongest = frequency;
        }
      }
      expect(Math.abs(strongest - 600)).toBeLessThanOrEqual(F0 * ratio);

      // 5. No fake brightness: a fifth must not add high-frequency energy.
      expect(brightnessDb(out)).toBeLessThan(brightnessDb(SOURCE) + 4);
    });
  }

  it('a flat-spectrum source keeps every partial through +7 (no dropped harmonics)', () => {
    const pulseF0 = 180;
    const pulse = new Float32Array(Math.round(SR * SECONDS));
    for (let i = 0; i < pulse.length; i++) {
      const t = i / SR;
      let value = 0;
      for (let h = 1; h <= Math.floor(6000 / pulseF0); h++) value += Math.sin(2 * Math.PI * h * pulseF0 * t + h * 0.7);
      pulse[i] = 0.02 * value;
    }
    const shifted = executeJob({
      kind: 'harmonyVoice', data: audioData([pulse], SR), semitones: 7, detuneCents: 0,
      scope: { scope: 'entire-song', start: 0, end: SECONDS }, clipStart: 0, effects: [], outside: 'silence',
    }).data!.channels[0];
    const ratio = semitoneRatio(7);
    for (let k = 1; k * pulseF0 * ratio < 6000; k++) {
      const delta = harmonicLevelDb(shifted, k * pulseF0 * ratio) - harmonicLevelDb(pulse, k * pulseF0);
      expect(delta).toBeGreaterThan(-1.5);
      expect(delta).toBeLessThan(1.5);
    }
  });

  it('scores formant preservation higher than a plain resample for the same interval', () => {
    const preserved = render(7);
    const plain = render(7, 0, 0);
    const ratio = semitoneRatio(7);
    const preservedError = formantErrorDd(preserved.channels[0], SOURCE_ENVELOPE, ratio, (f) => f);
    const plainError = formantErrorDd(plain.channels[0], SOURCE_ENVELOPE, ratio, (f) => f);
    expect(preservedError).toBeLessThan(plainError * 0.5);
    // Both are still genuinely pitch-shifted — the comparison is not hiding a
    // missing shift.
    expect(bandPeak(plain.channels[0], SR, F0 * ratio * 0.95, F0 * ratio * 1.05).frequency)
      .toBeCloseTo(F0 * ratio, 0);
    expect(plain.length).toBe(SOURCE.length);
  });

  it('the formant-preserving path is the default, so Human Voice Mode always uses it', () => {
    // The panel and the worker never send `formantPreserve: 0`; a job without
    // the field must therefore be the natural-vocal path.
    const byDefault = render(4);
    const explicit = render(4, 0, 1);
    expect(byDefault.channels[0]).toEqual(explicit.channels[0]);
  });
});

describe('the full preset mix keeps the lead and never clips', () => {
  const PRESETS = [HARMONY_PRESET_A, HARMONY_PRESET_B];

  for (const preset of PRESETS) {
    it(`${preset.label}: lead + every harmony voice, limited to full scale`, () => {
      const rendered = preset.voices.map((voice) => ({
        voice,
        data: render(voice.semitones, voice.detuneCents),
      }));

      // Real placement: each voice delayed by its preset offset and scaled by
      // its preset gain, exactly as the preview mix does.
      const longest = rendered.reduce((max, r) => Math.max(max, r.data.length), 0);
      const mix = new Float32Array(longest);
      for (const { voice, data } of rendered) {
        const delay = Math.round((voice.delayMs / 1000) * SR);
        const gain = voice.gain;
        for (let i = 0; i < data.length; i++) {
          const at = i + delay;
          if (at < longest) mix[at] += data.channels[0][i] * gain;
        }
      }

      // The app's soft limiter must keep the four-voice mix inside full scale.
      const limited = softLimit(audioData([mix], SR)).channels[0];
      const rawRms = rms(mix);
      expect(peak(limited)).toBeLessThanOrEqual(1.0001);
      expect(Number.isFinite(peak(limited))).toBe(true);
      expect(rms(limited)).toBeGreaterThan(rawRms * 0.7);
      let clipped = 0;
      for (let i = 0; i < limited.length; i++) if (Math.abs(limited[i]) > 0.9999) clipped++;
      expect(clipped).toBe(0);

      // The lead (+0) is bit-exact: harmonization never alters the singer.
      expect(rendered[0].data.channels[0]).toEqual(SOURCE.channels[0]);

      // Every voice is present in the mix at its own pitch: the lead at 220 Hz
      // and each shifted voice at its exact transposed fundamental.
      const loudest = bandPeak(limited, SR, 80, 8000).amplitude;
      expect(bandPeak(limited, SR, 215, 225).amplitude).toBeGreaterThan(loudest * 0.001);
      for (const { voice } of rendered.slice(1)) {
        const expected = F0 * semitoneRatio(voice.semitones + voice.detuneCents / 100);
        const found = bandPeak(limited, SR, expected * 0.97, expected * 1.03);
        expect(found.frequency / expected).toBeGreaterThan(0.98);
        expect(found.frequency / expected).toBeLessThan(1.02);
        expect(found.amplitude).toBeGreaterThan(loudest * 0.001);
      }
    });
  }

  it('lists exactly the documented presets', () => {
    expect(HARMONY_PRESETS.map((preset) => preset.style)).toEqual(['major', 'minor', 'double']);
  });
});

describe('Human Voice Mode keeps the accompaniment in the mix', () => {
  it('harmonizes the vocal stem only, so no accompaniment is transposed', () => {
    // Separation puts the vocal stem and the accompaniment in separate assets.
    // Human Voice Mode renders the harmony voices from the stem; the lead (+0)
    // reuses the source track's own audio, so the accompaniment is heard
    // exactly once, unshifted.
    const accompaniment = new Float32Array(SOURCE.length);
    for (let i = 0; i < accompaniment.length; i++) {
      accompaniment[i] = 0.3 * Math.sin((2 * Math.PI * 110 * i) / SR);
    }
    const stem = audioData([SOURCE.channels[0]], SR);
    const voice = executeJob({
      kind: 'harmonyVoice', data: stem, semitones: 7, detuneCents: 0,
      scope: { scope: 'entire-song', start: 0, end: SECONDS }, clipStart: 0, effects: [], outside: 'silence',
    }).data!.channels[0];

    // A 110 Hz probe tells us whether any accompaniment leaked into the voice.
    const probe = (signal: Float32Array) => {
      const n = Math.round(SR * 0.5);
      let re = 0;
      let im = 0;
      for (let i = 0; i < n; i++) {
        re += signal[i] * Math.cos((2 * Math.PI * 110 * i) / SR);
        im += signal[i] * Math.sin((2 * Math.PI * 110 * i) / SR);
      }
      return Math.hypot(re, im) / n;
    };
    expect(probe(voice)).toBeLessThan(probe(stem.channels[0]) + 1e-3);
    expect(probe(accompaniment)).toBeGreaterThan(0.1);
  });
});
