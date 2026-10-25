import type { AudioData, HarmonyScope, RangeEffect, Track } from '../types';
import { clamp } from '../types';
import { applyRangeEffect, audioData, cloneAudio, fitLength, pitchShift, sliceAudio, type ProgressFn } from './dsp';

/**
 * Harmonization DSP.
 *
 * Everything here operates on *real samples*: a harmony voice is a genuinely
 * pitch-shifted signal (phase vocoder, tempo and duration preserved), not a
 * display value. The +0 voice is the original-pitch voice and is never
 * rendered twice — it reuses the source track's own audio.
 */

export interface HarmonyIntervalPreset {
  id: string;
  label: string;
  semitones: number;
}

/** Named intervals offered by the harmonization panel. */
export const HARMONY_INTERVAL_PRESETS: HarmonyIntervalPreset[] = [
  { id: 'original', label: 'Original', semitones: 0 },
  { id: 'minor-third', label: 'Minor third', semitones: 3 },
  { id: 'major-third', label: 'Major third', semitones: 4 },
  { id: 'perfect-fifth', label: 'Perfect fifth', semitones: 7 },
];

export interface HarmonyPreset {
  id: string;
  label: string;
  intervals: number[];
}

/** Harmony Preset A — original + major third + perfect fifth. */
export const HARMONY_PRESET_A: HarmonyPreset = {
  id: 'preset-a',
  label: 'Harmony Preset A (0, +4, +7)',
  intervals: [0, 4, 7],
};

/** Harmony Preset B — original + minor third + perfect fifth. */
export const HARMONY_PRESET_B: HarmonyPreset = {
  id: 'preset-b',
  label: 'Harmony Preset B (0, +3, +7)',
  intervals: [0, 3, 7],
};

export const HARMONY_PRESETS: HarmonyPreset[] = [HARMONY_PRESET_A, HARMONY_PRESET_B];

/** Human-readable name for an interval (named presets first, then raw semitones). */
export function describeInterval(semitones: number): string {
  const preset = HARMONY_INTERVAL_PRESETS.find((p) => p.semitones === semitones);
  if (preset) return `${preset.label} (${semitones >= 0 ? '+' : ''}${semitones})`;
  return `${semitones >= 0 ? '+' : ''}${semitones} semitones`;
}

export interface HarmonyScopeSpec {
  scope: HarmonyScope;
  /** Song-timeline start in seconds (used when scope is 'range'). */
  start: number;
  /** Song-timeline end in seconds (used when scope is 'range'). */
  end: number;
}

/**
 * Validate a requested range against the *actual* media duration.
 * Returns a human-readable problem, or null when the range is usable.
 */
export function validateHarmonyRange(
  start: number,
  end: number,
  mediaDuration: number,
): string | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Start and end times must be numbers.';
  if (start < 0) return 'Start time must be zero or greater.';
  if (end <= start) return 'End time must be later than start time.';
  if (mediaDuration <= 0) return 'The selected media has no measurable duration.';
  if (end > mediaDuration + 1e-6) {
    return `End time is beyond the media duration (${mediaDuration.toFixed(3)}s).`;
  }
  return null;
}

/** Intersection of a song-time range with a clip's song-time extent. */
export function intersectRange(
  scope: HarmonyScopeSpec,
  clipStart: number,
  clipDuration: number,
): { start: number; end: number } | null {
  if (scope.scope === 'entire-song') return { start: clipStart, end: clipStart + clipDuration };
  const start = Math.max(clipStart, scope.start);
  const end = Math.min(clipStart + clipDuration, scope.end);
  if (end <= start + 1e-6) return null;
  return { start, end };
}

export interface HarmonySourceSegment {
  /** Song-timeline start of this segment, in seconds. */
  start: number;
  /** The segment's audio. */
  data: AudioData;
}

/**
 * Lay the source track's clips out on one song-timeline buffer so a harmony
 * voice covers the whole song with the original timing preserved.
 */
