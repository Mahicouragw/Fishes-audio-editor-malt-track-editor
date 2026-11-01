import type { AudioData, HarmonyKey, HarmonyRange, HarmonyScale, HarmonyScope, RangeEffect, Track } from '../types';
import { clamp } from '../types';
import { applyRangeEffect, audioData, cloneAudio, fitLength, pitchShift, sliceAudio, type ProgressFn } from './dsp';

/**
 * Harmonization DSP and presets.
 *
 * Everything here operates on *real samples*: a harmony voice is a genuinely
 * pitch-shifted signal (formant-preserving spectral remapping, tempo and
 * duration preserved), not a display value. The +0 lead voice is the original
 * pitch voice and is never rendered twice unless the user explicitly asks for
 * a separate duplicate track.
 */

export interface HarmonyIntervalPreset {
  id: string;
  label: string;
  semitones: number;
}

/** Named intervals offered by the harmonization panel. */
export const HARMONY_INTERVAL_PRESETS: HarmonyIntervalPreset[] = [
  { id: 'original', label: 'Original', semitones: 0 },
  { id: 'minor-second', label: 'Minor second', semitones: 1 },
  { id: 'major-second', label: 'Major second', semitones: 2 },
  { id: 'minor-third', label: 'Minor third', semitones: 3 },
  { id: 'major-third', label: 'Major third', semitones: 4 },
  { id: 'perfect-fourth', label: 'Perfect fourth', semitones: 5 },
  { id: 'tritone', label: 'Tritone', semitones: 6 },
  { id: 'perfect-fifth', label: 'Perfect fifth', semitones: 7 },
  { id: 'minor-sixth', label: 'Minor sixth', semitones: 8 },
  { id: 'major-sixth', label: 'Major sixth', semitones: 9 },
  { id: 'minor-seventh', label: 'Minor seventh', semitones: 10 },
  { id: 'major-seventh', label: 'Major seventh', semitones: 11 },
  { id: 'octave', label: 'Octave', semitones: 12 },
];

/** One voice of a preset, with the real starting values from the spec. */
export interface HarmonyVoiceDefault {
  /** Track name, e.g. "Voice 2 — Harmony +4". */
  name: string;
  semitones: number;
  /** Delay from the lead, in milliseconds. */
  delayMs: number;
  /** Starting volume, 0…2 (1 = 100%). */
  gain: number;
  /** Stereo position, -1…+1. */
  pan: number;
  /** Micro-detune in cents, used for doubled +0 layers. */
  detuneCents: number;
}

export interface HarmonyPreset {
  id: string;
  label: string;
  description: string;
  style: 'major' | 'minor' | 'double';
  voices: HarmonyVoiceDefault[];
  /** Interval list, kept for code and tests that only need the semitones. */
  intervals: number[];
}

/**
 * Preset A — major-style harmony.
 *
 * Voice 4 is a +0 *double*, six cents flat: a pure delayed copy of the lead
 * would comb-filter with it, so the double is deliberately de-correlated.
 */
export const HARMONY_PRESET_A: HarmonyPreset = {
  id: 'preset-a',
  label: 'Preset A — Major-style harmony',
  description: 'Original lead + major third (+4) + perfect fifth (+7) + a detuned +0 double.',
  style: 'major',
  intervals: [0, 4, 7, 0],
  voices: [
    { name: 'Voice 1 — Original lead', semitones: 0, delayMs: 0, gain: 1, pan: 0, detuneCents: 0 },
    { name: 'Voice 2 — Harmony +4', semitones: 4, delayMs: 23, gain: 0.3, pan: 0, detuneCents: 0 },
    { name: 'Voice 3 — Harmony +7', semitones: 7, delayMs: 49, gain: 0.4, pan: 0, detuneCents: 0 },
    { name: 'Voice 4 — Double +0', semitones: 0, delayMs: 33, gain: 0.3, pan: 0, detuneCents: -6 },
  ],
};

