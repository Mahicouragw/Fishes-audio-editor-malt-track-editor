import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VocalPanel } from './EffectsPanel';
import type { Track } from '../types';

function makeTrack(): Track {
  return {
    id: 'track-1',
    name: 'Lead vocal',
    clips: [],
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    pitchSemitones: 0,
    pitchCents: 0,
    vocal: {
      enabled: true,
      status: 'processing',
      pitchSemis: 0,
      vocalVolume: 1,
      mixWithAccompaniment: true,
      quality: 0,
      qualityMessage: '',
      method: 'local-approximate',
    },
  } as unknown as Track;
}

const noop = () => {};

function renderPanel(overrides: Partial<Parameters<typeof VocalPanel>[0]> = {}) {
  const onCancel = vi.fn();
  render(
    <VocalPanel
      track={makeTrack()}
      onToggle={noop}
      onPitch={noop}
      onVocalVolume={noop}
      onMix={noop}
      onSeparate={noop}
      onPreview={noop}
      busy
      progress={0.42}
      message="Separating vocals"
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onCancel };
}

afterEach(cleanup);

describe('vocal separation progress and cancel', () => {
  it('shows the real stage message and percentage instead of a stuck 0 %', () => {
    renderPanel();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveAttribute('aria-label', 'Separating vocals');
    expect(bar.textContent).toContain('Separating vocals');
    expect(bar.textContent).toContain('42%');
  });

  it('offers a cancel control while a render runs and calls it', () => {
    const { onCancel } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel vocal separation' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('hides the bar and the cancel control when nothing is running', () => {
    renderPanel({ busy: false, progress: 0, message: '' });
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel vocal separation' })).toBeNull();
  });
});
