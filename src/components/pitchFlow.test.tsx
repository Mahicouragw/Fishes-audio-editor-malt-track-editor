import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useProjectStore, type ProjectStore } from '../store/projectStore';
import { StudioPage } from './StudioPage';
import { loadAudioData } from '../storage/assets';
import { bandPeak, buildSong, semitoneRatio } from '../test/songFixture';
import * as db from '../storage/db';

const SAMPLE_RATE = 22050;
const VOCAL = 330;

let ref: { current: ProjectStore | null } = { current: null };

function mount() {
  function Harness() {
    const store = useProjectStore();
    ref.current = store;
    return <StudioPage store={store} />;
  }
  return render(<Harness />);
}

async function seedAndApplyPreset() {
  const view = mount();
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  const store = ref.current!;
  const song = buildSong(2, SAMPLE_RATE, VOCAL, 0);
  await act(async () => { await store.addClip(store.project.tracks[0].id, song.mix, 'song.wav'); });
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Apply harmony' }));
  await waitFor(() => expect(ref.current!.project.harmonies).toHaveLength(4), { timeout: 120_000 });
  return { view, user };
}

/** The dominant partial inside ±6 % of a target frequency. */
function levelAt(signal: Float32Array, hz: number): number {
  return bandPeak(signal, SAMPLE_RATE, hz * 0.94, hz * 1.06).amplitude;
}

beforeEach(async () => { await db.clearAll(); });
afterEach(() => { cleanup(); });

describe('pitch shifting through the studio', () => {
  it('renders the +4 and +7 voices at their real intervals', async () => {
    const { view } = await seedAndApplyPreset();
    const store = ref.current!;
    for (const semis of [4, 7]) {
      const layer = store.project.harmonies.find((h) => h.semitones === semis)!;
      const track = store.project.tracks.find((t) => t.id === layer.targetTrackId)!;
      const data = await loadAudioData(track.clips[0].assetId);
      const expected = VOCAL * semitoneRatio(semis);
      const shifted = levelAt(data.channels[0], expected);
      const unshifted = levelAt(data.channels[0], VOCAL);
      expect(shifted).toBeGreaterThan(unshifted * 3);
      expect(bandPeak(data.channels[0], SAMPLE_RATE, expected * 0.9, expected * 1.1).frequency / expected)
        .toBeCloseTo(1, 2);
    }
    view.unmount();
  }, 180_000);

  it('can duplicate the original +0 voice into a real, pitchable copy', async () => {
    const { view, user } = await seedAndApplyPreset();
    const before = ref.current!.project.harmonies.length;
    const lead = ref.current!.project.harmonies.find((h) => h.originalVoice)!;
    expect(lead.clipId).toBeUndefined();

    const index = ref.current!.project.harmonies.findIndex((h) => h.id === lead.id);
    await user.click(screen.getByRole('button', { name: new RegExp(`Duplicate harmony voice ${index + 1}`) }));
    await waitFor(() => expect(ref.current!.project.harmonies).toHaveLength(before + 1), { timeout: 60_000 });

    const copy = ref.current!.project.harmonies.find((h) => h.id !== lead.id && h.name.includes('copy'))!;
    expect(copy, 'the duplicate must exist').toBeTruthy();
    // The copy owns real audio on a track of its own, so it can be re-pitched.
    expect(copy.clipId).toBeTruthy();
    expect(copy.originalVoice).toBe(false);
    const track = ref.current!.project.tracks.find((t) => t.id === copy.targetTrackId)!;
    expect(track.id).not.toBe(lead.sourceTrackId);
    expect(track.clips.some((c) => c.id === copy.clipId)).toBe(true);
    // Nothing failed silently on screen.
    expect(screen.queryByRole('alert')).toBeNull();
    view.unmount();
  }, 120_000);

  it('pitches a duplicated lead to +12 and stores octave audio', async () => {
    const { view, user } = await seedAndApplyPreset();
    const lead = ref.current!.project.harmonies.find((h) => h.originalVoice)!;
    const leadIndex = ref.current!.project.harmonies.findIndex((h) => h.id === lead.id);
    await user.click(screen.getByRole('button', { name: new RegExp(`Duplicate harmony voice ${leadIndex + 1}`) }));
    await waitFor(() => expect(ref.current!.project.harmonies).toHaveLength(5), { timeout: 60_000 });

    const copy = ref.current!.project.harmonies.find((h) => h.name.includes('copy'))!;
    const copyIndex = ref.current!.project.harmonies.findIndex((h) => h.id === copy.id);
    const input = screen.getByRole('spinbutton', { name: `Applied voice ${copyIndex + 1} semitones` });
    await user.clear(input);
    await user.type(input, '12');
    await user.click(screen.getByRole('button', { name: new RegExp(`Update harmony voice ${copyIndex + 1}`) }));
    await waitFor(() => {
      expect(ref.current!.project.harmonies.find((h) => h.id === copy.id)!.semitones).toBe(12);
    }, { timeout: 120_000 });
    await new Promise((r) => setTimeout(r, 500));

    const updated = ref.current!.project.harmonies.find((h) => h.id === copy.id)!;
    const track = ref.current!.project.tracks.find((t) => t.id === updated.targetTrackId)!;
    const data = await loadAudioData(track.clips[0].assetId);
    const octave = levelAt(data.channels[0], VOCAL * 2);
    const original = levelAt(data.channels[0], VOCAL);
    expect(octave).toBeGreaterThan(original * 3);
    view.unmount();
  }, 240_000);

  it('pitches the untouched +0 lead itself, instead of only relabelling it', async () => {
    // Regression: `replaceHarmonyClip` found no clip for the lead, returned the
    // project untouched, and `updateHarmony` still wrote "+12" — the panel said
    // the voice had moved while the audio had not changed at all.
    const { view, user } = await seedAndApplyPreset();
    const lead = ref.current!.project.harmonies.find((h) => h.originalVoice)!;
    const index = ref.current!.project.harmonies.findIndex((h) => h.id === lead.id);
    const sourceTrack = ref.current!.project.tracks.find((t) => t.id === lead.sourceTrackId)!;
    const sourceAsset = sourceTrack.clips[0].assetId;

    const input = screen.getByRole('spinbutton', { name: `Applied voice ${index + 1} semitones` });
    await user.clear(input);
    await user.type(input, '12');
    await user.click(screen.getByRole('button', { name: new RegExp(`Update harmony voice ${index + 1}`) }));
    await waitFor(() => {
      expect(ref.current!.project.harmonies.find((h) => h.id === lead.id)!.semitones).toBe(12);
    }, { timeout: 120_000 });
    await new Promise((r) => setTimeout(r, 500));

    const updated = ref.current!.project.harmonies.find((h) => h.id === lead.id)!;
    expect(updated.clipId, 'the re-pitched lead must own a clip').toBeTruthy();
    const track = ref.current!.project.tracks.find((t) => t.id === updated.targetTrackId)!;
    expect(track.id).not.toBe(lead.sourceTrackId);
    const clip = track.clips.find((c) => c.id === updated.clipId)!;
    const data = await loadAudioData(clip.assetId);
    expect(levelAt(data.channels[0], VOCAL * 2)).toBeGreaterThan(levelAt(data.channels[0], VOCAL) * 3);
    // The source track itself is never rewritten.
    expect(ref.current!.project.tracks.find((t) => t.id === lead.sourceTrackId)!.clips[0].assetId).toBe(sourceAsset);
    view.unmount();
  }, 240_000);
});