/** Preset B — alternative harmony (minor third + fifth). */
export const HARMONY_PRESET_B: HarmonyPreset = {
  id: 'preset-b',
  label: 'Preset B — Alternative harmony',
  description: 'Original lead + minor third (+3) + perfect fifth (+7) + a short +0 layer.',
  style: 'minor',
  intervals: [0, 3, 7, 0],
  voices: [
    { name: 'Voice 1 — Original lead', semitones: 0, delayMs: 0, gain: 1, pan: 0, detuneCents: 0 },
    { name: 'Voice 2 — Harmony +3', semitones: 3, delayMs: 23, gain: 0.3, pan: 0, detuneCents: 0 },
    { name: 'Voice 3 — Harmony +7', semitones: 7, delayMs: 19, gain: 0.4, pan: 0, detuneCents: 0 },
    { name: 'Voice 4 — Layer +0', semitones: 0, delayMs: 5, gain: 0.3, pan: 0, detuneCents: 5 },
  ],
};

/**
 * Preset C — natural double-tracking.
 *
 * A true double needs a second recorded take. Without one, the closest honest
 * implementation is a vocal doubler: tiny independent detune, a few cents in
 * opposite directions, plus short timing offsets. That is what these layers
 * are — not a chipmunk, not an echo.
 */
export const HARMONY_PRESET_C: HarmonyPreset = {
  id: 'preset-c',
  label: 'Preset C — Natural double-tracking',
  description: 'Original lead plus three subtly detuned and delayed doubles.',
  style: 'double',
  intervals: [0, 0, 0, 0],
  voices: [
    { name: 'Voice 1 — Original lead', semitones: 0, delayMs: 0, gain: 1, pan: 0, detuneCents: 0 },
    { name: 'Voice 2 — Double', semitones: 0, delayMs: 12, gain: 0.3, pan: 0, detuneCents: -6 },
    { name: 'Voice 3 — Double', semitones: 0, delayMs: 24, gain: 0.25, pan: 0, detuneCents: 7 },
    { name: 'Voice 4 — Double', semitones: 0, delayMs: 36, gain: 0.2, pan: 0, detuneCents: -9 },
  ],
};

export const HARMONY_PRESETS: HarmonyPreset[] = [HARMONY_PRESET_A, HARMONY_PRESET_B, HARMONY_PRESET_C];

export const HARMONY_PRESET_BY_ID: Record<string, HarmonyPreset> = Object.fromEntries(
  HARMONY_PRESETS.map((preset) => [preset.id, preset]),
);

/** Human-readable name for an interval (named presets first, then raw semitones). */
export function describeInterval(semitones: number): string {
  const preset = HARMONY_INTERVAL_PRESETS.find((p) => p.semitones === semitones);
  if (preset) return `${preset.label} (${semitones >= 0 ? '+' : ''}${semitones})`;
  return `${semitones >= 0 ? '+' : ''}${semitones} semitones`;
}

// ---------------------------------------------------------------------------
// Musical key / scale helpers
// ---------------------------------------------------------------------------

export const HARMONY_KEYS: HarmonyKey[] = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const KEY_SEMITONES: Record<HarmonyKey, number> = {
  C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11,
};

const SCALE_STEPS: Record<HarmonyScale, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
};

/** Semitone offsets that belong to the key, relative to the key's root. */
export function scaleIntervals(key: HarmonyKey, scale: HarmonyScale): number[] {
  const root = KEY_SEMITONES[key] ?? 0;
  return SCALE_STEPS[scale].map((step) => (step + root) % 12).sort((a, b) => a - b);
}

/** True when shifting a lead by this interval stays inside the key. */
export function isIntervalInKey(semitones: number, key: HarmonyKey, scale: HarmonyScale): boolean {
  const pitchClass = ((Math.round(semitones) % 12) + 12) % 12;
  return scaleIntervals(key, scale).includes(pitchClass);
}

/**
 * Closest interval (within ±6 semitones) that is diatonic in the key. Used by
 * "Snap to key", never applied automatically — a fixed preset may be exactly
 * what the user wants, so the panel only warns.
 */
export function nearestInKeyInterval(semitones: number, key: HarmonyKey, scale: HarmonyScale): number {
  if (isIntervalInKey(semitones, key, scale)) return semitones;
  for (let distance = 1; distance <= 6; distance++) {
    const up = semitones + distance;
    const down = semitones - distance;
    if (isIntervalInKey(up, key, scale)) return up;
    if (isIntervalInKey(down, key, scale)) return down;
  }
  return semitones;
}

