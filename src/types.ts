export interface AudioData {
  /** One Float32Array per channel. Every array has the same length. */
  channels: Float32Array[];
  sampleRate: number;
  length: number;
}

export type EffectType =
  | 'pitch'
  | 'harmony'
  | 'reverb'
  | 'echo'
  | 'eq'
  | 'volume'
  | 'fadeIn'
  | 'fadeOut'
  | 'noiseReduction';

export interface RangeEffect {
  id: string;
  type: EffectType;
  /** Clip-local start/end in seconds. */
  start: number;
  end: number;
  params: {
    semitones?: number;
    intervals?: number[];
    harmonyGain?: number;
    reverbSeconds?: number;
    reverbMix?: number;
    echoDelay?: number;
    echoFeedback?: number;
    echoMix?: number;
    eqLow?: number;
    eqMid?: number;
    eqHigh?: number;
    gain?: number;
    noiseThresholdDb?: number;
  };
  enabled: boolean;
}

export type SeparationStatus = 'not-run' | 'processing' | 'ready' | 'failed';
export type SeparationMethod = 'local-approximate' | 'demucs-server' | 'none';

export interface VocalState {
  enabled: boolean;
  status: SeparationStatus;
  method: SeparationMethod;
  /** Asset ids for the isolated stems. The original clip asset is never replaced. */
  vocalAssetId?: string;
  instrumentalAssetId?: string;
  separatedFromAssetId?: string;
  quality: number;
  qualityMessage: string;
  pitchSemis: number;
  preserveTempo: boolean;
  vocalVolume: number;
  mixWithAccompaniment: boolean;
  error?: string;
  warning?: string;
}

export interface Clip {
  id: string;
  assetId: string;
  name: string;
  /**
   * Stereo position for this clip, -1 (hard left) … 0 (centre) … +1 (hard
   * right). `undefined` means "follow the track's pan".
   */
  pan?: number;
  /** Timeline start in seconds; a numeric field is always available (no drag-only editing). */
  start: number;
  /** Offset into the source asset in seconds. */
  sourceStart: number;
  /** Playable length in seconds. */
  duration: number;
  gain: number;
  fadeIn: number;
  fadeOut: number;
  effects: RangeEffect[];
}

export interface Track {
  id: string;
  name: string;
  volume: number;
  /** Stereo position -1 … +1. Real panning in playback and export. */
  pan: number;
  muted: boolean;
  solo: boolean;
  /** Committed, whole-track pitch adjustment in semitones. */
  pitchSemis: number;
  pitchFineCents: number;
  clips: Clip[];
  vocal: VocalState;
}

/** Which part of the song a harmony voice covers. */
export type HarmonyScope = 'entire-song' | 'range';

/** Musical key used to keep harmony intervals diatonic. */
export type HarmonyKey = 'C' | 'C#' | 'D' | 'D#' | 'E' | 'F' | 'F#' | 'G' | 'G#' | 'A' | 'A#' | 'B';
export type HarmonyScale = 'major' | 'minor';

/** A time range that harmonization applies to (song timeline). */
export interface HarmonyRange {
  id: string;
  /** Song-time start in seconds. */
  start: number;
  /** Song-time end in seconds. */
  end: number;
  enabled: boolean;
  /** Optional user label, announced by screen readers. */
  label?: string;
}

export interface HarmonyLayer {
  id: string;
  name: string;
  sourceTrackId: string;
  targetTrackId: string;
  /** Clip (on the target track) that holds this layer's real shifted signal. */
  clipId?: string;
  semitones: number;
  gain: number;
  muted: boolean;
  solo: boolean;
  vocalsOnly: boolean;
  /** Timing offset (delay) relative to the source start, in seconds. */
  offsetSeconds: number;
  /** Stereo position of this voice, -1 … +1. */
  pan?: number;
  /** Micro-detune in cents used to de-correlate doubled voices. */
  detuneCents?: number;
  /** Full rendered length before the delay trims it, in seconds. */
  clipDuration?: number;
  /** Effects baked into this layer's rendered signal (independent per voice). */
  effects: RangeEffect[];
  /** Entire song or a selected time range. */
  scope: HarmonyScope;
  /** Song-time range when scope is 'range'. */
  rangeStart?: number;
  rangeEnd?: number;
  /** All ranges when a voice was applied to several non-contiguous sections. */
  ranges?: Array<{ start: number; end: number }>;
  /**
   * True for the +0 voice. The original-pitch voice reuses the source track's
   * own audio, so no duplicated audio is rendered for it.
   */
  originalVoice: boolean;
  /** Groups the layers produced by one harmonization apply, so it can be replaced or undone as a unit. */
  groupId?: string;
}