describe('vocal pitch with Human Voice Processing', () => {
  it('moves the spoken/sung pitch in the audio that playback prepares', async () => {
    const view = mount();
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    const store = ref.current!;
    const song = buildSong(2, SAMPLE_RATE, VOCAL, 0);
    let trackId = '';
    await act(async () => {
      trackId = store.project.tracks[0].id;
      await store.addClip(trackId, song.mix, 'song.wav');
    });
    const user = userEvent.setup();

    // Turning Human Voice Processing on runs real separation (this is the
    // switch the user flips), then the vocal pitch slider applies to the stem.
    await user.click(screen.getByRole('switch', { name: /Human Voice Processing/ }));
    await waitFor(() => expect(ref.current!.project.tracks[0].vocal.status).toBe('ready'), { timeout: 120_000, interval: 200 });
    await waitFor(() => expect(ref.current!.project.tracks[0].vocal.enabled).toBe(true), { timeout: 10_000 });

    const { prepareClipData } = await import('../audio/mixdown');
    const semisSlider = screen.getByRole('slider', { name: /Vocal pitch/i });
    await act(async () => {
      // The slider is a range input: set it the way a drag would.
      fireEvent.change(semisSlider, { target: { value: '12' } });
    });
    await waitFor(() => expect(ref.current!.project.tracks[0].vocal.pitchSemis).toBe(12), { timeout: 10_000 });

    const track = ref.current!.project.tracks.find((t) => t.id === trackId)!;
    const prepared = await prepareClipData(track, track.clips[0]);
    const octave = levelAt(prepared.channels[0], VOCAL * 2);
    const base = levelAt(prepared.channels[0], VOCAL);
    expect(ref.current!.project.tracks[0].vocal.enabled).toBe(true);
    // The vocal is genuinely an octave up in what will be played.
    expect(octave).toBeGreaterThan(base * 1.5);
    view.unmount();
  }, 240_000);
});
