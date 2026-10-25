import { describe, it, expect, afterAll } from 'vitest';
import {
  HARMONY_PRESET_A,
  HARMONY_PRESET_B,
  buildSourceTimeline,
  harmonyTargetNames,
  mixVoiceSignals,
  renderHarmonyVoice,
  sliceClipSegment,
  validateHarmonyRange,
  voicesFromIntervals,
} from './harmony';
import { peak, pitchShift, processVoiceOnly, softLimit } from './dsp';
import { separateVocalsLocal } from './separation';
import {
  ACCOMPANIMENT_FREQUENCY,
  FULL_SONG_SECONDS,
  VOCAL_FREQUENCY,
  bandPeak,
  bandPeakAmplitude,
  buildSong,
  cleanupAudioFiles,
  envelopeLag,
  readAudioFile,
  semitoneRatio,
  writeAudioFile,
} from '../test/songFixture';
import type { AudioData } from '../types';

const SAMPLE_RATE = 22050;

/** The measurement window used for spectral checks (seconds). */
const WINDOW = 4;

afterAll(() => {
  cleanupAudioFiles();
});

/**
 * The full 3:32 song is written to a real WAV file on disk and read back, so
 * every assertion below runs against an actual audio file.
 */
function loadFullSong(): AudioData {
  const song = buildSong(FULL_SONG_SECONDS, SAMPLE_RATE, VOCAL_FREQUENCY, 0);
  const path = writeAudioFile(song.mix, 'full-song-3m32.wav');
  return readAudioFile(path);
}

/** Amplitude of the lead voice's fundamental inside a window of the mix. */
function voiceLevel(data: AudioData, from: number, to: number, semitones = 0): number {
  const expected = VOCAL_FREQUENCY * semitoneRatio(semitones);
  const window = data.channels[0].subarray(from, to);
  return bandPeakAmplitude(window, data.sampleRate, expected * 0.9, expected * 1.1);
}

/** Frequency of the lead voice's fundamental inside a window of the mix. */
function voicePitch(data: AudioData, from: number, to: number, semitones = 0): number {
  const expected = VOCAL_FREQUENCY * semitoneRatio(semitones);
  const window = data.channels[0].subarray(from, to);
  return bandPeak(window, data.sampleRate, expected * 0.9, expected * 1.1).frequency;
}

