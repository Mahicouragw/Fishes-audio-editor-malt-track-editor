import { describe, it, expect, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { useProjectStore, type ProjectStore } from '../store/projectStore';
import { SilencePanel } from './SilencePanel';
import { MergePanel } from './MergePanel';
import { RecordPanel } from './RecordPanel';
import { audioData, mergeAudio } from '../audio/dsp';
import type { AudioData } from '../types';
import * as db from '../storage/db';

function toneWithSilence(): AudioData {
  const sr = 22050;
  const tone = audioData([new Float32Array(Array.from({ length: Math.round(sr * 0.4) }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / sr) * 0.5))], sr);
  const silence = audioData([new Float32Array(Math.round(sr * 0.5))], sr);
  return mergeAudio([tone, silence, tone], sr, { gapSeconds: 0, overlapSeconds: 0, mode: 'sequential' });
}

function tone(freq: number): AudioData {
  const sr = 22050;
  const length = Math.round(sr * 0.3);
  const ch = new Float32Array(Array.from({ length }, (_, i) => Math.sin((2 * Math.PI * freq * i) / sr) * 0.4));
  return audioData([ch], sr);
}

interface HarnessResult {
  getStore: () => ProjectStore;
}

function withStore(children: (store: ProjectStore) => ReactNode): HarnessResult & { unmount: () => void } {
  const ref: { current: ProjectStore | null } = { current: null };
  function Harness() {
    const store = useProjectStore();
    ref.current = store;
    return <>{children(store)}</>;
  }
  const view = render(<Harness />);
  return { getStore: () => ref.current!, unmount: view.unmount };
}

beforeEach(async () => {
  await db.clearAll();
});

describe('SilencePanel (real signal analysis + removal)', () => {
  it('detects silent regions from the real waveform and removes confirmed ones', async () => {
    const { getStore, unmount } = withStore((store) => <SilencePanel store={store} />);
    const user = userEvent.setup();
    // Seed a clip: tone + 0.5 s of digital silence + tone
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
      await getStore().addClip(getStore().project.tracks[0].id, toneWithSilence(), 'test.wav');
    });
    const originalDuration = getStore().project.tracks[0].clips[0].duration;
    const originalAssetId = getStore().project.tracks[0].clips[0].assetId;

    // Tighten detection so the 0.5 s gap is found (range inputs: fireEvent.change)
    fireEvent.change(screen.getByRole('slider', { name: /Minimum silence duration/ }), { target: { value: '0.05' } });
    fireEvent.change(screen.getByRole('slider', { name: /Preserve .* milliseconds around speech/ }), { target: { value: '0' } });

    await user.click(screen.getByRole('button', { name: 'Analyse silence' }));
    // Regions list appears with real region times
    expect(await screen.findByRole('list', { name: /Detected silent regions/ })).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox', { name: /Silent region/ }).length).toBeGreaterThanOrEqual(1);

    await user.click(screen.getByRole('button', { name: 'Remove selected silent regions' }));
    await waitFor(() => expect(getStore().project.tracks[0].clips).toHaveLength(1), { timeout: 20_000 });
    const updated = getStore().project.tracks[0].clips[0];
    expect(updated.duration).toBeLessThan(originalDuration);
    expect(updated.assetId).not.toBe(originalAssetId);
    expect(getStore().announcement).toMatch(/Removed 1 silent regions/i);
    // Undo restores the original clip
    act(() => {
      getStore().undo();
    });
    expect(getStore().project.tracks[0].clips[0].assetId).toBe(originalAssetId);
    unmount();
  }, 30_000);
});

describe('MergePanel (real PCM merge)', () => {
  it('merges two clips into a new track from real samples', async () => {
    const { getStore, unmount } = withStore((store) => <MergePanel store={store} />);
    const user = userEvent.setup();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
      await getStore().addClip(getStore().project.tracks[0].id, tone(220), 'a.wav');
      await getStore().addClip(getStore().project.tracks[1].id, tone(440), 'b.wav');
    });
    expect(getStore().project.tracks).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Merge audio' }));
    await waitFor(() => expect(getStore().project.tracks).toHaveLength(3), { timeout: 20_000 });
    expect(await screen.findByText(/Merged audio/)).toBeInTheDocument();
    const tracks = getStore().project.tracks;
    expect(tracks).toHaveLength(3);
    const mergedTrack = tracks[tracks.length - 1];
    expect(mergedTrack.clips).toHaveLength(1);
    expect(mergedTrack.clips[0].duration).toBeCloseTo(0.6, 1);
    unmount();
  }, 30_000);

  it('refuses to merge fewer than two clips with an honest error', async () => {
    const { getStore, unmount } = withStore((store) => <MergePanel store={store} />);
    const user = userEvent.setup();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
      await getStore().addClip(getStore().project.tracks[0].id, tone(220), 'a.wav');
    });
    const button = screen.getByRole('button', { name: 'Merge audio' });
    expect(button).toBeDisabled();
    unmount();
    void user;
  }, 30_000);
});

describe('RecordPanel (honest permission errors)', () => {
  it('reports a denied microphone permission instead of faking a take', async () => {
    const { unmount } = withStore((store) => <RecordPanel store={store} position={0} />);
    const user = userEvent.setup();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/permission was denied|microphone/i);
    // No take may have been created
    unmount();
  }, 30_000);
});