/**
 * Explain why an interval does not fit the selected key, with a concrete
 * alternative. Returns null when the interval is diatonic.
 */
export function describeKeyConflict(
  semitones: number,
  key: HarmonyKey,
  scale: HarmonyScale,
): string | null {
  if (isIntervalInKey(semitones, key, scale)) return null;
  const suggestion = nearestInKeyInterval(semitones, key, scale);
  const name = (value: number) => `${value >= 0 ? '+' : ''}${value}`;
  return `${name(semitones)} is outside ${key} ${scale} — suggested ${name(suggestion)} semitones.`;
}

// ---------------------------------------------------------------------------
// Scope and range handling
// ---------------------------------------------------------------------------

export interface HarmonyScopeSpec {
  scope: HarmonyScope;
  /** Song-timeline start in seconds (used when scope is 'range'). */
  start: number;
  /** Song-timeline end in seconds (used when scope is 'range'). */
  end: number;
  /** Multiple, non-contiguous ranges. When present, these replace start/end. */
  ranges?: Array<Pick<HarmonyRange, 'start' | 'end'> & { enabled?: boolean }>;
}

/** Validate a requested range against the *actual* media duration. */
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

/** Validate every range; returns the first problem (with its range number). */
export function validateHarmonyRanges(
  ranges: Array<{ start: number; end: number }>,
  mediaDuration: number,
): string | null {
  if (!ranges.length) return 'Add at least one time range, or choose Entire Song.';
  for (let i = 0; i < ranges.length; i++) {
    const problem = validateHarmonyRange(ranges[i].start, ranges[i].end, mediaDuration);
    if (problem) return `Range ${i + 1}: ${problem}`;
  }
  return null;
}

/** The ranges a scope actually covers, sorted and clipped to the media. */
export function activeRanges(scope: HarmonyScopeSpec): Array<{ start: number; end: number }> {
  const raw = scope.scope === 'range' && scope.ranges?.length
    ? scope.ranges.filter((r) => r.enabled !== false).map((r) => ({ start: r.start, end: r.end }))
    : scope.scope === 'range'
      ? [{ start: scope.start, end: scope.end }]
      : [];
  return raw
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start);
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
   * What a range-scoped voice contains outside the requested ranges.
   * 'silence' (default) keeps the voice silent there; 'preserve' keeps the
   * original samples (for an in-place pitch shift over a selection).
   */
  outside?: 'silence' | 'preserve';
  /** Micro-detune in cents, applied on top of `semitones`. */
  detuneCents?: number;
  /** 0…1 formant preservation (1 = keep the vocal-tract resonances). */
  formantPreserve?: number;
  /** Crossfade at range boundaries, seconds. */
  fadeSeconds?: number;
  onProgress?: ProgressFn;
}

const DEFAULT_EDGE_FADE = 0.015;

function blendInto(
  target: AudioData,
  source: AudioData,
  fromSample: number,
  toSample: number,
  fadeSamples: number,
  sourceOffset = 0,
): void {
  const channels = Math.min(target.channels.length, source.channels.length);
  const start = Math.max(0, fromSample);
  const length = Math.min(source.length - sourceOffset, toSample - start);
  for (let c = 0; c < channels; c++) {
    const from = source.channels[c];
    const to = target.channels[c];
    for (let i = 0; i < length; i++) {
      // Raised-cosine fade at both edges: no click, no sudden level change.
      let gain = 1;
      if (fadeSamples > 0) {
        if (i < fadeSamples) gain = 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeSamples);
        else if (i > length - fadeSamples) gain = 0.5 - 0.5 * Math.cos((Math.PI * (length - i)) / fadeSamples);
      }
      to[start + i] += from[sourceOffset + i] * gain;
    }
  }
}

/**
 * Render one harmony voice.
 *
 * - `semitones === 0` (and no detune) returns the original samples untouched.
 * - scope 'entire-song' pitch-shifts the complete buffer.
 * - scope 'range' processes each requested range independently, with a short
 *   raised-cosine fade at the boundaries. Nothing is rendered outside the
 *   ranges, and unselected sections are never touched.
 */