describe('harmonization on a real 3:32 audio file', () => {
  it('reads a genuine 3:32 (212 s) stereo file from disk', () => {
    const song = loadFullSong();
    expect(song.length / song.sampleRate).toBeCloseTo(FULL_SONG_SECONDS, 3);
    expect(song.sampleRate).toBe(SAMPLE_RATE);
    expect(song.channels.length).toBe(2);
  }, 60_000);

  it('Entire Song processes all 212 seconds, including the very end', () => {
    const song = loadFullSong();
    const rendered = renderHarmonyVoice(song, 4, { scope: 'entire-song', start: 0, end: 0 }, 0);

    // The complete duration survives the shift.
    expect(rendered.length).toBe(song.length);
    expect(rendered.length / rendered.sampleRate).toBeCloseTo(FULL_SONG_SECONDS, 3);

    // The tail of the song is shifted too — proof the whole file was
    // processed, not only the part near the playhead.
    const tail = song.length - Math.round(10 * SAMPLE_RATE);
    const expected = VOCAL_FREQUENCY * semitoneRatio(4);
    const tailPitch = voicePitch(rendered, tail, rendered.length, 4);
    expect(tailPitch / expected).toBeCloseTo(1, 2);
    expect(voiceLevel(rendered, tail, rendered.length, 4)).toBeGreaterThan(0.05);
    // The voice is no longer at its original pitch at the end of the song.
    expect(voiceLevel(rendered, tail, rendered.length, 0)).toBeLessThan(0.01);
  }, 180_000);

  it('Selected Time Range modifies only the requested interval', () => {
    const song = loadFullSong();
    const start = 5;
    const end = 25;
    const rendered = renderHarmonyVoice(song, 4, { scope: 'range', start, end }, 0);

    // Duration and timing are untouched.
    expect(rendered.length).toBe(song.length);

    const before = Math.round(2 * SAMPLE_RATE);
    const after = Math.round(40 * SAMPLE_RATE);
    // As a harmony layer, the voice is silent outside the range so the source
    // audio is never played twice.
    for (let i = 0; i < before; i += 97) {
      expect(rendered.channels[0][i]).toBe(0);
    }
    for (let i = after; i < song.length; i += 97) {
      expect(rendered.channels[0][i]).toBe(0);
    }

    // Inside the range the pitch really moved: the voice now sits at +4
    // semitones, at the same level, and its original pitch is gone.
    const inside = Math.round(10 * SAMPLE_RATE);
    const window = Math.round(WINDOW * SAMPLE_RATE);
    const originalTone = voiceLevel(song, inside, inside + window, 0);
    const shiftedTone = voiceLevel(rendered, inside, inside + window, 4);
    const leftoverTone = voiceLevel(rendered, inside, inside + window, 0);
    expect(shiftedTone / originalTone).toBeGreaterThan(0.7);
    expect(shiftedTone / originalTone).toBeLessThan(1.3);
    expect(leftoverTone).toBeLessThan(originalTone * 0.1);
    expect(voicePitch(rendered, inside, inside + window, 4) / (VOCAL_FREQUENCY * semitoneRatio(4)))
      .toBeCloseTo(1, 2);

    // Outside the range the source still has its voice, and the harmony layer
    // is silent — so the untouched source plays exactly once.
    const outside = Math.round(30 * SAMPLE_RATE);
    expect(voiceLevel(song, outside, outside + window, 0)).toBeGreaterThan(0.01);
    expect(voiceLevel(rendered, outside, outside + window, 0)).toBe(0);
  }, 180_000);

  it('can preserve the original samples outside the range instead of silencing them', () => {
    const song = loadFullSong();
    const rendered = renderHarmonyVoice(song, 4, { scope: 'range', start: 5, end: 6 }, 0, { outside: 'preserve' });
    expect(rendered.length).toBe(song.length);
    // Outside the range the samples are bit-identical to the source.
    for (let i = 0; i < Math.round(2 * SAMPLE_RATE); i += 53) {
      expect(rendered.channels[0][i]).toBe(song.channels[0][i]);
    }
    for (let i = Math.round(30 * SAMPLE_RATE); i < song.length; i += 97) {
      expect(rendered.channels[0][i]).toBe(song.channels[0][i]);
    }
  }, 120_000);

  it('rejects a range beyond the real media duration', () => {
    const song = loadFullSong();
    const mediaDuration = song.length / song.sampleRate;
    expect(validateHarmonyRange(5, 25, mediaDuration)).toBeNull();
    expect(validateHarmonyRange(5, 25, 10)).toMatch(/beyond the media duration/i);
    expect(validateHarmonyRange(30, 25, mediaDuration)).toMatch(/later than start/i);
    expect(validateHarmonyRange(-1, 25, mediaDuration)).toMatch(/zero or greater/i);
  }, 60_000);
});

