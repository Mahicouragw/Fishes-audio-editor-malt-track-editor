import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useProjectStore, type ProjectStore } from '../store/projectStore';
import { StudioPage } from './StudioPage';
import { loadAudioData } from '../storage/assets';
import { bandPeakAmplitude, bandPeak, buildSong, semitoneRatio } from '../test/songFixture';
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
  it('renders the harmonization panel with every preset and both scope modes', async () => {
    const harness = mountStudio();
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.getByRole('region', { name: 'Harmonization' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Preset A/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Preset B/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Preset C/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Entire Song' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Selected Time Ranges' })).not.toBeChecked();
    harness.unmount();
  }, 60_000);

  it('applies Preset A to the entire song, rendering real audio for every voice', async () => {
    const harness = mountStudio();
    await seedSong(harness.getStore);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Apply harmony' }));
    await waitFor(() => {
      expect(harness.getStore().project.harmonies).toHaveLength(4);
    }, { timeout: 90_000 });

    const project = harness.getStore().project;
    const voices = project.harmonies;
    expect(voices.map((v) => v.semitones).sort((a, b) => a - b)).toEqual([0, 0, 4, 7]);

    // The lead voice reuses the source track's audio; the rest own real clips.
    const lead = voices.find((v) => v.originalVoice)!;
    expect(lead.clipId).toBeUndefined();
    const fourthLayer = voices.find((v) => v.semitones === 4)!;
    const seventhLayer = voices.find((v) => v.semitones === 7)!;
    const fourthTrack = project.tracks.find((t) => t.id === fourthLayer.targetTrackId)!;
    const seventhTrack = project.tracks.find((t) => t.id === seventhLayer.targetTrackId)!;
    expect(fourthTrack.clips).toHaveLength(1);
    expect(seventhTrack.clips).toHaveLength(1);
    expect(fourthTrack.name).not.toBe(seventhTrack.name);

    // Preset volumes are stored exactly.
    expect(fourthLayer.gain).toBeCloseTo(0.3, 5);
    expect(seventhLayer.gain).toBeCloseTo(0.4, 5);
    // Delays are placed inside the song, not appended to it.
    expect(fourthLayer.offsetSeconds).toBeCloseTo(0.023, 5);
    expect(seventhLayer.offsetSeconds).toBeCloseTo(0.049, 5);
    expect(fourthTrack.clips[0].start).toBeCloseTo(0.023, 5);

    const fourthAudio = await loadAudioData(fourthTrack.clips[0].assetId);
    expect(fourthAudio.length / fourthAudio.sampleRate).toBeCloseTo(2, 1);
    const expected = 330 * semitoneRatio(4);
    const shifted = bandPeakAmplitude(fourthAudio.channels[0], SAMPLE_RATE, expected * 0.9, expected * 1.1);
    const original = bandPeakAmplitude(fourthAudio.channels[0], SAMPLE_RATE, 330 * 0.9, 330 * 1.1);
    expect(shifted).toBeGreaterThan(original * 3);
    expect(bandPeak(fourthAudio.channels[0], SAMPLE_RATE, expected * 0.9, expected * 1.1).frequency / expected)
      .toBeCloseTo(1, 2);

    const seventhAudio = await loadAudioData(seventhTrack.clips[0].assetId);
    const seventhExpected = 330 * semitoneRatio(7);
    expect(bandPeak(seventhAudio.channels[0], SAMPLE_RATE, seventhExpected * 0.9, seventhExpected * 1.1).frequency / seventhExpected)
      .toBeCloseTo(1, 2);

    // The library records the processed assets.
    expect(project.media.filter((m) => m.kind === 'processed').length).toBeGreaterThanOrEqual(3);
    harness.unmount();
  }, 180_000);

  it('applies Preset B and honours a per-voice disable', async () => {
    const harness = mountStudio();
    await seedSong(harness.getStore);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Preset B/ }));
    // Turn the fifth off, leaving the lead, the minor third and the double.
    await user.click(screen.getByRole('checkbox', { name: /Enable harmony voice 3/ }));
    await user.click(screen.getByRole('button', { name: 'Apply harmony' }));

    await waitFor(() => {
      expect(harness.getStore().project.harmonies).toHaveLength(3);
    }, { timeout: 90_000 });
    const semis = harness.getStore().project.harmonies.map((h) => h.semitones).sort();
    expect(semis).toEqual([0, 0, 3]);
    harness.unmount();
  }, 180_000);

  it('processes only the listed ranges and leaves every other section untouched', async () => {
    const harness = mountStudio();
    await seedSong(harness.getStore);
    const user = userEvent.setup();

    await user.click(screen.getByRole('radio', { name: 'Selected Time Ranges' }));
    await user.click(screen.getByRole('button', { name: 'Add time range' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Range 1 start in seconds' }), { target: { value: '0.5' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Range 1 end in seconds' }), { target: { value: '1.5' } });
    await user.click(screen.getByRole('button', { name: 'Apply harmony' }));

    await waitFor(() => {
      expect(harness.getStore().project.harmonies).toHaveLength(4);
    }, { timeout: 90_000 });

    const fourthLayer = harness.getStore().project.harmonies.find((h) => h.semitones === 4)!;
    const track = harness.getStore().project.tracks.find((t) => t.id === fourthLayer.targetTrackId)!;
    const rendered = await loadAudioData(track.clips[0].assetId);
    expect(rendered.length / rendered.sampleRate).toBeCloseTo(2, 1);

    // Outside the range the harmony clip is digital silence.
    const outsideStart = Math.round(1.6 * SAMPLE_RATE);
    let outsidePeak = 0;
    for (let i = outsideStart; i < rendered.length; i++) outsidePeak = Math.max(outsidePeak, Math.abs(rendered.channels[0][i]));
    expect(outsidePeak).toBe(0);

    const inside = Math.round(1.0 * SAMPLE_RATE);
    const expected = 330 * semitoneRatio(4);
    const insideShifted = bandPeakAmplitude(
      rendered.channels[0].subarray(inside, inside + Math.round(0.3 * SAMPLE_RATE)),
      SAMPLE_RATE,
      expected * 0.88,
      expected * 1.12,
    );
    expect(insideShifted).toBeGreaterThan(0.005);
    harness.unmount();
  }, 180_000);

  it('rejects a range past the end of the real media and applies nothing', async () => {
    const harness = mountStudio();
    await seedSong(harness.getStore);
    const user = userEvent.setup();

    await user.click(screen.getByRole('radio', { name: 'Selected Time Ranges' }));
    await user.click(screen.getByRole('button', { name: 'Add time range' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Range 1 start in seconds' }), { target: { value: '1.5' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Range 1 end in seconds' }), { target: { value: '25' } });
    await waitFor(() => {
      expect(screen.getAllByRole('alert').map((n) => n.textContent).join(' ')).toMatch(/beyond the media duration/i);
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
      expect(harness.getStore().project.harmonies).toHaveLength(4);
    }, { timeout: 90_000 });

    const fourth = harness.getStore().project.harmonies.find((h) => h.semitones === 4)!;
    act(() => {
      harness.getStore().updateHarmony(fourth.id, { gain: 0.55, muted: true, pan: -0.6 });
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
    expect(reopened.harmonies).toHaveLength(4);
    const reopenedFourth = reopened.harmonies.find((h) => h.semitones === 4)!;
    expect(reopenedFourth.gain).toBeCloseTo(0.55, 5);
    expect(reopenedFourth.muted).toBe(true);
    expect(reopenedFourth.pan).toBeCloseTo(-0.6, 5);
    expect(reopened.tracks.find((t) => t.id === reopenedFourth.targetTrackId)?.clips).toHaveLength(1);
    harness.unmount();
  }, 180_000);
});
