import { describe, it, expect } from 'vitest';
import {
  effectivePan,
  harmonyClipFactor,
  mixEntries,
  originalVoiceFactor,
  panGains,
} from './mixdown';
import { audioData } from './dsp';
import { defaultVocalState, type Clip, type HarmonyLayer, type Track } from '../types';

const SR = 22050;

function tone(seconds = 0.5, amplitude = 0.5): ReturnType<typeof audioData> {
  const length = Math.round(SR * seconds);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) data[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / SR);
  return audioData([data], SR);
}

function energy(channel: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
  return sum;
}

function track(overrides: Partial<Track> = {}): Track {
  return {
    id: 'track-1',
    name: 'Voice 1',
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    pitchSemis: 0,
    pitchFineCents: 0,
    clips: [],
    vocal: defaultVocalState(),
    ...overrides,
  };
}

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    name: 'clip',
    start: 0,
    sourceStart: 0,
    duration: 0.5,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    effects: [],
    ...overrides,
  };
}

function layer(overrides: Partial<HarmonyLayer> = {}): HarmonyLayer {
  return {
    id: 'layer-1',
    name: 'Harmony +4',
    sourceTrackId: 'track-1',
    targetTrackId: 'track-2',
    clipId: 'clip-1',
    semitones: 4,
    gain: 0.3,
    pan: 0,
    muted: false,
    solo: false,
    vocalsOnly: false,
    offsetSeconds: 0,
    effects: [],
    scope: 'entire-song',
    originalVoice: false,
    groupId: 'harmony:track-1',
    ...overrides,
  };
}

describe('stereo pan', () => {
  it('uses a constant-power law that is unity at the centre', () => {
    const [centreL, centreR] = panGains(0);
    expect(centreL).toBeCloseTo(1, 6);
    expect(centreR).toBeCloseTo(1, 6);
    const [leftL, leftR] = panGains(-1);
    expect(leftL).toBeCloseTo(Math.SQRT2, 6);
    expect(leftR).toBeCloseTo(0, 6);
    const [rightL, rightR] = panGains(1);
    expect(rightL).toBeCloseTo(0, 6);
    expect(rightR).toBeCloseTo(Math.SQRT2, 6);
    // Power is constant for every position.
    for (const pan of [-1, -0.5, 0, 0.5, 1]) {
      const [l, r] = panGains(pan);
      expect(l * l + r * r).toBeCloseTo(2, 6);
    }
  });

  it('writes pan into a stereo export instead of moving an indicator', () => {
    const source = tone();
    const left = mixEntries([{ data: source, start: 0, gain: 1, pan: -1 }], SR, 2);
    expect(energy(left.channels[0])).toBeGreaterThan(0.05);
    expect(energy(left.channels[1])).toBeLessThan(1e-9);

    const right = mixEntries([{ data: source, start: 0, gain: 1, pan: 1 }], SR, 2);
    expect(energy(right.channels[1])).toBeGreaterThan(0.05);
    expect(energy(right.channels[0])).toBeLessThan(1e-9);

    const centre = mixEntries([{ data: source, start: 0, gain: 1, pan: 0 }], SR, 2);
    expect(energy(centre.channels[0])).toBeCloseTo(energy(centre.channels[1]), 6);
    expect(energy(centre.channels[0])).toBeGreaterThan(0.05);
  });

  it('leaves a mono export centred and explains it through the API', () => {
    const source = tone();
    const left = mixEntries([{ data: source, start: 0, gain: 1, pan: -1 }], SR, 1);
    const centre = mixEntries([{ data: source, start: 0, gain: 1, pan: 0 }], SR, 1);
    expect(energy(left.channels[0])).toBeCloseTo(energy(centre.channels[0]), 6);
  });

  it('resolves pan from the layer, then the clip, then the track', () => {
    const t = track({ pan: 0.8 });
    const c = clip();
    expect(effectivePan(t, c, [])).toBeCloseTo(0.8, 6);
    expect(effectivePan(t, clip({ pan: -0.4 }), [])).toBeCloseTo(-0.4, 6);
    expect(effectivePan(t, c, [layer({ pan: 0.25 })])).toBeCloseTo(0.25, 6);
  });
});

describe('harmony gain in the mix', () => {
  it('applies the layer volume, mute and solo to real audio', () => {
    const source = tone();
    const entry = (pan: number) => ({ data: source, start: 0, gain: 0.3, pan });
    const loud = mixEntries([entry(0)], SR, 2);
    const quiet = mixEntries([{ ...entry(0), gain: 0.15 }], SR, 2);
    expect(energy(quiet.channels[0])).toBeCloseTo(energy(loud.channels[0]) / 4, 4);

    expect(harmonyClipFactor(track(), clip(), [layer({ gain: 0.3 })])).toBeCloseTo(0.3, 6);
    expect(harmonyClipFactor(track(), clip(), [layer({ muted: true })])).toBe(0);
    expect(harmonyClipFactor(track(), clip(), [layer({ solo: false }), layer({ id: 'other', clipId: 'clip-2', solo: true })])).toBe(0);
    expect(harmonyClipFactor(track(), clip(), [layer({ solo: true }), layer({ id: 'other', clipId: 'clip-2' })])).toBeCloseTo(0.3, 6);
  });

  it('applies the original-voice gain/mute/solo to the source track', () => {
    const original = layer({ originalVoice: true, clipId: undefined, gain: 0.7 });
    expect(originalVoiceFactor(track(), [original])).toBeCloseTo(0.7, 6);
    expect(originalVoiceFactor(track(), [{ ...original, muted: true }])).toBe(0);
    expect(originalVoiceFactor(track(), [{ ...original, solo: false }, layer({ id: 'x', clipId: 'c2', solo: true })])).toBe(0);
    expect(originalVoiceFactor(track(), [])).toBe(1);
  });

  it('places a delayed voice exactly as many samples late as requested', () => {
    const source = tone(0.2);
    const mix = mixEntries([{ data: source, start: 0.023, gain: 1, pan: 0 }], SR, 1);
    const first = mix.channels[0].findIndex((v) => Math.abs(v) > 1e-6);
    // The first non-zero sample is the first sample *after* the inserted
    // silence; the sine starts at zero, so allow that single sample offset.
    expect(first).toBeGreaterThanOrEqual(Math.round(0.023 * SR));
    expect(first).toBeLessThanOrEqual(Math.round(0.023 * SR) + 1);
  });
});
