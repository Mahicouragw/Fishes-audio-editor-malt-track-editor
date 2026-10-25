import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { normalizeProject, useProjectStore, type ProjectStore, type HarmonyGroupVoice } from './projectStore';
import { audioData } from '../audio/dsp';
import { buildSong } from '../test/songFixture';
import { storeAudioData, cacheAudioData } from '../storage/assets';
import * as db from '../storage/db';
import type { AudioData } from '../types';

const SAMPLE_RATE = 22050;

async function freshStore(): Promise<{ getStore: () => ProjectStore; unmount: () => void }> {
  await db.clearAll();
  const { result, unmount } = renderHook(() => useProjectStore());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  return { getStore: () => result.current, unmount };
}

function tone(seconds = 2): AudioData {
  const length = Math.round(SAMPLE_RATE * seconds);
  return audioData([new Float32Array(length).fill(0.1)], SAMPLE_RATE);
}

async function storeVoiceAudio(name: string): Promise<{ assetId: string; size: number }> {
  const data = tone();
  const asset = await storeAudioData(data, name, 'processed');
  cacheAudioData(asset.id, data);
  return { assetId: asset.id, size: asset.size };
}

beforeEach(async () => {
  await db.clearAll();
});

describe('harmonization in the project store', () => {
  it('creates Voice 2 / Voice 3 / Voice 4 on demand for harmony voices', async () => {
    const { getStore, unmount } = await freshStore();
    // The default project has Voice 1 and Voice 2.
    expect(getStore().project.tracks.map((t) => t.name)).toEqual(['Voice 1', 'Voice 2']);
    let ids: string[] = [];
    act(() => {
      ids = getStore().ensureTracks(['Voice 2', 'Voice 3', 'Voice 4']);
    });
    expect(ids).toHaveLength(3);
    expect(getStore().project.tracks.map((t) => t.name)).toEqual(['Voice 1', 'Voice 2', 'Voice 3', 'Voice 4']);
    // Re-using an existing name does not create a duplicate track.
    act(() => {
      ids = getStore().ensureTracks(['Voice 3']);
    });
    expect(getStore().project.tracks).toHaveLength(4);
    expect(ids).toHaveLength(1);
    unmount();
  });

  it('applies a preset as one undoable change with real clip audio per voice', async () => {
    const { getStore, unmount } = await freshStore();
    const sourceId = getStore().project.tracks[0].id;
    const tracks = getStore().ensureTracks(['Voice 2', 'Voice 3']);
    const [voice2, voice3] = tracks;

    const fourth = await storeVoiceAudio('Harmony +4');
    const fifth = await storeVoiceAudio('Harmony +7');
    const voices: HarmonyGroupVoice[] = [
      {
        name: 'Original (+0)',
        semitones: 0,
        gain: 1,
        muted: false,
        solo: false,
        vocalsOnly: false,
        offsetSeconds: 0,
        effects: [],
        scope: 'entire-song',
        targetTrackId: sourceId,
      },
      {
        name: 'Harmony +4',
        semitones: 4,
        gain: 0.8,
        muted: false,
        solo: false,
        vocalsOnly: false,
        offsetSeconds: 0,
        effects: [],
        scope: 'entire-song',
        targetTrackId: voice2,
        clip: { assetId: fourth.assetId, start: 0, duration: 2, size: fourth.size },
      },
      {
        name: 'Harmony +7',
        semitones: 7,
        gain: 0.7,
        muted: false,
        solo: false,
        vocalsOnly: false,
        offsetSeconds: 0,
        effects: [],
        scope: 'entire-song',
        targetTrackId: voice3,
        clip: { assetId: fifth.assetId, start: 0, duration: 2, size: fifth.size },
      },
    ];

    act(() => {
      getStore().applyHarmonyGroup('harmony:group-1', sourceId, voices);
    });

    const harmonies = getStore().project.harmonies;
    expect(harmonies).toHaveLength(3);
    expect(harmonies.map((h) => h.semitones)).toEqual([0, 4, 7]);
    expect(harmonies.every((h) => h.groupId === 'harmony:group-1')).toBe(true);
    // The +0 voice reuses the source audio: no clip of its own.
    const original = harmonies.find((h) => h.originalVoice);
    expect(original?.clipId).toBeUndefined();
    // The rendered voices own exactly one clip each on their target track.
    const voice2Track = getStore().project.tracks.find((t) => t.id === voice2);
    const voice3Track = getStore().project.tracks.find((t) => t.id === voice3);
    expect(voice2Track?.clips).toHaveLength(1);
    expect(voice3Track?.clips).toHaveLength(1);
    expect(getStore().project.tracks.find((t) => t.id === sourceId)?.clips).toHaveLength(0);

    // Applying the group is exactly one undo step: undo clears every voice,
    // redo brings all of them back.
    act(() => getStore().undo());
    expect(getStore().project.harmonies).toHaveLength(0);
    expect(getStore().project.tracks.find((t) => t.id === voice2)?.clips).toHaveLength(0);
    act(() => getStore().redo());
    expect(getStore().project.harmonies).toHaveLength(3);
    expect(getStore().project.tracks.find((t) => t.id === voice2)?.clips).toHaveLength(1);

    // Re-applying the same group replaces the previous voices instead of
    // stacking a second copy.
    act(() => {
      getStore().applyHarmonyGroup('harmony:group-1', sourceId, voices);
    });
    expect(getStore().project.harmonies).toHaveLength(3);
    expect(getStore().project.tracks.find((t) => t.id === voice2)?.clips).toHaveLength(1);
    expect(getStore().project.tracks.find((t) => t.id === voice3)?.clips).toHaveLength(1);
    unmount();
  });

  it('keeps each voice independent: mute, solo, gain, offset, remove', async () => {
    const { getStore, unmount } = await freshStore();
    const sourceId = getStore().project.tracks[0].id;
    const [voice2] = getStore().ensureTracks(['Voice 2']);
    const audio = await storeVoiceAudio('Harmony +3');
    act(() => {
      getStore().applyHarmonyGroup('g1', sourceId, [{
        name: 'Harmony +3',
        semitones: 3,
        gain: 0.9,
        muted: false,
        solo: false,
        vocalsOnly: false,
        offsetSeconds: 0,
        effects: [],
        scope: 'entire-song',
        targetTrackId: voice2,
        clip: { assetId: audio.assetId, start: 0, duration: 2, size: audio.size },
      }]);
    });
    const layerId = getStore().project.harmonies[0].id;
    const clipId = getStore().project.harmonies[0].clipId!;

    act(() => getStore().updateHarmony(layerId, { muted: true }));
    expect(getStore().project.harmonies[0].muted).toBe(true);
    act(() => getStore().updateHarmony(layerId, { solo: true, gain: 0.4 }));
    expect(getStore().project.harmonies[0].solo).toBe(true);
    expect(getStore().project.harmonies[0].gain).toBe(0.4);

    // Moving a voice in time moves its clip, keeping sync.
    act(() => getStore().setHarmonyOffset(layerId, 0.5));
    expect(getStore().project.harmonies[0].offsetSeconds).toBe(0.5);
    expect(getStore().project.tracks.find((t) => t.id === voice2)?.clips[0].start).toBe(0.5);

    // Removing one voice leaves the others (and the source) alone.
    act(() => getStore().removeHarmony(layerId));
    expect(getStore().project.harmonies).toHaveLength(0);
    expect(getStore().project.tracks.find((t) => t.id === voice2)?.clips).toHaveLength(0);
    expect(getStore().project.tracks.find((t) => t.id === sourceId)).toBeTruthy();
    void clipId;
    unmount();
  });

  it('removes a whole group (the cancel path) without touching other groups', async () => {
    const { getStore, unmount } = await freshStore();
    const sourceId = getStore().project.tracks[0].id;
    const [voice2, voice3] = getStore().ensureTracks(['Voice 2', 'Voice 3']);
    const a = await storeVoiceAudio('Harmony +4');
    const b = await storeVoiceAudio('Harmony +7');
    act(() => {
      getStore().applyHarmonyGroup('g1', sourceId, [{
        name: 'Harmony +4', semitones: 4, gain: 1, muted: false, solo: false,
        vocalsOnly: false, offsetSeconds: 0, effects: [], scope: 'entire-song',
        targetTrackId: voice2, clip: { assetId: a.assetId, start: 0, duration: 2, size: a.size },
      }]);
      getStore().applyHarmonyGroup('g2', sourceId, [{
        name: 'Harmony +7', semitones: 7, gain: 1, muted: false, solo: false,
        vocalsOnly: false, offsetSeconds: 0, effects: [], scope: 'entire-song',
        targetTrackId: voice3, clip: { assetId: b.assetId, start: 0, duration: 2, size: b.size },
      }]);
    });
    expect(getStore().project.harmonies).toHaveLength(2);
    act(() => getStore().removeHarmonyGroup('g1'));
    expect(getStore().project.harmonies.map((h) => h.groupId)).toEqual(['g2']);
    expect(getStore().project.tracks.find((t) => t.id === voice2)?.clips).toHaveLength(0);
    expect(getStore().project.tracks.find((t) => t.id === voice3)?.clips).toHaveLength(1);
    unmount();
  });

  it('reopens a legacy project whose harmony layers predate the new fields', async () => {
    // A project saved by an older build: no solo/offset/effects/scope fields.
    const legacy = {
      id: 'project-legacy',
      title: 'Legacy',
      createdAt: 1,
      updatedAt: 1,
      tracks: [{
        id: 'track-a', name: 'Voice 1', volume: 1, muted: false, solo: false,
        pitchSemis: 0, pitchFineCents: 0,
        clips: [{
          id: 'clip-a', assetId: 'asset-a', name: 'song.wav', start: 0,
          sourceStart: 0, duration: 3, gain: 1, fadeIn: 0, fadeOut: 0, effects: [],
        }],
        vocal: { enabled: false, status: 'not-run', method: 'none', quality: 0, qualityMessage: '', pitchSemis: 0, preserveTempo: true, vocalVolume: 1, mixWithAccompaniment: true },
      }],
      harmonies: [{
        id: 'legacy-harmony', name: 'Harmony +7', sourceTrackId: 'track-a',
        targetTrackId: 'track-a', clipId: 'clip-a', semitones: 7, gain: 0.5,
        muted: false, vocalsOnly: false,
      }],
      selection: null, selectedTrackId: null, selectedClipId: null, zoom: 1,
      recordings: [], media: [],
      exportSettings: {
        format: 'wav', scope: 'project', filename: 'legacy', sampleRate: 44100,
        bitDepth: 16, bitrate: 192, channels: 2, normalize: false, preventClipping: true,
      },
    };
    const normalized = normalizeProject(legacy as unknown as Parameters<typeof normalizeProject>[0]);
    expect(normalized.harmonies[0].solo).toBe(false);
    expect(normalized.harmonies[0].offsetSeconds).toBe(0);
    expect(normalized.harmonies[0].effects).toEqual([]);
    expect(normalized.harmonies[0].scope).toBe('entire-song');
    // A legacy layer that owns rendered audio is not the +0 reference voice.
    expect(normalized.harmonies[0].originalVoice).toBe(false);
    expect(normalized.tracks[0].vocal.enabled).toBe(false);
  });

  it('saves and reopens with settings and track arrangement preserved', async () => {
    const { getStore, unmount } = await freshStore();
    const sourceId = getStore().project.tracks[0].id;
    const song = buildSong(2, SAMPLE_RATE);
    await act(async () => {
      await getStore().addClip(sourceId, song.mix, 'song.wav');
    });
    const [voice2, voice3] = getStore().ensureTracks(['Voice 2', 'Voice 3']);
    const a = await storeVoiceAudio('Harmony +4');
    const b = await storeVoiceAudio('Harmony +7');
    act(() => {
      getStore().applyHarmonyGroup('g1', sourceId, [
        {
          name: 'Original (+0)',
          semitones: 0, gain: 0.9, muted: true, solo: false, vocalsOnly: false,
          offsetSeconds: 0, effects: [], scope: 'entire-song', targetTrackId: sourceId,
        },
        {
          name: 'Harmony +4', semitones: 4, gain: 0.75, muted: false, solo: true,
          vocalsOnly: false, offsetSeconds: 0.1, effects: [],
          scope: 'range', rangeStart: 5, rangeEnd: 25,
          targetTrackId: voice2, clip: { assetId: a.assetId, start: 0.1, duration: 2, size: a.size },
        },
        {
          name: 'Harmony +7', semitones: 7, gain: 0.6, muted: false, solo: false,
          vocalsOnly: true, offsetSeconds: 0, effects: [], scope: 'entire-song',
          targetTrackId: voice3, clip: { assetId: b.assetId, start: 0, duration: 2, size: b.size },
        },
      ]);
    });
    const title = 'Harmony Project';
    await act(async () => {
      await getStore().saveAs(title);
    });
    const projectId = getStore().project.id;

    await act(async () => {
      await getStore().newProject('Other');
    });
    expect(getStore().project.harmonies).toHaveLength(0);

    await act(async () => {
      await getStore().openProject(projectId);
    });
    const reopened = getStore().project;
    expect(reopened.title).toBe(title);
    expect(reopened.tracks.map((t) => t.name)).toEqual(['Voice 1', 'Voice 2', 'Voice 3']);

    const harmonies = reopened.harmonies;
    expect(harmonies).toHaveLength(3);
    const original = harmonies.find((h) => h.originalVoice)!;
    expect(original.muted).toBe(true);
    expect(original.gain).toBeCloseTo(0.9, 5);
    const fourth = harmonies.find((h) => h.semitones === 4)!;
    expect(fourth.gain).toBeCloseTo(0.75, 5);
    expect(fourth.solo).toBe(true);
    expect(fourth.offsetSeconds).toBeCloseTo(0.1, 5);
    expect(fourth.scope).toBe('range');
    expect(fourth.rangeStart).toBe(5);
    expect(fourth.rangeEnd).toBe(25);
    expect(fourth.groupId).toBe('g1');
    const seventh = harmonies.find((h) => h.semitones === 7)!;
    expect(seventh.vocalsOnly).toBe(true);
    expect(seventh.gain).toBeCloseTo(0.6, 5);

    // Track arrangement survives too: the clips are still on Voice 2 / Voice 3.
    const voice2Track = reopened.tracks.find((t) => t.name === 'Voice 2')!;
    const voice3Track = reopened.tracks.find((t) => t.name === 'Voice 3')!;
    expect(voice2Track.clips).toHaveLength(1);
    expect(voice2Track.clips[0].start).toBeCloseTo(0.1, 5);
    expect(voice3Track.clips).toHaveLength(1);
    expect(voice3Track.clips[0].assetId).toBe(b.assetId);
    unmount();
  });
});
