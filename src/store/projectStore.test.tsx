import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useProjectStore, type ProjectStore } from './projectStore';
import { audioData, mergeAudio } from '../audio/dsp';
import type { AudioData } from '../types';
import * as db from '../storage/db';

function toneWithSilence(): AudioData {
  const sr = 22050;
  const tone = audioData([new Float32Array(Array.from({ length: Math.round(sr * 0.4) }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / sr) * 0.5))], sr);
  const silence = audioData([new Float32Array(Math.round(sr * 0.5))], sr);
  return mergeAudio([tone, silence, tone], sr, { gapSeconds: 0, overlapSeconds: 0, mode: 'sequential' });
}

async function freshStore(): Promise<{ getStore: () => ProjectStore; unmount: () => void }> {
  await db.clearAll();
  const { result, unmount } = renderHook(() => useProjectStore());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  return { getStore: () => result.current, unmount };
}

beforeEach(async () => {
  await db.clearAll();
});

describe('project store', () => {
  it('adds clips to the selected track only (selection isolation)', async () => {
    const { getStore, unmount } = await freshStore();
    const [v1, v2] = getStore().project.tracks;
    const data = toneWithSilence();
    await act(async () => {
      await getStore().addClip(v2.id, data, 'Voice 2 take');
    });
    expect(getStore().project.tracks.find((t) => t.id === v2.id)?.clips).toHaveLength(1);
    expect(getStore().project.tracks.find((t) => t.id === v1.id)?.clips).toHaveLength(0);
    const clipId = getStore().project.tracks.find((t) => t.id === v2.id)!.clips[0].id;
    // Editing the Voice 2 clip must never touch Voice 1
    act(() => {
      getStore().updateClip(clipId, { gain: 0.5, start: 2 });
    });
    expect(getStore().project.tracks.find((t) => t.id === v1.id)?.clips).toHaveLength(0);
    expect(getStore().project.tracks.find((t) => t.id === v2.id)!.clips[0].gain).toBe(0.5);
    unmount();
  });

  it('undo/redo record exactly one history entry per change', async () => {
    const { getStore, unmount } = await freshStore();
    expect(getStore().canUndo).toBe(false);
    const trackId = getStore().project.tracks[0].id;
    act(() => {
      getStore().setTrackPitch(trackId, 4);
    });
    expect(getStore().canUndo).toBe(true);
    act(() => getStore().undo());
    expect(getStore().project.tracks[0].pitchSemis).toBe(0);
    expect(getStore().canRedo).toBe(true);
    act(() => getStore().redo());
    expect(getStore().project.tracks[0].pitchSemis).toBe(4);
    // Track selection is a view change, not an undo step
    const secondTrackId = getStore().project.tracks[1].id;
    act(() => getStore().selectTrack(secondTrackId));
    act(() => getStore().undo());
    expect(getStore().project.tracks[0].pitchSemis).toBe(0);
    expect(getStore().project.selectedTrackId).toBe(secondTrackId);
    unmount();
  });

  it('save and reopen restore the editable state', async () => {
    const { getStore, unmount } = await freshStore();
    const trackId = getStore().project.tracks[0].id;
    await act(async () => {
      await getStore().addClip(trackId, toneWithSilence(), 'song.wav');
    });
    act(() => {
      getStore().setTrackPitch(trackId, 3);
      getStore().setTrackVolume(trackId, 0.7);
      getStore().setSelection({ start: 1, end: 2 });
    });
    const title = 'My Project';
    await act(async () => {
      await getStore().saveAs(title);
    });
    // Save As assigns a new project identity
    const projectId = getStore().project.id;
    await act(async () => {
      await getStore().newProject('Other');
    });
    expect(getStore().project.title).toBe('Other');
    await act(async () => {
      await getStore().openProject(projectId);
    });
    expect(getStore().project.title).toBe(title);
    expect(getStore().project.tracks[0].clips).toHaveLength(1);
    expect(getStore().project.tracks[0].pitchSemis).toBe(3);
    expect(getStore().project.tracks[0].volume).toBe(0.7);
    expect(getStore().project.selection).toEqual({ start: 1, end: 2 });
    unmount();
  });

  it('renameProject renames in the library, duplicateProject copies the project', async () => {
    const { getStore, unmount } = await freshStore();
    const trackId = getStore().project.tracks[0].id;
    await act(async () => {
      await getStore().addClip(trackId, toneWithSilence(), 'song.wav');
      await getStore().save();
    });
    const id = getStore().project.id;
    await act(async () => {
      await getStore().renameProject(id, 'Renamed Song');
    });
    expect(getStore().projects.find((p) => p.id === id)?.title).toBe('Renamed Song');
    expect(getStore().project.title).toBe('Renamed Song');
    await act(async () => {
      await getStore().duplicateProject(id);
    });
    expect(getStore().projects).toHaveLength(2);
    const copy = getStore().projects.find((p) => p.id !== id)!;
    expect(copy.title).toBe('Renamed Song copy');
    expect(copy.tracks[0].clips).toHaveLength(1);
    unmount();
  });

  it('harmony layers are managed independently (mute/gain/remove/duplicate)', async () => {
    const { getStore, unmount } = await freshStore();
    const [v1, v2] = getStore().project.tracks;
    const data = toneWithSilence();
    const shifted = audioData(data.channels.map((c) => new Float32Array(c)), data.sampleRate);
    let harmonyId = '';
    await act(async () => {
      harmonyId = await getStore().addHarmony(v1.id, v2.id, 7, shifted);
    });
    expect(getStore().project.harmonies).toHaveLength(1);
    expect(getStore().project.harmonies[0].clipId).toBeTruthy();
    expect(getStore().project.tracks.find((t) => t.id === v2.id)?.clips).toHaveLength(1);

    act(() => {
      getStore().updateHarmony(harmonyId, { muted: true, gain: 0.5 });
    });
    expect(getStore().project.harmonies[0].muted).toBe(true);
    expect(getStore().project.harmonies[0].gain).toBe(0.5);

    await act(async () => {
      await getStore().duplicateHarmony(harmonyId);
    });
    expect(getStore().project.harmonies).toHaveLength(2);
    expect(getStore().project.tracks.find((t) => t.id === v2.id)?.clips).toHaveLength(2);

    act(() => {
      getStore().removeHarmony(harmonyId);
    });
    expect(getStore().project.harmonies).toHaveLength(1);
    expect(getStore().project.tracks.find((t) => t.id === v2.id)?.clips).toHaveLength(1);
    unmount();
  });

  it('recordings are tracked as takes and deleted with their clip', async () => {
    const { getStore, unmount } = await freshStore();
    const trackId = getStore().project.tracks[0].id;
    await act(async () => {
      await getStore().importAudioData(toneWithSilence(), 'Take 1', trackId, 0, { recording: true });
    });
    expect(getStore().project.recordings).toHaveLength(1);
    expect(getStore().project.recordings[0].trackId).toBe(trackId);
    expect(getStore().project.recordings[0].start).toBe(0);
    const clipId = getStore().project.tracks[0].clips[0].id;
    act(() => {
      getStore().deleteClip(clipId);
    });
    expect(getStore().project.recordings).toHaveLength(0);
    expect(getStore().project.tracks[0].clips).toHaveLength(0);
    unmount();
  });

  it('deleteTrack removes dependent harmony layers and clips', async () => {
    const { getStore, unmount } = await freshStore();
    const [v1, v2] = getStore().project.tracks;
    const data = toneWithSilence();
    const shifted = audioData(data.channels.map((c) => new Float32Array(c)), data.sampleRate);
    await act(async () => {
      await getStore().addHarmony(v1.id, v2.id, 4, shifted);
    });
    act(() => {
      getStore().deleteTrack(v1.id);
    });
    expect(getStore().project.tracks).toHaveLength(1);
    expect(getStore().project.harmonies).toHaveLength(0);
    expect(getStore().project.tracks[0].clips).toHaveLength(0);
    unmount();
  });
});
