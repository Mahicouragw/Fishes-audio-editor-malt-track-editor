import type { AudioData, Clip, HarmonyLayer, Track } from '../types';
import { clamp } from '../types';
import { cloneAudio, applyFades, resampleAudio, audioData, type ProgressFn } from './dsp';
import { runDspJob } from './dspRunner';
import { loadAudioData } from '../storage/assets';

export function effectivePitchSemis(track: Track): number {
  return track.pitchSemis + track.pitchFineCents / 100;
}

/** True when at least one harmony voice is soloed. */
export function hasHarmonySolo(harmonies: HarmonyLayer[]): boolean {
  return harmonies.some((h) => h.solo);
}

/** The harmony layer that owns a given clip, if any. */
export function layerForClip(harmonies: HarmonyLayer[], clipId: string): HarmonyLayer | undefined {
  return harmonies.find((h) => h.clipId === clipId);
}

/**
 * Constant-power pan law, normalised so the centre is unity gain.
 *
 * centre → [1, 1]; hard left → [√2, 0]; hard right → [0, √2].
 * This is the same law in playback and export, so what you hear is what is
 * written to the file.
 */
export function panGains(pan: number | undefined): [number, number] {
  const value = clamp(pan ?? 0, -1, 1);
  const angle = ((value + 1) * Math.PI) / 4;
  return [Math.cos(angle) * Math.SQRT2, Math.sin(angle) * Math.SQRT2];
}

/**
 * The pan actually used for a clip: the harmony layer's own pan, else a
 * per-clip override, else the track's pan.
 */
export function effectivePan(track: Track, clip: Clip, harmonies: HarmonyLayer[] = []): number {
  const layer = layerForClip(harmonies, clip.id);
  if (layer && typeof layer.pan === 'number') return clamp(layer.pan, -1, 1);
  if (typeof clip.pan === 'number') return clamp(clip.pan, -1, 1);
  return clamp(track.pan ?? 0, -1, 1);
}

/**
 * Gain applied to a clip that carries a harmony voice.
 * A muted voice is silent; when any voice is soloed, the others fall silent.
 */
export function harmonyClipFactor(track: Track, clip: Clip, harmonies: HarmonyLayer[]): number {
  const layer = layerForClip(harmonies, clip.id);
  if (!layer) return 1;
  if (layer.muted) return 0;
  if (hasHarmonySolo(harmonies) && !layer.solo) return 0;
  return layer.gain ?? 1;
}

/**
 * Gain applied to the source track's own audio when the +0 (original pitch)
 * voice is part of a harmonization. The original voice reuses the source
 * track's audio instead of storing a duplicate.
 */
export function originalVoiceFactor(track: Track, harmonies: HarmonyLayer[]): number {
  const layer = harmonies.find((h) => h.originalVoice && h.sourceTrackId === track.id);
  if (!layer) return 1;
  if (layer.muted) return 0;
  if (hasHarmonySolo(harmonies) && !layer.solo) return 0;
  return layer.gain ?? 1;
}

export interface PrepareClipOptions {
  onProgress?: ProgressFn;
  /** Test hook: override where clip/stem audio is loaded from. */
  load?: (assetId: string) => Promise<AudioData>;
  /** Cancel a long render (human-voice processing can take a while). */
  signal?: AbortSignal;
}

/**
 * Render one clip through its committed processing chain:
 * vocal-stem path (or honest whole-track fallback), whole-track pitch,
 * clip range effects, and fades. This is the single source of truth shared by
 * playback, previews and export, so they can never disagree.
 */
export async function prepareClipData(track: Track, clip: Clip, options: PrepareClipOptions = {}): Promise<AudioData> {
  const load = options.load ?? loadAudioData;
  const data = await load(clip.assetId);
  const v = track.vocal;
  const semis = effectivePitchSemis(track);
  let out: AudioData;
  if (v.enabled && v.status === 'ready' && v.vocalAssetId) {
    const vocal = await load(v.vocalAssetId);
    const instrumental = v.instrumentalAssetId ? await load(v.instrumentalAssetId) : null;
    const result = await runDspJob(
      {
        kind: 'voiceOnly',
        original: data,
        vocal,
        instrumental,
        options: {
          enabled: true,
          semitones: v.pitchSemis,
          preserveTempo: v.preserveTempo,
          vocalVolume: v.vocalVolume,
          mixWithAccompaniment: v.mixWithAccompaniment,
        },
      },
      options.onProgress,
      { signal: options.signal },
    );
    if (!result.data) throw new Error('Vocal processing produced no audio');
    out = result.data;
  } else {
    out = semis !== 0
      ? (await runDspJob({ kind: 'pitch', data, semitones: semis }, options.onProgress, { signal: options.signal })).data ?? cloneAudio(data)
      : cloneAudio(data);
  }
  for (const effect of clip.effects) {
    if (!effect.enabled) continue;
    const result = await runDspJob({ kind: 'range', data: out, effect }, options.onProgress, { signal: options.signal });
    if (!result.data) throw new Error(`Effect ${effect.type} produced no audio`);
    out = result.data;
  }
  return applyFades(out, clip.fadeIn, clip.fadeOut);
}

export interface MixEntry {
  data: AudioData;
  /** Timeline position in seconds. */
  start: number;
  gain: number;
  /** Stereo position, -1…+1. Omitted means centre. */
  pan?: number;
}

/**
 * Mix pre-rendered clip data into one output at the requested rate/layout.
 *
 * Panning is real: a two-channel mix receives the constant-power left/right
 * gains, so export is identical to what playback pans do. A mono export has
 * no stereo field, so pan is ignored there (and the UI says so).
 */
export function mixEntries(entries: MixEntry[], sampleRate: number, channels: 1 | 2, onProgress?: ProgressFn): AudioData {
  let end = 0;
  for (const entry of entries) end = Math.max(end, entry.start + entry.data.length / entry.data.sampleRate);
  const length = Math.max(0, Math.ceil(end * sampleRate));
  const mix = Array.from({ length: channels }, () => new Float32Array(length));
  entries.forEach((entry, index) => {
    if (index % 4 === 0 && onProgress) onProgress(index / Math.max(1, entries.length), 'Mixing tracks');
    const resampled = resampleAudio(entry.data, sampleRate);
    const offset = Math.max(0, Math.round(entry.start * sampleRate));
    const [leftGain, rightGain] = panGains(entry.pan);
    for (let c = 0; c < channels; c++) {
      const channelGain = channels === 1 ? 1 : c === 0 ? leftGain : rightGain;
      // A mono source feeds both sides; a stereo source keeps its own sides
      // and is balanced by the pan law.
      const source = resampled.channels.length === 1
        ? resampled.channels[0]
        : resampled.channels[Math.min(c, resampled.channels.length - 1)];
      const target = mix[c];
      const count = Math.min(source.length, target.length - offset);
      for (let i = 0; i < count; i++) target[offset + i] += source[i] * entry.gain * channelGain;
    }
  });
  return audioData(mix, sampleRate);
}