describe('harmony intervals', () => {
  it('+0 preserves the original pitch exactly (bit-exact)', () => {
    const song = buildSong(3, SAMPLE_RATE, VOCAL_FREQUENCY, 0);
    const rendered = renderHarmonyVoice(song.mix, 0, { scope: 'entire-song', start: 0, end: 0 }, 0);
    expect(rendered.length).toBe(song.mix.length);
    for (let i = 0; i < rendered.length; i++) {
      expect(rendered.channels[0][i]).toBe(song.mix.channels[0][i]);
      expect(rendered.channels[1][i]).toBe(song.mix.channels[1][i]);
    }
  });

  it.each([3, 4, 7])('+%i semitones produces the expected pitch interval', (semis) => {
    const song = buildSong(3, SAMPLE_RATE, VOCAL_FREQUENCY, 0);
    const rendered = renderHarmonyVoice(song.vocal, semis, { scope: 'entire-song', start: 0, end: 0 }, 0);
    const expected = VOCAL_FREQUENCY * semitoneRatio(semis);
    const peak = bandPeak(rendered.channels[0], SAMPLE_RATE, expected * 0.9, expected * 1.1);
    expect(peak.frequency / expected).toBeCloseTo(1, 2);
    expect(peak.amplitude).toBeGreaterThan(0.1);
    // The voice is no longer at its original pitch.
    const leftover = bandPeakAmplitude(rendered.channels[0], SAMPLE_RATE, VOCAL_FREQUENCY * 0.9, VOCAL_FREQUENCY * 1.1);
    expect(leftover).toBeLessThan(peak.amplitude * 0.1);
  });

  it.each([-3, -7])('%i semitones lowers the pitch by the right interval', (semis) => {
    const song = buildSong(3, SAMPLE_RATE, VOCAL_FREQUENCY, 0);
    const rendered = renderHarmonyVoice(song.vocal, semis, { scope: 'entire-song', start: 0, end: 0 }, 0);
    const expected = VOCAL_FREQUENCY * semitoneRatio(semis);
    const peak = bandPeak(rendered.channels[0], SAMPLE_RATE, expected * 0.9, expected * 1.1);
    expect(peak.frequency / expected).toBeCloseTo(1, 2);
    expect(peak.amplitude).toBeGreaterThan(0.1);
  });

  it('keeps tempo and duration identical to the source', () => {
    const song = buildSong(4, SAMPLE_RATE, VOCAL_FREQUENCY, 0);
    for (const semis of [3, 4, 7, -3]) {
      const rendered = renderHarmonyVoice(song.vocal, semis, { scope: 'entire-song', start: 0, end: 0 }, 0);
      expect(rendered.length).toBe(song.vocal.length);
      expect(rendered.sampleRate).toBe(song.vocal.sampleRate);
      // The syllable envelope keeps its timing: cross-correlating the two
      // amplitude envelopes lines up at (almost) zero lag. A speed change
      // would smear the envelopes across the whole 4 second clip instead.
      const lag = envelopeLag(song.vocal.channels[0], rendered.channels[0], SAMPLE_RATE);
      expect(Math.abs(lag)).toBeLessThan(0.05);
    }
  });

  it('preserves the level of the shifted signal (no sudden volume drop)', () => {
    const song = buildSong(3, SAMPLE_RATE, VOCAL_FREQUENCY, 0);
    const original = bandPeakAmplitude(song.vocal.channels[0], SAMPLE_RATE, 300, 360);
    for (const semis of [3, 4, 7]) {
      const expected = VOCAL_FREQUENCY * semitoneRatio(semis);
      const rendered = renderHarmonyVoice(song.vocal, semis, { scope: 'entire-song', start: 0, end: 0 }, 0);
      const shifted = bandPeakAmplitude(rendered.channels[0], SAMPLE_RATE, expected * 0.9, expected * 1.1);
      expect(shifted / original).toBeGreaterThan(0.7);
      expect(shifted / original).toBeLessThan(1.3);
    }
  });
});

describe('synchronization and headroom', () => {
  it('keeps a rendered voice in sync with the source (no drift)', () => {
    const song = buildSong(4, SAMPLE_RATE, VOCAL_FREQUENCY, 0);
    for (const semis of [3, 4, 7, -3]) {
      const voice = renderHarmonyVoice(song.mix, semis, { scope: 'entire-song', start: 0, end: 0 }, 0);
      const lag = envelopeLag(song.mix.channels[0], voice.channels[0], SAMPLE_RATE);
      expect(Math.abs(lag)).toBeLessThan(0.05);
    }
  });

  it('a preset mix stays inside full scale after the app soft limiter', () => {
    const song = buildSong(3, SAMPLE_RATE, VOCAL_FREQUENCY, 0);
    const voices = voicesFromIntervals(HARMONY_PRESET_A.intervals);
    // Default harmony level in the panel is 0.8 for the shifted voices.
    const mixed = mixVoiceSignals(
      voices.map((voice) => ({
        data: renderHarmonyVoice(song.mix, voice.semitones, { scope: 'entire-song', start: 0, end: 0 }, 0),
        gain: voice.semitones === 0 ? 1 : 0.8,
      })),
      SAMPLE_RATE,
    );
    const rawPeak = peak(mixed);
    expect(rawPeak).toBeGreaterThan(0);
    const limited = softLimit(mixed);
    expect(peak(limited)).toBeLessThanOrEqual(1);
    // The limiter must not silence the mix or distort it into silence.
    expect(peak(limited)).toBeGreaterThan(rawPeak * 0.5);
  });
});

