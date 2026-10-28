import { describe, it, expect } from 'vitest';
import { prepareClipData, mixEntries, originalVoiceFactor, harmonyClipFactor, hasHarmonySolo } from './mixdown';
import { separateVocalsLocal } from './separation';
import { decodeWav, encodeWavBytes } from './wav';
import { audioData } from './dsp';
import { renderHarmonyVoice } from './harmony';
import {
  ACCOMPANIMENT_FREQUENCY,
  VOCAL_FREQUENCY,
  bandPeakAmplitude,
  bandPeakFrequency,
  buildSong,
  semitoneRatio,
} from '../test/songFixture';
import { defaultVocalState, type Clip, type HarmonyLayer, type Track } from '../types';

const SAMPLE_RATE = 22050;

function makeTrack(overrides: Partial<Track> = {}): Track {
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

function makeClip(assetId: string, duration: number): Clip {
  return {
    id: 'clip-1',
    assetId,
    name: 'song.wav',
    start: 0,
    sourceStart: 0,
    duration,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    effects: [],
  };
}

function harmonyLayer(overrides: Partial<HarmonyLayer> = {}): HarmonyLayer {
  return {
    id: 'layer-1',
    name: 'Harmony +4',
    sourceTrackId: 'track-1',
    targetTrackId: 'track-2',
    clipId: 'harmony-clip',
    semitones: 4,
    gain: 0.8,
    muted: false,
    solo: false,
    vocalsOnly: false,
    offsetSeconds: 0,
    effects: [],
    scope: 'entire-song',
    originalVoice: false,
    ...overrides,
  };
}

describe('human voice processing in the playback/export chain', () => {
  it('applies the pitch to the isolated vocal only when Human Voice Processing is ON', async () => {
    const song = buildSong(4, SAMPLE_RATE);
    const separation = separateVocalsLocal(song.mix);
    const assets = new Map<string, typeof song.mix>([
      ['mix', song.mix],
      ['vocal', separation.vocal],
      ['instrumental', separation.instrumental],
    ]);
    const load = async (id: string) => {
      const found = assets.get(id);
      if (!found) throw new Error(`missing ${id}`);
      return found;
    };
    const clip = makeClip('mix', song.mix.length / song.mix.sampleRate);

    // Voice processing ON: only the vocal moves.
    const onTrack = makeTrack({
      clips: [clip],
      vocal: {
        ...defaultVocalState(),
        enabled: true,
        status: 'ready',
        method: 'local-approximate',
        vocalAssetId: 'vocal',
        instrumentalAssetId: 'instrumental',
        pitchSemis: 4,
        preserveTempo: true,
      },
    });
    const on = await prepareClipData(onTrack, clip, { load });
    expect(on.length).toBe(song.mix.length);
    const window = Math.round(2 * SAMPLE_RATE);
    const slice = (data: Float32Array) => data.subarray(Math.round(SAMPLE_RATE), Math.round(SAMPLE_RATE) + window);
    const bassBefore = bandPeakFrequency(slice(song.mix.channels[0]), SAMPLE_RATE, 90, 130);
    const bassAfter = bandPeakFrequency(slice(on.channels[0]), SAMPLE_RATE, 90, 130);
    expect(bassAfter).toBeCloseTo(bassBefore, 0);
    const shifted = bandPeakFrequency(slice(on.channels[0]), SAMPLE_RATE, 380, 450);
    expect(shifted / (VOCAL_FREQUENCY * semitoneRatio(4))).toBeCloseTo(1, 1);

    // Voice processing OFF: ordinary whole-track processing — everything moves.
    const offTrack = makeTrack({ clips: [clip], vocal: defaultVocalState(), pitchSemis: 4 });
    const off = await prepareClipData(offTrack, clip, { load });
    const bassOff = bandPeakFrequency(slice(off.channels[0]), SAMPLE_RATE, 120, 160);
    expect(bassOff / (ACCOMPANIMENT_FREQUENCY * semitoneRatio(4))).toBeCloseTo(1, 1);
  }, 120_000);

  it('falls back to whole-track processing when stems are missing', async () => {
    const song = buildSong(2, SAMPLE_RATE);
    const clip = makeClip('mix', song.mix.length / song.mix.sampleRate);
    const load = async () => song.mix;
    const track = makeTrack({
      clips: [clip],
      pitchSemis: 3,
      vocal: { ...defaultVocalState(), enabled: true, status: 'not-run', pitchSemis: 7 },
    });
    const out = await prepareClipData(track, clip, { load });
    const expected = ACCOMPANIMENT_FREQUENCY * semitoneRatio(3);
    const measured = bandPeakFrequency(out.channels[0], SAMPLE_RATE, expected * 0.9, expected * 1.1);
    expect(measured / expected).toBeCloseTo(1, 1);
  });

  it('keeps the original file untouched (rendering never mutates the source)', async () => {
    const song = buildSong(2, SAMPLE_RATE);
    const before = new Float32Array(song.mix.channels[0]);
    const clip = makeClip('mix', song.mix.length / song.mix.sampleRate);
    const load = async () => song.mix;
    const track = makeTrack({ clips: [clip], pitchSemis: 7 });
    await prepareClipData(track, clip, { load });
    for (let i = 0; i < before.length; i += 53) {
      expect(song.mix.channels[0][i]).toBe(before[i]);
    }
  });
});

describe('harmony voice gain rules', () => {
  it('mutes a layer, and silences non-soloed voices when any voice is soloed', () => {
    const track = makeTrack();
    const clip = { ...makeClip('a', 10), id: 'harmony-clip' };
    const layer = harmonyLayer();
    expect(harmonyClipFactor(track, clip, [layer])).toBe(0.8);
    expect(harmonyClipFactor(track, clip, [{ ...layer, muted: true }])).toBe(0);
    expect(hasHarmonySolo([{ ...layer, solo: true }])).toBe(true);
    expect(harmonyClipFactor(track, clip, [{ ...layer, solo: true }])).toBe(0.8);
    expect(harmonyClipFactor(track, clip, [layer, { ...layer, id: 'l2', clipId: 'other', solo: true }])).toBe(0);
  });

  it('applies the +0 voice gain to the source track and respects mute/solo', () => {
    const track = makeTrack({ id: 'source' });
    const original = harmonyLayer({
      originalVoice: true,
      sourceTrackId: 'source',
      targetTrackId: 'source',
      clipId: undefined,
      gain: 0.7,
    });
    expect(originalVoiceFactor(track, [original])).toBe(0.7);
    expect(originalVoiceFactor(track, [{ ...original, muted: true }])).toBe(0);
    expect(originalVoiceFactor(track, [{ ...original, solo: false }, harmonyLayer({ id: 'x', solo: true })])).toBe(0);
    // Unrelated tracks are untouched.
    expect(originalVoiceFactor(makeTrack({ id: 'other' }), [original])).toBe(1);
  });
});

describe('exported audio', () => {
  it('a +7 harmony voice exported to WAV really is seven semitones higher', () => {
    const song = buildSong(3, SAMPLE_RATE, VOCAL_FREQUENCY, 0);
    // 1) Render the voice through the harmonization pipeline (real DSP).
    const shifted = renderHarmonyVoice(song.vocal, 7, { scope: 'entire-song', start: 0, end: 0 }, 0);
    // 2) Mix it the way the export dialog does.
    const mixed = mixEntries([{ data: shifted, start: 0, gain: 1 }], SAMPLE_RATE, 1);
    // 3) Encode real WAV bytes and decode them back.
    const bytes = encodeWavBytes(mixed, { bitDepth: 24, channels: 1, sampleRate: SAMPLE_RATE });
    const decoded = decodeWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(decoded.length / decoded.sampleRate).toBeCloseTo(3, 2);
    const expected = VOCAL_FREQUENCY * semitoneRatio(7);
    const measured = bandPeakFrequency(decoded.channels[0], SAMPLE_RATE, expected * 0.9, expected * 1.1);
    expect(measured / expected).toBeCloseTo(1, 1);
    // The original pitch is no longer present at a meaningful level.
    const shiftedLevel = bandPeakAmplitude(decoded.channels[0], SAMPLE_RATE, expected * 0.9, expected * 1.1);
    const originalLevel = bandPeakAmplitude(decoded.channels[0], SAMPLE_RATE, 300, 360);
    expect(shiftedLevel).toBeGreaterThan(originalLevel * 5);
  });

  it('a mix of the song and its harmony exports both pitches', () => {
    const song = buildSong(3, SAMPLE_RATE, VOCAL_FREQUENCY, 0);
    const shifted = renderHarmonyVoice(song.vocal, 4, { scope: 'entire-song', start: 0, end: 0 }, 0);
    const mixed = mixEntries(
      [
        { data: song.mix, start: 0, gain: 1 },
        { data: shifted, start: 0, gain: 0.5 },
      ],
      SAMPLE_RATE,
      2,
    );
    const bytes = encodeWavBytes(mixed, { bitDepth: 16, channels: 2, sampleRate: SAMPLE_RATE });
    const decoded = decodeWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(decoded.channels.length).toBe(2);
    const original = bandPeakFrequency(decoded.channels[0], SAMPLE_RATE, 300, 360);
    expect(original / VOCAL_FREQUENCY).toBeCloseTo(1, 1);
    // Both voices are present in the exported mix.
    const fourth = bandPeakFrequency(decoded.channels[0], SAMPLE_RATE, 380, 450);
    expect(fourth / (VOCAL_FREQUENCY * semitoneRatio(4))).toBeCloseTo(1, 1);
  });
});