export function renderHarmonyVoice(
  source: AudioData,
  semitones: number,
  scope: HarmonyScopeSpec,
  clipStart: number,
  options: HarmonyVoiceOptions = {},
): AudioData {
  const combined = semitones + (options.detuneCents ?? 0) / 100;
  const formantPreserve = options.formantPreserve ?? 1;
  const duration = source.length / source.sampleRate;
  if (Math.abs(combined) < 1e-9) return cloneAudio(source);

  if (scope.scope === 'entire-song') {
    return pitchShift(source, combined, options.onProgress, { formantPreserve });
  }

  const sampleRate = source.sampleRate;
  const keepOutside = (options.outside ?? 'silence') === 'preserve';
  const channels = source.channels.map((channel) => (keepOutside ? new Float32Array(channel) : new Float32Array(channel.length)));
  const target = audioData(channels, sampleRate);
  const fade = Math.max(1, Math.round((options.fadeSeconds ?? DEFAULT_EDGE_FADE) * sampleRate));
  const ranges = activeRanges(scope);
  const pad = 4096;

  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index];
    const localStart = Math.max(0, range.start - clipStart);
    const localEnd = Math.min(duration, range.end - clipStart);
    if (localEnd <= localStart + 1e-6) continue;
    const startSample = Math.round(localStart * sampleRate);
    const endSample = Math.min(source.length, Math.round(localEnd * sampleRate));
    // Process just this section (plus a little context so the vocoder has
    // signal at both edges). Only the selected samples are mixed back.
    const from = Math.max(0, startSample - pad);
    const to = Math.min(source.length, endSample + pad);
    const slice = audioData(
      source.channels.map((channel) => channel.slice(from, to)),
      sampleRate,
    );
    const shifted = pitchShift(slice, combined, (p, message) => {
      options.onProgress?.((index + p) / ranges.length, message);
    }, { formantPreserve });
    // Fades must stay inside the range: they ease the harmony in and out but
    // never extend it into an unselected section.
    const edge = Math.min(fade, Math.max(1, Math.floor((endSample - startSample) / 4)));
    // `shifted` starts at sample `from` of the source, so the sample that lands
    // on the timeline at `startSample` is `startSample - from` inside it.
    blendInto(target, shifted, startSample, endSample, edge, startSample - from);
  }
  return target;
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
  /** Delay relative to the lead, in seconds. */
  offsetSeconds: number;
  /** Stereo position, -1…+1. */
  pan: number;
  /** Micro-detune, cents (keeps doubled +0 layers from comb-filtering). */
  detuneCents: number;
  /** Track name used when this voice is applied. */
  name: string;
  /** Name of the track the voice is assigned to. Empty means "use `name`". */
  targetTrackName: string;
  /** Effects baked into this voice when it is rendered. */
  effects: RangeEffect[];
}

let voiceCounter = 0;
const nextVoiceId = (): string => `voice-${Date.now().toString(36)}-${(voiceCounter++).toString(36)}`;

/** Build preset voices with the exact starting values from the specification. */
export function voicesFromPreset(preset: HarmonyPreset): HarmonyVoiceDraft[] {
  return preset.voices.map((voice) => ({
    id: nextVoiceId(),
    semitones: voice.semitones,
    enabled: true,
    gain: voice.gain,
    offsetSeconds: voice.delayMs / 1000,
    pan: voice.pan,
    detuneCents: voice.detuneCents,
    name: voice.name,
    targetTrackName: '',
    effects: [],
  }));
}

/** Build the voice list for a set of intervals (legacy helper and tests). */
export function voicesFromIntervals(intervals: number[]): HarmonyVoiceDraft[] {
  return intervals.map((semitones, index) => ({
    id: nextVoiceId(),
    semitones,
    enabled: true,
    gain: semitones === 0 ? 1 : 0.8,
    offsetSeconds: 0,
    pan: 0,
    detuneCents: 0,
    name: semitones === 0 ? `Voice ${index + 1} — Original lead` : `Voice ${index + 1} — Harmony ${semitones >= 0 ? '+' : ''}${semitones}`,
    targetTrackName: '',
    effects: [],
  }));
}