describe('harmony presets', () => {
  it('Preset A is 0, +4, +7 and Preset B is 0, +3, +7', () => {
    expect(HARMONY_PRESET_A.intervals).toEqual([0, 4, 7]);
    expect(HARMONY_PRESET_B.intervals).toEqual([0, 3, 7]);
    expect(voicesFromIntervals(HARMONY_PRESET_A.intervals).map((v) => v.semitones)).toEqual([0, 4, 7]);
    expect(voicesFromIntervals(HARMONY_PRESET_B.intervals).map((v) => v.semitones)).toEqual([0, 3, 7]);
  });

  it('assigns the +0 voice to the source track and the rest to Voice 2 / Voice 3', () => {
    const voices = voicesFromIntervals(HARMONY_PRESET_A.intervals);
    const names = harmonyTargetNames(voices, 'Voice 1');
    expect(names[0]).toBe('');
    expect(names[1]).toBe('Voice 2');
    expect(names[2]).toBe('Voice 3');
  });

  it('never points a harmony voice at the source track itself', () => {
    const voices = voicesFromIntervals(HARMONY_PRESET_A.intervals);
    voices[1].targetTrackName = 'Voice 1';
    const names = harmonyTargetNames(voices, 'Voice 1');
    expect(names[1]).not.toBe('Voice 1');
    expect(names[1]).toBe('Voice 2');
  });

  it('renders every enabled voice of a preset independently', () => {
    const song = buildSong(2, SAMPLE_RATE, VOCAL_FREQUENCY, 0);
    const presetA = voicesFromIntervals(HARMONY_PRESET_A.intervals);
    const rendered = presetA.map((voice) => ({
      semitones: voice.semitones,
      data: renderHarmonyVoice(song.vocal, voice.semitones, { scope: 'entire-song', start: 0, end: 0 }, 0),
    }));
    expect(rendered.map((r) => r.semitones)).toEqual([0, 4, 7]);
    for (const voice of rendered) {
      expect(voice.data.length).toBe(song.vocal.length);
    }
    const fourth = bandPeak(rendered[1].data.channels[0], SAMPLE_RATE, 380, 450);
    const seventh = bandPeak(rendered[2].data.channels[0], SAMPLE_RATE, 460, 540);
    expect(fourth.frequency / (VOCAL_FREQUENCY * semitoneRatio(4))).toBeCloseTo(1, 2);
    expect(seventh.frequency / (VOCAL_FREQUENCY * semitoneRatio(7))).toBeCloseTo(1, 2);
    // The +0 voice is bit-identical to the source.
    for (let i = 0; i < rendered[0].data.length; i += 31) {
      expect(rendered[0].data.channels[0][i]).toBe(song.vocal.channels[0][i]);
    }
  });
});

describe('source timeline', () => {
  it('lays clips out on the song timeline preserving their start times', () => {
    const first = buildSong(2, SAMPLE_RATE).mix;
    const second = buildSong(2, SAMPLE_RATE).mix;
    const timeline = buildSourceTimeline(
      [{ start: 0, data: first }, { start: 2, data: second }],
      4,
      SAMPLE_RATE,
    );
    expect(timeline.length / timeline.sampleRate).toBeCloseTo(4, 3);
    // The second clip starts two seconds in.
    const start = Math.round(2.1 * SAMPLE_RATE);
    expect(Math.abs(timeline.channels[0][start])).toBeGreaterThan(0.01);
    expect(Math.abs(timeline.channels[0][Math.round(1.9 * SAMPLE_RATE)])).toBeLessThan(0.01);
  });

  it('slices the playable part of a clip', () => {
    const song = buildSong(5, SAMPLE_RATE).mix;
    const segment = sliceClipSegment(song, 1, 2);
    expect(segment.length / segment.sampleRate).toBeCloseTo(2, 3);
  });
});

