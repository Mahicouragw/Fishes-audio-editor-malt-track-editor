import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { normalizeProject, useProjectStore, type ProjectStore } from './projectStore';
import { audioData } from '../audio/dsp';
import { storeAudioData, cacheAudioData } from '../storage/assets';
import * as db from '../storage/db';
import { defaultVocalState, type Project } from '../types';

const SR = 22050;

async function freshStore(): Promise<{ getStore: () => ProjectStore; unmount: () => void }> {
  await db.clearAll();
  const { result, unmount } = renderHook(() => useProjectStore());
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return { getStore: () => result.current, unmount };
}

async function voiceAudio(): Promise<string> {
  const data = audioData([new Float32Array(SR).map((_, i) => 0.1 * Math.sin((2 * Math.PI * 440 * i) / SR))], SR);
  const asset = await storeAudioData(data, 'Harmony', 'processed');
  cacheAudioData(asset.id, data);
  return asset.id;
}

describe('track pan, duplicate lead and undo', () => {
  it('sets a real track pan and can undo and redo it repeatedly', async () => {
    const { getStore, unmount } = await freshStore();
    const trackId = getStore().project.tracks[0].id;
    act(() => getStore().setTrackPan(trackId, -1));
    expect(getStore().project.tracks[0].pan).toBe(-1);
    act(() => getStore().undo());
    expect(getStore().project.tracks[0].pan).toBe(0);
    act(() => getStore().redo());
    expect(getStore().project.tracks[0].pan).toBe(-1);
    act(() => getStore().setTrackPan(trackId, 0.5));
    expect(getStore().project.tracks[0].pan).toBe(0.5);
    act(() => getStore().undo());
    expect(getStore().project.tracks[0].pan).toBe(-1);
    act(() => getStore().undo());
    expect(getStore().project.tracks[0].pan).toBe(0);
    unmount();
  });

  it('coalesces a slider drag into one undo step but keeps separate edits apart', async () => {
    const { getStore, unmount } = await freshStore();
    const trackId = getStore().project.tracks[0].id;
    act(() => getStore().setTrackVolume(trackId, 0.9));
    act(() => getStore().setTrackVolume(trackId, 0.7));
    act(() => getStore().setTrackVolume(trackId, 0.5));
    expect(getStore().project.tracks[0].volume).toBeCloseTo(0.5, 5);
    act(() => getStore().undo());
    expect(getStore().project.tracks[0].volume).toBe(1);
    act(() => getStore().redo());
    expect(getStore().project.tracks[0].volume).toBeCloseTo(0.5, 5);
    unmount();
  });

  it('coalesces pan drags per track and per control', async () => {
    const { getStore, unmount } = await freshStore();
    const trackId = getStore().project.tracks[0].id;
    act(() => getStore().setTrackPan(trackId, -0.2));
    act(() => getStore().setTrackPan(trackId, -0.4));
    act(() => getStore().setTrackPan(trackId, -0.6));
    act(() => getStore().setTrackVolume(trackId, 0.3));
    expect(getStore().project.tracks[0].pan).toBeCloseTo(-0.6, 5);
    act(() => getStore().undo());
    expect(getStore().project.tracks[0].volume).toBe(1);
    act(() => getStore().undo());
    expect(getStore().project.tracks[0].pan).toBe(0);
    unmount();
  });

  it('duplicates the lead without pitch or effects', async () => {
    const { getStore, unmount } = await freshStore();
    const assetId = await voiceAudio();
    const sourceId = getStore().project.tracks[0].id;
    await act(async () => {
      await getStore().addClip(sourceId, audioData([new Float32Array(SR)], SR), 'lead.wav');
    });
    act(() => getStore().setTrackPitch(sourceId, 4, 20));
    const source = getStore().project.tracks[0];
    const clip = source.clips[0];
    act(() => {
      getStore().updateProject((p) => {
        const t = p.tracks.find((x) => x.id === sourceId)!;
        t.clips[0].effects = [{ id: 'fx', type: 'reverb', start: 0, end: 1, params: { reverbSeconds: 1, reverbMix: 0.3 }, enabled: true }];
        return p;
      });
    });
    act(() => getStore().duplicateOriginalTrack(sourceId));
    const tracks = getStore().project.tracks;
    expect(tracks).toHaveLength(3);
    const duplicate = tracks.find((t) => t.name.endsWith('double'))!;
    expect(duplicate.pitchSemis).toBe(0);
    expect(duplicate.pitchFineCents).toBe(0);
    expect(duplicate.clips[0].assetId).toBe(clip.assetId);
    expect(duplicate.clips[0].effects).toHaveLength(0);
    expect(duplicate.clips[0].sourceStart).toBe(clip.sourceStart);
    expect(duplicate.clips[0].duration).toBe(clip.duration);
    expect(duplicate.id).not.toBe(source.id);
    // It is a real track, not a reference to the original's processing.
    expect(duplicate.vocal.enabled).toBe(false);
    void assetId;
    unmount();
  });

  it('keeps pan, key, scale and ranges through save and reopen', async () => {
    const { getStore, unmount } = await freshStore();
    const trackId = getStore().project.tracks[0].id;
    act(() => {
      getStore().setTrackPan(trackId, 0.35);
      getStore().setHarmonyKey('D');
      getStore().setHarmonyScale('minor');
      getStore().addHarmonyRange({ start: 1, end: 2, enabled: true });
      getStore().addHarmonyRange({ start: 5, end: 7, enabled: true });
    });
    await act(async () => { await getStore().saveAs('Pan Saved'); });
    const projectId = getStore().project.id;
    await act(async () => { await getStore().newProject('Reset'); });
    await act(async () => { await getStore().openProject(projectId); });
    const reopened = getStore().project;
    expect(reopened.tracks[0].pan).toBeCloseTo(0.35, 5);
    expect(reopened.harmonyKey).toBe('D');
    expect(reopened.harmonyScale).toBe('minor');
    expect(reopened.harmonyRanges.map((r) => [r.start, r.end])).toEqual([[1, 2], [5, 7]]);
    unmount();
  });

  it('normalises older projects that have no pan, key or ranges', () => {
    const legacy = {
      id: 'p',
      title: 'Legacy',
      createdAt: 0,
      updatedAt: 0,
      tracks: [{ ...defaultVocalState(), id: 't', name: 'Voice 1', volume: 1, muted: false, solo: false, pitchSemis: 0, pitchFineCents: 0, clips: [] }],
      harmonies: [],
      media: [],
      selection: { start: 0, end: 0 },
      settings: {},
    } as unknown as Project;
    const normalized = normalizeProject(legacy);
    expect(normalized.tracks[0].pan).toBe(0);
    expect(normalized.harmonyKey).toBe('C');
    expect(normalized.harmonyScale).toBe('major');
    expect(normalized.harmonyRanges).toEqual([]);
  });
});