export interface RecordingTake {
  id: string;
  assetId: string;
  name: string;
  trackId: string;
  start: number;
  duration: number;
  createdAt: number;
}

export type ExportFormat = 'wav' | 'mp3' | 'm4a';
export type ExportScope = 'project' | 'range' | 'track' | 'stems';

export interface ExportSettings {
  format: ExportFormat;
  scope: ExportScope;
  filename: string;
  sampleRate: 44100 | 48000 | 96000;
  bitDepth: 16 | 24 | 32;
  bitrate: 96 | 128 | 192 | 256 | 320;
  channels: 1 | 2;
  normalize: boolean;
  preventClipping: boolean;
}

export interface MediaRef {
  assetId: string;
  name: string;
  mime: string;
  size: number;
  kind: 'audio' | 'video-original' | 'extracted-audio' | 'processed' | 'recording';
  createdAt: number;
}

export interface Project {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  tracks: Track[];
  harmonies: HarmonyLayer[];
  /** Reusable time ranges for harmonization (multiple, non-contiguous). */
  harmonyRanges: HarmonyRange[];
  /** Musical key used for diatonic harmony hints and snapping. */
  harmonyKey: HarmonyKey;
  harmonyScale: HarmonyScale;
  selection: { start: number; end: number } | null;
  selectedTrackId: string | null;
  selectedClipId: string | null;
  zoom: number;
  recordings: RecordingTake[];
  media: MediaRef[];
  exportSettings: ExportSettings;
}

export interface AppSettings {
  skipSeconds: number;
  theme: 'dark' | 'light' | 'system';
  highContrast: boolean;
  reduceMotion: boolean;
  announcements: boolean;
  defaultExport: ExportSettings;
  separationApiUrl: string;
  maxFileSizeMB: number;
  masterVolume: number;
}

export interface StoredAsset {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: MediaRef['kind'];
  blob: Blob;
  createdAt: number;
}

export const defaultVocalState = (): VocalState => ({
  enabled: false,
  status: 'not-run',
  method: 'none',
  quality: 0,
  qualityMessage: 'Vocal separation has not been run for this track.',
  pitchSemis: 0,
  preserveTempo: true,
  vocalVolume: 1,
  mixWithAccompaniment: true,
});

export const defaultExportSettings = (): ExportSettings => ({
  format: 'wav',
  scope: 'project',
  filename: 'wishes-mix',
  sampleRate: 44100,
  bitDepth: 16,
  bitrate: 192,
  channels: 2,
  normalize: false,
  preventClipping: true,
});

export const defaultAppSettings = (): AppSettings => ({
  skipSeconds: 5,
  theme: 'dark',
  highContrast: false,
  reduceMotion: false,
  announcements: true,
  defaultExport: defaultExportSettings(),
  separationApiUrl: '',
  maxFileSizeMB: 250,
  masterVolume: 0.85,
});

export const makeId = (prefix = 'id'): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${rest.toFixed(3).padStart(6, '0')}`;
};

export const parseTime = (value: string): number | null => {
  const parts = value.trim().split(':');
  if (parts.length === 1) {
    const n = Number(parts[0]);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  if (parts.length === 2) {
    const m = Number(parts[0]);
    const s = Number(parts[1]);
    return Number.isFinite(m) && Number.isFinite(s) && m >= 0 && s >= 0 && s < 60
      ? m * 60 + s
      : null;
  }
  return null;
};

export const projectDuration = (project: Project, assetLengths: Map<string, number>): number => {
  let end = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const sourceLength = assetLengths.get(clip.assetId) ?? clip.duration;
      const playable = Math.max(0, Math.min(clip.duration, sourceLength - clip.sourceStart));
      end = Math.max(end, clip.start + playable);
    }
  }
  return end;
};
