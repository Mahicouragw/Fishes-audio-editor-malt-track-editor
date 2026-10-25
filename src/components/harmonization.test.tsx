import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HarmonizationPanel, type HarmonyDraft } from './HarmonizationPanel';
import { defaultVocalState, type HarmonyLayer, type HarmonyRange, type RangeEffect, type Track } from '../types';

const FULL_SONG = 212;

afterEach(() => {
  cleanup();
});

function makeTrack(id: string, name: string, withClip = false): Track {
  return {
    id,
    name,
    volume: 1,
    pan: 0,
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
    pan: 0,
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

function makeRange(id: string, start: number, end: number): HarmonyRange {
  return { id, start, end, enabled: true };
}

interface HarnessOptions {
  harmonies?: HarmonyLayer[];
  mediaDuration?: number;
  hasVocalStems?: boolean;
  busy?: boolean;
  error?: string;
  ranges?: HarmonyRange[];
  canUndo?: boolean;
  canRedo?: boolean;
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
    onRunSeparation: vi.fn(),
    onAddRange: vi.fn(),
    onUpdateRange: vi.fn(),
    onRemoveRange: vi.fn(),
    onKeyChange: vi.fn(),
    onScaleChange: vi.fn(),
    onCompare: vi.fn(),
    onSoloHarmony: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
  };
  const view = render(
    <HarmonizationPanel
      tracks={TRACKS}
      harmonies={options.harmonies ?? []}
      sourceTrackId="t1"
      mediaDuration={options.mediaDuration ?? FULL_SONG}
      hasVocalStems={options.hasVocalStems ?? false}
      ranges={options.ranges ?? []}
      songKey="C"
      scale="major"
      activeGroupId={options.harmonies?.length ? 'harmony:t1' : null}
      canUndo={options.canUndo ?? false}
      canRedo={options.canRedo ?? false}
      busy={options.busy ?? false}
      progress={0}
      message=""
      error={options.error ?? ''}
      {...handlers}
    />,
  );
  return { ...handlers, view };
}

/** Read a numeric field by its accessible name (spinbutton or slider). */
function valueOf(name: RegExp | string): string {
  const field = screen.queryByRole('spinbutton', { name }) ?? screen.queryByRole('slider', { name });
  return (field as HTMLInputElement).value;
}

describe('HarmonizationPanel', () => {
  it('offers the three presets, every interval and both scope modes', () => {
    setup();
    expect(screen.getByRole('button', { name: /Preset A/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Preset B/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Preset C/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Harmony interval Minor third (+3)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Harmony interval Major third (+4)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Harmony interval Perfect fifth (+7)' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Entire Song' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Selected Time Ranges' })).not.toBeChecked();
  });

  it('loads Preset A with the exact four voices and their delay and volume', () => {
    setup();
    // Voice 1 is the untouched lead.
    expect(valueOf(/Harmony voice 1 pitch/)).toBe('0');
    expect(valueOf(/Harmony voice 1 volume/)).toBe('1');
    expect(valueOf(/Harmony voice 1 delay/)).toBe('0');
    // +4 at 23 ms and 30 %, +7 at 49 ms and 40 %, +0 double at 33 ms and 30 %.
    expect(valueOf(/Harmony voice 2 pitch/)).toBe('4');
    expect(valueOf(/Harmony voice 2 delay/)).toBe('23');
    expect(valueOf(/Harmony voice 2 volume/)).toBe('0.3');
    expect(valueOf(/Harmony voice 3 pitch/)).toBe('7');
    expect(valueOf(/Harmony voice 3 delay/)).toBe('49');
    expect(valueOf(/Harmony voice 3 volume/)).toBe('0.4');
    expect(valueOf(/Harmony voice 4 pitch/)).toBe('0');
    expect(valueOf(/Harmony voice 4 delay/)).toBe('33');
    expect(valueOf(/Harmony voice 4 volume/)).toBe('0.3');
    // The +0 double is micro-detuned so it cannot comb-filter the lead.
    expect(Math.abs(Number(valueOf(/Harmony voice 4 detune/)))).toBeGreaterThan(0);
  });

  it('loads Preset B and Preset C with their exact values', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: /Preset B/ }));
    expect(valueOf(/Harmony voice 2 pitch/)).toBe('3');
    expect(valueOf(/Harmony voice 2 delay/)).toBe('23');
    expect(valueOf(/Harmony voice 3 pitch/)).toBe('7');
    expect(valueOf(/Harmony voice 3 delay/)).toBe('19');
    expect(valueOf(/Harmony voice 4 delay/)).toBe('5');

    await user.click(screen.getByRole('button', { name: /Preset C/ }));
    expect(valueOf(/Harmony voice 1 pitch/)).toBe('0');
    expect(valueOf(/Harmony voice 2 pitch/)).toBe('0');
    expect(valueOf(/Harmony voice 2 delay/)).toBe('12');
    expect(valueOf(/Harmony voice 2 volume/)).toBe('0.3');
    expect(valueOf(/Harmony voice 3 delay/)).toBe('24');
    expect(valueOf(/Harmony voice 3 volume/)).toBe('0.25');
    expect(valueOf(/Harmony voice 4 delay/)).toBe('36');
    expect(valueOf(/Harmony voice 4 volume/)).toBe('0.2');
    // Every double is detuned: this is what makes it a double, not a copy.
    for (const index of [2, 3, 4]) {
      expect(Number(valueOf(new RegExp(`Harmony voice ${index} detune`)))).not.toBe(0);
    }
  });

  it('lets every voice value be edited and applies exactly what is shown', async () => {
    const user = userEvent.setup();
    const { onApply } = setup();
    fireEvent.change(screen.getByRole('spinbutton', { name: /Harmony voice 2 pitch/ }), { target: { value: '5' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: /Harmony voice 2 delay/ }), { target: { value: '40' } });
    fireEvent.change(screen.getByRole('slider', { name: /Harmony voice 2 volume/ }), { target: { value: '0.55' } });
    fireEvent.change(screen.getByRole('slider', { name: /Harmony voice 2 pan/ }), { target: { value: '-0.5' } });
    await user.click(screen.getByRole('checkbox', { name: /Enable harmony voice 3/ }));
    await user.click(screen.getByRole('button', { name: 'Apply harmony' }));

    expect(onApply).toHaveBeenCalledTimes(1);
    const draft = onApply.mock.calls[0][0];
    const voice = draft.voices[1];
    expect(voice.semitones).toBe(5);
    expect(voice.offsetSeconds).toBeCloseTo(0.04, 5);
    expect(voice.gain).toBeCloseTo(0.55, 5);
    expect(voice.pan).toBeCloseTo(-0.5, 5);
    expect(draft.voices[2].enabled).toBe(false);
  });

  it('supports negative custom intervals', async () => {
    const user = userEvent.setup();
    const { onApply } = setup();
    fireEvent.change(screen.getByRole('spinbutton', { name: /Harmony voice 1 pitch/ }), { target: { value: '-7' } });
    await user.click(screen.getByRole('button', { name: 'Apply harmony' }));
    expect(onApply.mock.calls[0][0].voices[0].semitones).toBe(-7);
  });

  it('summarises the entire song with the real duration', () => {
    setup({ mediaDuration: FULL_SONG });
    expect(screen.getByTestId('harmony-scope-summary')).toHaveTextContent(/Entire Song/i);
    expect(screen.getByTestId('harmony-scope-summary')).toHaveTextContent('03:32.000');
  });

  it('manages multiple non-contiguous ranges and applies all of them', async () => {
    const user = userEvent.setup();
    const ranges = [
      makeRange('r1', 5, 25),
      makeRange('r2', 85, 95),
      makeRange('r3', 145, 155),
      makeRange('r4', 190, 200),
    ];
    const { onApply, onAddRange, onUpdateRange, onRemoveRange } = setup({ ranges });
    await user.click(screen.getByRole('radio', { name: 'Selected Time Ranges' }));
    expect(screen.getByRole('list', { name: 'Time ranges for harmonization' })).toBeInTheDocument();
    expect(screen.getByTestId('harmony-scope-summary')).toHaveTextContent('4 ranges');
    expect(screen.getByRole('spinbutton', { name: 'Range 2 start in seconds' })).toHaveValue(85);

    await user.click(screen.getByRole('button', { name: 'Add time range' }));
    expect(onAddRange).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Range 3 start in seconds' }), { target: { value: '150' } });
    expect(onUpdateRange).toHaveBeenCalledWith('r3', { start: 150 });
    await user.click(screen.getByRole('button', { name: 'Remove time range 4' }));
    expect(onRemoveRange).toHaveBeenCalledWith('r4');

    await user.click(screen.getByRole('button', { name: 'Apply harmony' }));
    const draft = onApply.mock.calls[0][0];
    expect(draft.scope.scope).toBe('range');
    expect(draft.scope.ranges?.map((r) => [r.start, r.end])).toEqual([[5, 25], [85, 95], [145, 155], [190, 200]]);
  });

  it('rejects ranges beyond the media duration and applies nothing', async () => {
    const user = userEvent.setup();
    const { onApply } = setup({ mediaDuration: 20, ranges: [makeRange('r1', 5, 25)] });
    await user.click(screen.getByRole('radio', { name: 'Selected Time Ranges' }));
    expect(screen.getAllByRole('alert').map((node) => node.textContent).join(' ')).toMatch(/beyond the media duration/i);
    await user.click(screen.getByRole('button', { name: 'Apply harmony' }));
    expect(onApply).not.toHaveBeenCalled();
  });

  it('warns when a preset interval is outside the chosen key and can snap it', async () => {
    const user = userEvent.setup();
    setup();
    // Preset C is all +0, so switch to B: +3 is not in C major.
    await user.click(screen.getByRole('button', { name: /Preset B/ }));
    expect(screen.getAllByRole('status').map((node) => node.textContent).join(' ')).toMatch(/outside C major/i);
    await user.click(screen.getByRole('button', { name: 'Snap harmony intervals to C major' }));
    expect(valueOf(/Harmony voice 2 pitch/)).toBe('4');
    expect(screen.queryByText(/outside C major/i)).not.toBeInTheDocument();
  });

  it('previews without applying, and cancels cleanly', async () => {
    const user = userEvent.setup();
    const { onPreview, onApply, onCancel } = setup();
    await user.click(screen.getByRole('button', { name: 'Preview harmony' }));
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel harmony' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('resets every voice to the original pitch', async () => {
    const user = userEvent.setup();
    const { onApply } = setup();
    await user.click(screen.getByRole('button', { name: 'Reset harmony to original pitch' }));
    await user.click(screen.getByRole('button', { name: 'Apply harmony' }));
    expect(onApply.mock.calls[0][0].voices.every((v) => v.semitones === 0)).toBe(true);
  });

  it('disables Human Voice Mode without stems and offers to run separation', async () => {
    const user = userEvent.setup();
    const { onRunSeparation } = setup({ hasVocalStems: false });
    const checkbox = screen.getByRole('checkbox', { name: /Human Voice Mode/ });
    expect(checkbox).toBeDisabled();
    expect(screen.getByText(/needs vocal separation first/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Run vocal separation for the source track' }));
    expect(onRunSeparation).toHaveBeenCalledTimes(1);
  });

  it('enables Human Voice Mode when real stems exist', async () => {
    const user = userEvent.setup();
    const { onApply } = setup({ hasVocalStems: true });
    const checkbox = screen.getByRole('checkbox', { name: /Human Voice Mode/ });
    expect(checkbox).toBeEnabled();
    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: 'Apply harmony' }));
    expect(onApply.mock.calls[0][0].vocalsOnly).toBe(true);
  });

  it('manages applied voices: mute, solo, volume, pan, delay, preview, duplicate, remove', async () => {
    const user = userEvent.setup();
    const handlers = setup({ harmonies: [layer()] });
    await user.click(screen.getByRole('button', { name: 'Mute harmony voice 1, Harmony +4' }));
    expect(handlers.onLayerPatch).toHaveBeenCalledWith('layer-1', { muted: true });
    await user.click(screen.getByRole('button', { name: 'Solo harmony voice 1, Harmony +4' }));
    expect(handlers.onLayerPatch).toHaveBeenCalledWith('layer-1', { solo: true });
    fireEvent.change(screen.getByRole('slider', { name: /Applied voice 1 volume/ }), { target: { value: '0.5' } });
    expect(handlers.onLayerPatch).toHaveBeenCalledWith('layer-1', { gain: 0.5 });
    fireEvent.change(screen.getByRole('slider', { name: /Applied voice 1 pan/ }), { target: { value: '0.5' } });
    expect(handlers.onLayerPatch).toHaveBeenCalledWith('layer-1', { pan: 0.5 });
    fireEvent.change(screen.getByRole('spinbutton', { name: /Applied voice 1 delay/ }), { target: { value: '250' } });
    expect(handlers.onLayerOffset).toHaveBeenCalledWith('layer-1', 0.25);
    await user.click(screen.getByRole('button', { name: 'Preview harmony voice 1, Harmony +4' }));
    expect(handlers.onLayerPreview).toHaveBeenCalledWith('layer-1');
    await user.click(screen.getByRole('button', { name: 'Duplicate harmony voice 1, Harmony +4' }));
    expect(handlers.onLayerDuplicate).toHaveBeenCalledWith('layer-1');
    await user.click(screen.getByRole('button', { name: 'Remove harmony voice 1, Harmony +4' }));
    expect(handlers.onLayerRemove).toHaveBeenCalledWith('layer-1');
  });

  it('re-renders an applied voice when its interval or effects change', async () => {
    const user = userEvent.setup();
    const handlers = setup({ harmonies: [layer()] });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Applied voice 1 semitones' }), { target: { value: '7' } });
    await user.click(screen.getByRole('checkbox', { name: 'Reverb on applied voice 1' }));
    await user.click(screen.getByRole('button', { name: 'Update harmony voice 1, Harmony +4' }));
    expect(handlers.onLayerRerender).toHaveBeenCalledTimes(1);
    const [id, semitones, effects] = handlers.onLayerRerender.mock.calls[0];
    expect(id).toBe('layer-1');
    expect(semitones).toBe(7);
    expect(effects.map((effect) => effect.type)).toEqual(['reverb']);
  });

  it('does not offer duplicate-audio controls for the original lead row', () => {
    setup({ harmonies: [layer({ originalVoice: true, semitones: 0, name: 'Original (+0)', clipId: undefined })] });
    expect(screen.queryByRole('spinbutton', { name: /Applied voice 1 semitones/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Update harmony voice 1/ })).not.toBeInTheDocument();
    // It can still be muted, soloed, panned and removed.
    expect(screen.getByRole('button', { name: 'Mute harmony voice 1, Original (+0)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove harmony voice 1, Original (+0)' })).toBeInTheDocument();
  });

  it('offers A/B comparison against the original and undo/redo', async () => {
    const user = userEvent.setup();
    const handlers = setup({ harmonies: [layer()], canUndo: true, canRedo: true });
    await user.click(screen.getByRole('button', { name: /Mute all harmony voices/ }));
    expect(handlers.onCompare).toHaveBeenCalledWith(true);
    await user.click(screen.getByRole('button', { name: 'Solo the harmony voices' }));
    expect(handlers.onSoloHarmony).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Undo last edit' }));
    expect(handlers.onUndo).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Redo last undone edit' }));
    expect(handlers.onRedo).toHaveBeenCalledTimes(1);
  });

  it('reports processing state and errors honestly', () => {
    setup({ busy: true, error: 'Separation failed: model unavailable' });
    expect(screen.getByRole('alert')).toHaveTextContent('Separation failed: model unavailable');
    expect(screen.getByRole('button', { name: 'Apply harmony' })).toBeDisabled();
  });

  it('labels voice controls with their current values for screen readers', async () => {
    const user = userEvent.setup();
    setup();
    // Pitch: "Harmony voice 2 pitch, plus 4 semitones".
    expect(screen.getByRole('spinbutton', { name: 'Harmony voice 2 pitch, plus 4 semitones' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Harmony interval Perfect fifth (+7)' }));
    expect(screen.getByRole('spinbutton', { name: 'Harmony voice 2 pitch, plus 7 semitones' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: /Harmony voice 1 pan, centre/ })).toBeInTheDocument();
  });
});