describe('history survives save and reopen', () => {
  it('restores the undo and redo stacks with the project', async () => {
    const { getStore, unmount } = await freshStore();
    const trackId = getStore().project.tracks[0].id;
    act(() => getStore().setTrackPan(trackId, -0.75));
    act(() => getStore().setHarmonyKey('E'));
    expect(getStore().canUndo).toBe(true);
    const savedId = await (async () => {
      await act(async () => { await getStore().saveAs('With history'); });
      return getStore().project.id;
    })();
    await act(async () => { await getStore().newProject('Empty'); });
    expect(getStore().canUndo).toBe(false);
    await act(async () => { await getStore().openProject(savedId); });
    expect(getStore().canUndo).toBe(true);
    expect(getStore().project.harmonyKey).toBe('E');
    // Undo the key change, then the pan change, in the correct order.
    act(() => getStore().undo());
    expect(getStore().project.harmonyKey).toBe('C');
    expect(getStore().project.tracks[0].pan).toBeCloseTo(-0.75, 5);
    expect(getStore().canRedo).toBe(true);
    act(() => getStore().undo());
    expect(getStore().project.tracks[0].pan).toBe(0);
    act(() => getStore().redo());
    act(() => getStore().redo());
    expect(getStore().project.harmonyKey).toBe('E');
    expect(getStore().project.tracks[0].pan).toBeCloseTo(-0.75, 5);
    unmount();
  });
});