export function buildSourceTimeline(
  segments: HarmonySourceSegment[],
  totalSeconds: number,
  sampleRate: number,
): AudioData {
  const length = Math.max(1, Math.ceil(totalSeconds * sampleRate));
  const channelCount = Math.max(1, ...segments.map((s) => s.data.channels.length));
  const out = Array.from({ length: channelCount }, () => new Float32Array(length));
  for (const segment of segments) {
    const offset = Math.max(0, Math.round(segment.start * sampleRate));
    for (let c = 0; c < channelCount; c++) {
      const source = segment.data.channels[Math.min(c, segment.data.channels.length - 1)];
      for (let i = 0; i < source.length; i++) {
        const position = offset + i;
        if (position >= length) break;
        out[c][position] += source[i];
      }
    }
  }
  return audioData(out, sampleRate);
}

export interface HarmonyVoiceOptions {
  /**
   * What a range-scoped voice contains outside the requested range.
   *
   * - 'silence' (default): the voice only sounds inside the range. A harmony
   *   voice lives on its own track next to the untouched source, so keeping
   *   the original samples outside the range would play the source twice.
   * - 'preserve': the original samples are kept outside the range, which is
   *   what an in-place pitch shift over a selection needs.
   */
  outside?: 'silence' | 'preserve';
  onProgress?: ProgressFn;
}

/**
 * Render one harmony voice.
 *
 * - `semitones === 0` returns the original samples untouched (bit-exact).
 * - scope 'entire-song' pitch-shifts the complete buffer.
 * - scope 'range' pitch-shifts only the requested interval. The range edges
 *   are crossfaded so there is no click, and everything outside the range is
 *   silent unless 'preserve' is requested.
 */
export function renderHarmonyVoice(
  source: AudioData,
  semitones: number,
  scope: HarmonyScopeSpec,
  clipStart: number,
  options: HarmonyVoiceOptions = {},
): AudioData {
  const duration = source.length / source.sampleRate;
  if (semitones === 0) return cloneAudio(source);
  if (scope.scope === 'entire-song') {
    return pitchShift(source, semitones, options.onProgress);
  }
  const sampleRate = source.sampleRate;
  const localStart = Math.max(0, scope.start - clipStart);
  const localEnd = Math.min(duration, scope.end - clipStart);
  if (localEnd <= localStart + 1e-6) return cloneAudio(source);
  const effect: RangeEffect = {
    id: 'harmony-range',
    type: 'pitch',
    start: localStart,
    end: localEnd,
    params: { semitones },
    enabled: true,
  };
  const processed = applyRangeEffect(source, effect).data;
  if ((options.outside ?? 'silence') === 'preserve') return processed;
  const from = Math.max(0, Math.round(localStart * sampleRate));
  const to = Math.min(processed.length, Math.round(localEnd * sampleRate));
  return audioData(
    processed.channels.map((channel) => {
      const out = new Float32Array(channel.length);
      out.set(channel.subarray(from, to), from);
      return out;
    }),
    sampleRate,
  );
}

/** Apply a layer's own effects to an already-rendered harmony signal. */
export function applyLayerEffects(source: AudioData, effects: RangeEffect[]): AudioData {
  let out = source;
  for (const effect of effects) {
    if (!effect.enabled) continue;
    out = applyRangeEffect(out, effect).data;
  }
  return out;
}

/** Extract the playable part of a source clip (sourceStart .. sourceStart+duration). */
export function sliceClipSegment(
  asset: AudioData,
  sourceStart: number,
  duration: number,
): AudioData {
  const end = Math.min(asset.length / asset.sampleRate, sourceStart + duration);
  if (end <= sourceStart) return audioData(asset.channels.map(() => new Float32Array(0)), asset.sampleRate);
  return fitLength(sliceAudio(asset, sourceStart, end), Math.max(0, Math.round((end - sourceStart) * asset.sampleRate)));
}

export interface HarmonyVoiceDraft {
  id: string;
  semitones: number;
  enabled: boolean;
  gain: number;
  offsetSeconds: number;
  /** Name of the track the voice is assigned to. Empty means "auto-assign". */
  targetTrackName: string;
  /** Effects baked into this voice when it is rendered. */
  effects: RangeEffect[];
}