describe('human voice processing with real separation', () => {
  it('changes the vocal pitch while the accompaniment stays substantially unchanged', () => {
    const song = buildSong(6, SAMPLE_RATE);
    const separation = separateVocalsLocal(song.mix);

    // The separator produced two stems that add back up to the mix.
    expect(separation.vocal.length).toBe(song.mix.length);
    expect(separation.instrumental.length).toBe(song.mix.length);
    for (let i = 0; i < song.mix.length; i += 313) {
      expect(separation.vocal.channels[0][i] + separation.instrumental.channels[0][i])
        .toBeCloseTo(song.mix.channels[0][i], 4);
    }

    const start = Math.round(1 * SAMPLE_RATE);
    const window = Math.round(WINDOW * SAMPLE_RATE);
    const slice = (data: AudioData) => data.channels[0].subarray(start, start + window);

    // The vocal stem really holds the voice, the accompaniment stem the bass.
    const vocalStem = bandPeakAmplitude(slice(separation.vocal), SAMPLE_RATE, 300, 360);
    const bassInVocalStem = bandPeakAmplitude(slice(separation.vocal), SAMPLE_RATE, 100, 120);
    const bassInInstrumental = bandPeakAmplitude(slice(separation.instrumental), SAMPLE_RATE, 100, 120);
    expect(vocalStem).toBeGreaterThan(bassInVocalStem * 2);
    expect(bassInInstrumental).toBeGreaterThan(bassInVocalStem * 2);

    const processed = processVoiceOnly(song.mix, separation.vocal, separation.instrumental, {
      enabled: true,
      semitones: 4,
      preserveTempo: true,
      vocalVolume: 1,
      mixWithAccompaniment: true,
    });

    // Tempo and duration are preserved.
    expect(processed.length).toBe(song.mix.length);

    // The accompaniment comes through the untouched stem.
    const bassBefore = bandPeakAmplitude(slice(song.mix), SAMPLE_RATE, 100, 120);
    const bassAfter = bandPeakAmplitude(slice(processed), SAMPLE_RATE, 100, 120);
    expect(bassAfter / bassBefore).toBeGreaterThan(0.9);
    expect(bassAfter / bassBefore).toBeLessThan(1.1);

    // The vocal moved up by four semitones.
    const shiftedVocal = bandPeakAmplitude(slice(processed), SAMPLE_RATE, 390, 440);
    const originalShiftedSlot = bandPeakAmplitude(slice(song.mix), SAMPLE_RATE, 390, 440);
    expect(shiftedVocal).toBeGreaterThan(originalShiftedSlot * 10);
    expect(shiftedVocal).toBeGreaterThan(vocalStem * 0.5);
  }, 120_000);

  it('mixes an exact vocal stem and leaves the accompaniment untouched', () => {
    const song = buildSong(3, SAMPLE_RATE);
    const processed = processVoiceOnly(song.mix, song.vocal, song.accompaniment, {
      enabled: true,
      semitones: 4,
      preserveTempo: true,
      vocalVolume: 1,
      mixWithAccompaniment: true,
    });
    // The accompaniment is mixed in untouched; only the vocal moved.
    const shiftedVocal = pitchShift(song.vocal, 4);
    for (let i = 0; i < song.accompaniment.length; i += 17) {
      expect(processed.channels[0][i])
        .toBeCloseTo(song.accompaniment.channels[0][i] + shiftedVocal.channels[0][i], 5);
    }
  });

  it('leaves the whole track alone when human voice processing is off', () => {
    const song = buildSong(2, SAMPLE_RATE);
    const processed = processVoiceOnly(song.mix, null, null, {
      enabled: false,
      semitones: 4,
      preserveTempo: true,
      vocalVolume: 1,
      mixWithAccompaniment: true,
    });
    for (let i = 0; i < processed.length; i++) {
      expect(processed.channels[0][i]).toBe(song.mix.channels[0][i]);
    }
  });

  it('applies a pitch shift to the separated vocal without changing the tempo', () => {
    const song = buildSong(4, SAMPLE_RATE, VOCAL_FREQUENCY, 0);
    const separation = separateVocalsLocal(song.mix);
    const shiftedVocal = pitchShift(separation.vocal, 7);
    expect(shiftedVocal.length).toBe(separation.vocal.length);
    const expected = VOCAL_FREQUENCY * semitoneRatio(7);
    const peak = bandPeak(shiftedVocal.channels[0], SAMPLE_RATE, expected * 0.85, expected * 1.15);
    expect(peak.frequency / expected).toBeCloseTo(1, 1);
    expect(peak.amplitude).toBeGreaterThan(0.01);
  }, 120_000);
});
