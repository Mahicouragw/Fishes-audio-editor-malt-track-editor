import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useProjectStore, type ProjectStore } from '../store/projectStore';
import { StudioPage } from './StudioPage';
import { loadAudioData } from '../storage/assets';
import { bandPeakAmplitude, buildSong, semitoneRatio } from '../test/songFixture';
import * as db from '../storage/db';

const SAMPLE_RATE = 22050;

interface Harness {
  getStore: () => ProjectStore;
  unmount: () => void;
}

function mountStudio(): Harness {
  const ref: { current: ProjectStore | null } = { current: null };
  function Harness() {
    const store = useProjectStore();
    ref.current = store;
    return <StudioPage store={store} />;
  }
  const view = render(<Harness />);
  return { getStore: () => ref.current!, unmount: view.unmount };
}

beforeEach(async () => {
  await db.clearAll();
});

afterEach(() => {
  cleanup();
});

async function seedSong(getStore: () => ProjectStore): Promise<string> {
  const song = buildSong(2, SAMPLE_RATE, 330, 0);
  let trackId = '';
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
    trackId = getStore().project.tracks[0].id;
    await getStore().addClip(trackId, song.mix, 'song.wav');
  });
  return trackId;
}

describe('Studio harmonization wiring', () => {
  it('renders the harmonization panel with both presets and scope modes', async () => {
    const { unmount } = mountStudio();
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.getByRole('region', { name: 'Harmonization' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Harmony Preset A (0, +4, +7)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Harmony Preset B (0, +3, +7)' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Entire Song' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Selected Time Range' })).not.toBeChecked();
    unmount();
  }, 60_000);

  it('applies Preset A to the entire song, rendering real audio on Voice 2 / Voice 3', async () => {
    const harness = mountStudio();
    const sourceId = await seedSong(harness.getStore);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Apply harmony' }));

    await waitFor(() => {
      expect(harness.getStore().project.harmonies).toHaveLength(3);
    }, { timeout: 60_000 });

    const project = harness.getStore().project;
    // Voice 3 was created on demand for the third voice.
    expect(project.tracks.map((t) => t.name)).toEqual(['Voice 1', 'Voice 2', 'Voice 3']);

    const voices = [...project.harmonies].sort((a, b) => a.semitones - b.semitones);
    expect(voices.map((v) => v.semitones)).toEqual([0, 4, 7]);
    // The +0 voice is the original: it reuses the source audio.
    expect(voices[0].originalVoice).toBe(true);
    expect(voices[0].clipId).toBeUndefined();
    expect(project.tracks.find((t) => t.name === 'Voice 1')?.clips).toHaveLength(1);

    // The other two voices own real rendered clips on their own tracks.
    const voice2 = project.tracks.find((t) => t.name === 'Voice 2')!;
    const voice3 = project.tracks.find((t) => t.name === 'Voice 3')!;
    expect(voice2.clips).toHaveLength(1);
    expect(voice3.clips).toHaveLength(1);

    // The rendered clip really holds shifted audio.
    const fourthAudio = await loadAudioData(voice2.clips[0].assetId);
    expect(fourthAudio.length / fourthAudio.sampleRate).toBeCloseTo(2, 1);
    const fourthExpected = 330 * semitoneRatio(4);
    const fourth = bandPeakAmplitude(fourthAudio.channels[0], SAMPLE_RATE, fourthExpected * 0.9, fourthExpected * 1.1);
    const fourthOriginal = bandPeakAmplitude(fourthAudio.channels[0], SAMPLE_RATE, 330 * 0.9, 330 * 1.1);
    expect(fourth).toBeGreaterThan(fourthOriginal * 5);

    const seventhAudio = await loadAudioData(voice3.clips[0].assetId);
    const seventhExpected = 330 * semitoneRatio(7);
    const seventh = bandPeakAmplitude(seventhAudio.channels[0], SAMPLE_RATE, seventhExpected * 0.9, seventhExpected * 1.1);
    expect(seventh).toBeGreaterThan(fourthOriginal * 5);

    // The library records the processed assets.
    expect(project.media.filter((m) => m.kind === 'processed').length).toBeGreaterThanOrEqual(2);
    void sourceId;
    harness.unmount();
  }, 120_000);

  it('applies Preset B and honours a per-voice disable', async () => {
    const harness = mountStudio();
    await seedSong(harness.getStore);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Harmony Preset B (0, +3, +7)' }));
    // Turn the fifth off, leaving the original and the minor third.
    await user.click(screen.getByRole('checkbox', { name: 'Enable harmony voice Perfect fifth (+7)' }));
    await user.click(screen.getByRole('button', { name: 'Apply harmony' }));

    await waitFor(() => {
      expect(harness.getStore().project.harmonies).toHaveLength(2);
    }, { timeout: 60_000 });
    expect(harness.getStore().project.harmonies.map((h) => h.semitones).sort()).toEqual([0, 3]);
    harness.unmount();
  }, 120_000);

  it('processes only the selected range, keeping the rest of the song intact', async () => {
    const harness = mountStudio();
    await seedSong(harness.getStore);
    const user = userEvent.setup();

    await user.click(screen.getByRole('radio', { name: 'Selected Time Range' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Harmonization range start in seconds' }), { target: { value: '0.5' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Harmonization range end in seconds' }), { target: { value: '1.5' } });
    await user.click(screen.getByRole('button', { name: 'Apply harmony' }));

    await waitFor(() => {
      expect(harness.getStore().project.harmonies).toHaveLength(3);
    }, { timeout: 60_000 });

    const voice2 = harness.getStore().project.tracks.find((t) => t.name === 'Voice 2')!;
    const rendered = await loadAudioData(voice2.clips[0].assetId);
    expect(rendered.length / rendered.sampleRate).toBeCloseTo(2, 1);

    const outside = Math.round(1.8 * SAMPLE_RATE);
    const inside = Math.round(1.0 * SAMPLE_RATE);
    // Outside the range the harmony clip is digital silence: the range was
    // really restricted, not just flagged in the UI.
    let outsidePeak = 0;
    for (let i = outside; i < rendered.length; i++) outsidePeak = Math.max(outsidePeak, Math.abs(rendered.channels[0][i]));
    expect(outsidePeak).toBe(0);

    const shiftedExpected = 330 * semitoneRatio(4);
    const insideShifted = bandPeakAmplitude(
      rendered.channels[0].subarray(inside, inside + Math.round(0.4 * SAMPLE_RATE)),
      SAMPLE_RATE,
      shiftedExpected * 0.88,
      shiftedExpected * 1.12,
    );
    expect(insideShifted).toBeGreaterThan(0.01);
    harness.unmount();
  }, 120_000);

  it('rejects a range past the end of the real media and applies nothing', async () => {
    const harness = mountStudio();
    await seedSong(harness.getStore);
    const user = userEvent.setup();

    // The seeded song is 2 s long; 25 s is out of range.
    await user.click(screen.getByRole('radio', { name: 'Selected Time Range' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/beyond the media duration/i);
    }, { timeout: 10_000 });
    await user.click(screen.getByRole('button', { name: 'Apply harmony' }));

    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(harness.getStore().project.harmonies).toHaveLength(0);
    harness.unmount();
  }, 60_000);

  it('cancel applies nothing, and the applied voices survive a save and reopen', async () => {
    const harness = mountStudio();
    await seedSong(harness.getStore);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Cancel harmony' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(harness.getStore().project.harmonies).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Apply harmony' }));
    await waitFor(() => {
      expect(harness.getStore().project.harmonies).toHaveLength(3);
    }, { timeout: 60_000 });

    // Adjust one voice, then save and reopen.
    const fourth = harness.getStore().project.harmonies.find((h) => h.semitones === 4)!;
    act(() => {
      harness.getStore().updateHarmony(fourth.id, { gain: 0.55, muted: true });
    });
    await act(async () => {
      await harness.getStore().saveAs('Harmony Saved');
    });
    const projectId = harness.getStore().project.id;
    await act(async () => {
      await harness.getStore().newProject('Scratch');
    });
    await act(async () => {
      await harness.getStore().openProject(projectId);
    });
    const reopened = harness.getStore().project;
    expect(reopened.harmonies).toHaveLength(3);
    const reopenedFourth = reopened.harmonies.find((h) => h.semitones === 4)!;
    expect(reopenedFourth.gain).toBeCloseTo(0.55, 5);
    expect(reopenedFourth.muted).toBe(true);
    expect(reopened.tracks.find((t) => t.name === 'Voice 2')?.clips).toHaveLength(1);
    harness.unmount();
  }, 120_000);
});