/** The standard harmony slots offered to the user (Voice 2, Voice 3, Voice 4 …). */
export const HARMONY_TRACK_SLOTS = ['Voice 2', 'Voice 3', 'Voice 4', 'Voice 5', 'Voice 6'];

/**
 * Resolve the track name for every voice.
 *
 * The +0 lead voice stays on the source track (original pitch, no duplicate
 * audio). Other voices go to the preset's track name, the track the user
 * picked, or the next free "Voice N" slot. Names are always unique.
 */
export function harmonyTargetNames(
  voices: Array<Pick<HarmonyVoiceDraft, 'semitones' | 'enabled' | 'targetTrackName' | 'name' | 'detuneCents'>>,
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
    const isOriginalLead = voice.semitones === 0 && (voice.detuneCents ?? 0) === 0;
    if (isOriginalLead && !separateOriginalTrack) {
      names.push('');
      continue;
    }
    const preferred = voice.targetTrackName.trim() || voice.name.trim();
    let name = preferred;
    const sourceKey = sourceTrackName.trim().toLowerCase();
    if (!name || name.toLowerCase() === sourceKey) {
      // A harmony voice must never be written onto the source track: it would
      // destroy the lead instead of harmonizing with it.
      while (used.has(`voice ${autoIndex}`)) autoIndex++;
      name = `Voice ${autoIndex}`;
      autoIndex++;
    }
    used.add(name.toLowerCase());
    names.push(name);
  }
  return names;
}

/** Mix rendered voice signals into one preview buffer (with real panning). */
export function mixVoiceSignals(
  voices: Array<{ data: AudioData; gain: number; pan?: number }>,
  sampleRate: number,
): AudioData {
  const channelCount = Math.max(2, ...voices.map((v) => v.data.channels.length));
  const length = Math.max(0, ...voices.map((v) => v.data.length));
  const out = Array.from({ length: channelCount }, () => new Float32Array(length));
  for (const voice of voices) {
    const pan = clamp(voice.pan ?? 0, -1, 1);
    const angle = ((pan + 1) * Math.PI) / 4;
    const gains = [Math.cos(angle) * Math.SQRT2, Math.sin(angle) * Math.SQRT2];
    for (let c = 0; c < channelCount; c++) {
      const source = voice.data.channels[Math.min(c, voice.data.channels.length - 1)];
      const channelGain = voice.data.channels.length === 1 ? gains[c] : gains[c];
      const target = out[c];
      for (let i = 0; i < source.length && i < target.length; i++) target[i] += source[i] * voice.gain * channelGain;
    }
  }
  return audioData(out, sampleRate);
}

/** Human-readable summary of what a harmonization run will touch. */
export function describeScope(scope: HarmonyScopeSpec, mediaDuration: number): string {
  if (scope.scope === 'entire-song') {
    return `Entire Song — the complete ${formatDuration(mediaDuration)} duration is processed from the first sample to the last.`;
  }
  const ranges = activeRanges(scope);
  if (ranges.length <= 1) {
    const only = ranges[0] ?? { start: scope.start, end: scope.end };
    const length = Math.max(0, only.end - only.start);
    return `Selected Time Range — ${formatDuration(only.start)} to ${formatDuration(only.end)} (${length.toFixed(3)}s of ${formatDuration(mediaDuration)}). Audio outside the range is preserved.`;
  }
  const total = ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
  return `${ranges.length} ranges (${total.toFixed(2)}s total of ${formatDuration(mediaDuration)}): ${ranges
    .map((r) => `${formatDuration(r.start)}–${formatDuration(r.end)}`)
    .join(', ')}. Audio between the ranges is never processed.`;
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

/** Format a delay for the UI and screen readers. */
export function describeDelay(seconds: number): string {
  return `${Math.round(seconds * 1000)} milliseconds`;
}

/** Pan description used in accessible labels: "50 percent left", "centre". */
export function describePan(pan: number): string {
  const value = Math.round(clamp(pan, -1, 1) * 100);
  if (value === 0) return 'centre';
  return `${Math.abs(value)} percent ${value < 0 ? 'left' : 'right'}`;
}
