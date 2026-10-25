import type { AudioData, Clip, Track } from '../types';
import { cloneAudio, applyFades, resampleAudio, audioData, type ProgressFn } from './dsp';
import { runDspJob } from './dspRunner';
import { loadAudioData } from '../storage/assets';

export function effectivePitchSemis(track: Track): number {
  return track.pitchSemis + track.pitchFineCents / 100;
}

export function harmonyClipFactor(track: Track, clip: Clip, harmonies: { clipId?: string; muted?: boolean; gain?: number }[]): number {
  const layer = harmonies.find((h) => h.clipId === clip.id);
  if (!layer) return 1;
  return layer.muted ? 0 : (layer.gain ?? 1);
}

export interface PrepareClipOptions {
  onProgress?: ProgressFn;
  /** Test hook: override where clip/stem audio is loaded from. */
  load?: (assetId: string) => Promise<AudioData>;
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
    );
    if (!result.data) throw new Error('Vocal processing produced no audio');
    out = result.data;
  } else {
    out = semis !== 0
      ? (await runDspJob({ kind: 'pitch', data, semitones: semis }, options.onProgress)).data ?? cloneAudio(data)
      : cloneAudio(data);
  }
  for (const effect of clip.effects) {
    if (!effect.enabled) continue;
    const result = await runDspJob({ kind: 'range', data: out, effect }, options.onProgress);
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
}

/** Mix pre-rendered clip data into one output at the requested rate/layout. */
export function mixEntries(entries: MixEntry[], sampleRate: number, channels: 1 | 2, onProgress?: ProgressFn): AudioData {
  let end = 0;
  for (const entry of entries) end = Math.max(end, entry.start + entry.data.length / entry.data.sampleRate);
  const length = Math.max(0, Math.ceil(end * sampleRate));
  const mix = Array.from({ length: channels }, () => new Float32Array(length));
  entries.forEach((entry, index) => {
    if (index % 4 === 0 && onProgress) onProgress(index / Math.max(1, entries.length), 'Mixing tracks');
    const resampled = resampleAudio(entry.data, sampleRate);
    const offset = Math.max(0, Math.round(entry.start * sampleRate));
    for (let c = 0; c < channels; c++) {
      const source = resampled.channels[Math.min(c, resampled.channels.length - 1)];
      const target = mix[c];
      const count = Math.min(source.length, target.length - offset);
      for (let i = 0; i < count; i++) target[offset + i] += source[i] * entry.gain;
    }
  });
  return audioData(mix, sampleRate);
}