let voiceCounter = 0;
const nextVoiceId = (): string => `voice-${Date.now().toString(36)}-${(voiceCounter++).toString(36)}`;

/** Build the voice list for a set of intervals (used by the A/B presets). */
export function voicesFromIntervals(intervals: number[]): HarmonyVoiceDraft[] {
  return intervals.map((semitones) => ({
    id: nextVoiceId(),
    semitones,
    enabled: true,
    gain: semitones === 0 ? 1 : 0.8,
    offsetSeconds: 0,
    targetTrackName: '',
    effects: [],
  }));
}

/** The standard harmony slots offered to the user (Voice 2, Voice 3, Voice 4 …). */
export const HARMONY_TRACK_SLOTS = ['Voice 2', 'Voice 3', 'Voice 4', 'Voice 5', 'Voice 6'];

/**
 * Resolve the track name for every voice.
 *
 * The +0 voice stays on the source track (original pitch, no duplicate audio).
 * The other voices go to Voice 2 / Voice 3 / Voice 4 … or to the track the user
 * picked. A name that is already taken (for example the source track itself)
 * falls back to the next free slot.
 */
export function harmonyTargetNames(
  voices: HarmonyVoiceDraft[],
  sourceTrackName: string,
  separateOriginalTrack = false,
): string[] {
  const used = new Set<string>([sourceTrackName.trim().toLowerCase()]);
  const names: string[] = [];
  let autoIndex = 2;
  for (const voice of voices) {
    if (!voice.enabled) {
      names.push('');
      continue;
    }
    if (voice.semitones === 0) {
      const name = separateOriginalTrack ? 'Original Voice' : '';
      if (name) used.add(name.toLowerCase());
      names.push(name);
      continue;
    }
    let name = voice.targetTrackName.trim();
    if (!name) {
      while (used.has(`voice ${autoIndex}`)) autoIndex++;
      name = `Voice ${autoIndex}`;
      autoIndex++;
    } else if (used.has(name.trim().toLowerCase())) {
      while (used.has(`voice ${autoIndex}`)) autoIndex++;
      name = `Voice ${autoIndex}`;
      autoIndex++;
    }
    used.add(name.trim().toLowerCase());
    names.push(name);
  }
  return names;
}

/** Mix rendered voice signals into one preview buffer. */
export function mixVoiceSignals(
  voices: Array<{ data: AudioData; gain: number }>,
  sampleRate: number,
): AudioData {
  const channelCount = Math.max(1, ...voices.map((v) => v.data.channels.length));
  const length = Math.max(0, ...voices.map((v) => v.data.length));
  const out = Array.from({ length: channelCount }, () => new Float32Array(length));
  for (const voice of voices) {
    for (let c = 0; c < channelCount; c++) {
      const source = voice.data.channels[Math.min(c, voice.data.channels.length - 1)];
      const target = out[c];
      for (let i = 0; i < source.length && i < target.length; i++) target[i] += source[i] * voice.gain;
    }
  }
  return audioData(out, sampleRate);
}

/** Human-readable summary of what a harmonization run will touch. */
export function describeScope(
  scope: HarmonyScopeSpec,
  mediaDuration: number,
): string {
  if (scope.scope === 'entire-song') {
    return `Entire Song — the complete ${formatDuration(mediaDuration)} duration is processed from the first sample to the last.`;
  }
  const length = Math.max(0, scope.end - scope.start);
  return `Selected Time Range — ${formatDuration(scope.start)} to ${formatDuration(scope.end)} (${length.toFixed(3)}s of ${formatDuration(mediaDuration)}). Audio outside the range is preserved.`;
}

function formatDuration(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${rest.toFixed(3).padStart(6, '0')}`;
}

/** Clamp a semitone value into the supported range. */
export const clampSemitones = (value: number): number => clamp(Math.round(value), -24, 24);

/** Tracks that can receive a harmony voice (everything except the source track). */
export function harmonyTargetTracks(tracks: Track[], sourceTrackId: string): Track[] {
  return tracks.filter((t) => t.id !== sourceTrackId);
}
