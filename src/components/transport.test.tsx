import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Transport } from './Transport';

afterEach(() => {
  cleanup();
});

function setup(overrides: Partial<Parameters<typeof Transport>[0]> = {}) {
  const handlers = {
    onPlay: vi.fn(),
    onPause: vi.fn(),
    onStop: vi.fn(),
    onSkipBack: vi.fn(),
    onSkipForward: vi.fn(),
    onSeek: vi.fn(),
    onRestart: vi.fn(),
  };
  const view = render(
    <Transport
      position={12.5}
      duration={212}
      playing={false}
      paused={false}
      skipSeconds={5}
      {...handlers}
      {...overrides}
    />,
  );
  return { ...handlers, view };
}

describe('Transport playback controls', () => {
  it('offers Play when idle, Pause while playing and Resume when paused', async () => {
    const user = userEvent.setup();
    const idle = setup();
    const play = screen.getByRole('button', { name: 'Play' });
    await user.click(play);
    expect(idle.onPlay).toHaveBeenCalledTimes(1);
    idle.view.unmount();

    const playing = setup({ playing: true });
    const pause = screen.getByRole('button', { name: 'Pause playback' });
    await user.click(pause);
    expect(playing.onPause).toHaveBeenCalledTimes(1);
    expect(playing.onPlay).not.toHaveBeenCalled();
    playing.view.unmount();

    const paused = setup({ paused: true });
    const resume = screen.getByRole('button', { name: 'Resume playback' });
    await user.click(resume);
    expect(paused.onPlay).toHaveBeenCalledTimes(1);
  });

  it('keeps every control keyboard reachable and correctly named', async () => {
    const user = userEvent.setup();
    const handlers = setup({ playing: true });
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart playback' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Seek' })).toHaveAccessibleName('Seek');
    expect(screen.getByRole('slider', { name: 'Seek' })).toHaveAttribute('aria-valuetext', '00:12.500 of 03:32.000');
    await user.click(screen.getByRole('button', { name: 'Skip forward 5 seconds' }));
    expect(handlers.onSkipForward).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(handlers.onStop).toHaveBeenCalled();
  });

  it('never puts the running clock in a live region', () => {
    setup({ playing: true });
    const region = document.querySelector('[role="region"], .transport');
    expect(region).toBeTruthy();
    // The container that changes 25×/second must be explicitly silent for
    // screen readers; the time is read on demand instead.
    const time = document.querySelector('.transport-time');
    expect(time?.getAttribute('aria-live')).toBe('off');
    for (const node of Array.from(document.querySelectorAll('[aria-live="polite"], [aria-live="assertive"]'))) {
      expect(node.textContent).not.toMatch(/\d+:\d{2}/);
    }
  });
});
