import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HarmonizationPanel, type HarmonyDraft } from './HarmonizationPanel';
import { defaultVocalState, type HarmonyLayer, type RangeEffect, type Track } from '../types';

const FULL_SONG = 212;

afterEach(() => {
  cleanup();
});

function makeTrack(id: string, name: string, withClip = false): Track {
  return {
    id,
    name,
    volume: 1,
    muted: false,
    solo: false,
    pitchSemis: 0,
    pitchFineCents: 0,
    clips: withClip
      ? [{
        id: `${id}-clip`,
        assetId: `${id}-asset`,
        name: `${name} clip`,
        start: 0,
        sourceStart: 0,
        duration: FULL_SONG,
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
        effects: [],
      }]
      : [],
    vocal: defaultVocalState(),
  };
}

const TRACKS = [makeTrack('t1', 'Voice 1', true), makeTrack('t2', 'Voice 2'), makeTrack('t3', 'Voice 3')];

function layer(overrides: Partial<HarmonyLayer> = {}): HarmonyLayer {
  return {
    id: 'layer-1',
    name: 'Harmony +4',
    sourceTrackId: 't1',
    targetTrackId: 't2',
    clipId: 't2-clip',
    semitones: 4,
    gain: 0.8,
    muted: false,
    solo: false,
    vocalsOnly: false,
    offsetSeconds: 0,
    effects: [],
    scope: 'entire-song',
    originalVoice: false,
    groupId: 'harmony:t1',
    ...overrides,
  };
}

interface HarnessOptions {
  harmonies?: HarmonyLayer[];
  mediaDuration?: number;
  hasVocalStems?: boolean;
  busy?: boolean;
  error?: string;
}

function setup(options: HarnessOptions = {}) {
  const onPreview = vi.fn<(draft: HarmonyDraft) => void>();
  const onApply = vi.fn<(draft: HarmonyDraft) => void>();
  const handlers = {
    onPreview,
    onApply,
    onCancel: vi.fn(),
    onLayerPatch: vi.fn(),
    onLayerOffset: vi.fn(),
    onLayerPreview: vi.fn(),
    onLayerRemove: vi.fn(),
    onLayerDuplicate: vi.fn(),
    onLayerRerender: vi.fn<(layerId: string, semitones: number, effects: RangeEffect[]) => void>(),
    onSourceTrackChange: vi.fn(),
  };
  const view = render(
    <HarmonizationPanel
      tracks={TRACKS}
      harmonies={options.harmonies ?? []}
      sourceTrackId="t1"
      mediaDuration={options.mediaDuration ?? FULL_SONG}
      hasVocalStems={options.hasVocalStems ?? false}
      busy={options.busy ?? false}
      progress={0}
      message=""
      error={options.error ?? ''}
      {...handlers}
    />,
  );
  return { ...handlers, view };
}

describe('HarmonizationPanel', () => {
  it('offers every interval preset and both harmony presets', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Harmony interval Original (+0)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Harmony interval Minor third (+3)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Harmony interval Major third (+4)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Harmony interval Perfect fifth (+7)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Harmony Preset A (0, +4, +7)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Harmony Preset B (0, +3, +7)' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Custom harmony semitones' })).toBeInTheDocument();
  });

  it('loads Preset A voices (0, +4, +7) and switches to Preset B (0, +3, +7)', async () => {
    const user = userEvent.setup();
    setup();
    // Preset A is the default.
    expect(screen.getByRole('checkbox', { name: 'Enable harmony voice Original' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Enable harmony voice Major third (+4)' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Enable harmony voice Perfect fifth (+7)' })).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Harmony Preset B (0, +3, +7)' }));
    expect(screen.getByRole('checkbox', { name: 'Enable harmony voice Minor third (+3)' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Enable harmony voice Perfect fifth (+7)' })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Enable harmony voice Major third (+4)' })).not.toBeInTheDocument();
  });

  it('lets each voice be disabled independently before applying', async () => {
    const user = userEvent.setup();
    const { onApply } = setup();
    await user.click(screen.getByRole('checkbox', { name: 'Enable harmony voice Perfect fifth (+7)' }));
    await user.click(screen.getByRole('button', { name: 'Apply harmony' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    const draft = onApply.mock.calls[0][0];
    expect(draft.voices.filter((v) => v.enabled).map((v) => v.semitones)).toEqual([0, 4]);
    expect(draft.scope.scope).toBe('entire-song');
  });

  it('supports custom intervals including negative semitones', async () => {
    const user = userEvent.setup();
    const { onApply } = setup();
    const custom = screen.getByRole('spinbutton', { name: 'Custom harmony semitones' });
    fireEvent.change(custom, { target: { value: '-5' } });
    await user.click(screen.getByRole('button', { name: 'Apply harmony' }));
    const draft = onApply.mock.calls[0][0];
    expect(draft.voices[0].semitones).toBe(-5);
  });

  it('summarises the entire song scope with the real duration', () => {
    setup({ mediaDuration: FULL_SONG });
    expect(screen.getByTestId('harmony-scope-summary')).toHaveTextContent(/Entire Song/i);
    expect(screen.getByTestId('harmony-scope-summary')).toHaveTextContent('03:32.000');
  });

  it('validates a selected range against the real media duration', async () => {
    const user = userEvent.setup();
    const { onApply } = setup({ mediaDuration: 20 });
    await user.click(screen.getByRole('radio', { name: 'Selected Time Range' }));
    // Default range is 5 s – 25 s, which is beyond a 20 s file.
    expect(screen.getByRole('alert')).toHaveTextContent(/beyond the media duration/i);
    await user.click(screen.getByRole('button', { name: 'Apply harmony' }));
    expect(onApply).not.toHaveBeenCalled();

    // A valid range applies with that exact range.
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Harmonization range end in seconds' }), { target: { value: '12' } });
    await user.click(screen.getByRole('button', { name: 'Apply harmony' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0].scope).toMatchObject({ scope: 'range', start: 5, end: 12 });
  });

  it('previews without applying and cancels cleanly', async () => {
    const user = userEvent.setup();
    const { onPreview, onApply, onCancel } = setup();
    await user.click(screen.getByRole('button', { name: 'Preview harmony' }));
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel harmony' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('resets the voices to the original pitch', async () => {
    const user = userEvent.setup();
    const { onApply } = setup();
    await user.click(screen.getByRole('button', { name: 'Reset harmony to original pitch' }));
    await user.click(screen.getByRole('button', { name: 'Apply harmony' }));
    const draft = onApply.mock.calls[0][0];
    expect(draft.voices.every((v) => v.semitones === 0)).toBe(true);
  });

  it('disables vocal-only harmonization when no stems exist, and explains why', () => {
    setup({ hasVocalStems: false });
    const checkbox = screen.getByRole('checkbox', { name: 'Apply harmonization only to isolated human vocals' });
    expect(checkbox).toBeDisabled();
    expect(screen.getByText(/run vocal separation on the source track first/i)).toBeInTheDocument();
  });

  it('manages applied voices: solo, mute, offset, preview, duplicate, remove', async () => {
    const user = userEvent.setup();
    const handlers = setup({ harmonies: [layer()] });
    await user.click(screen.getByRole('button', { name: 'Solo harmony voice Harmony +4' }));
    expect(handlers.onLayerPatch).toHaveBeenCalledWith('layer-1', { solo: true });
    await user.click(screen.getByRole('button', { name: 'Mute harmony voice Harmony +4' }));
    expect(handlers.onLayerPatch).toHaveBeenCalledWith('layer-1', { muted: true });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Harmony voice Harmony +4 timing offset in seconds' }), { target: { value: '0.25' } });
    expect(handlers.onLayerOffset).toHaveBeenCalledWith('layer-1', 0.25);
    await user.click(screen.getByRole('button', { name: 'Preview harmony voice Harmony +4' }));
    expect(handlers.onLayerPreview).toHaveBeenCalledWith('layer-1');
    await user.click(screen.getByRole('button', { name: 'Duplicate harmony voice Harmony +4' }));
    expect(handlers.onLayerDuplicate).toHaveBeenCalledWith('layer-1');
    await user.click(screen.getByRole('button', { name: 'Remove harmony voice Harmony +4' }));
    expect(handlers.onLayerRemove).toHaveBeenCalledWith('layer-1');
  });

  it('re-renders a voice when its interval or effects change', async () => {
    const user = userEvent.setup();
    const handlers = setup({ harmonies: [layer()] });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Harmony voice Harmony +4 semitones' }), { target: { value: '7' } });
    await user.click(screen.getByRole('checkbox', { name: 'Reverb on harmony voice Harmony +4' }));
    await user.click(screen.getByRole('button', { name: 'Update harmony voice Harmony +4' }));
    expect(handlers.onLayerRerender).toHaveBeenCalledTimes(1);
    const [id, semitones, effects] = handlers.onLayerRerender.mock.calls[0];
    expect(id).toBe('layer-1');
    expect(semitones).toBe(7);
    expect(effects.map((effect) => effect.type)).toEqual(['reverb']);
  });

  it('shows the +0 voice as the original, without duplicate audio controls', () => {
    setup({ harmonies: [layer({ originalVoice: true, semitones: 0, name: 'Original (+0)', clipId: undefined })] });
    expect(screen.getByRole('button', { name: 'Preview harmony voice Original (+0)' })).toBeInTheDocument();
    expect(screen.getAllByText(/original pitch/).length).toBeGreaterThan(0);
    // The original voice has no semitone/effect re-render controls.
    expect(screen.queryByRole('spinbutton', { name: /Original \(\+0\) semitones/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Update harmony voice Original/ })).not.toBeInTheDocument();
    // It can still be previewed, muted, soloed, offset and removed.
    expect(screen.getByRole('button', { name: 'Preview harmony voice Original (+0)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove harmony voice Original (+0)' })).toBeInTheDocument();
  });

  it('reports processing state and errors honestly', () => {
    setup({ busy: true, error: 'Separation failed: model unavailable' });
    expect(screen.getByRole('alert')).toHaveTextContent('Separation failed: model unavailable');
    expect(screen.getByRole('button', { name: 'Apply harmony' })).toBeDisabled();
  });
});
