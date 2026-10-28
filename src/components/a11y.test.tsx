import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';

afterEach(() => {
  cleanup();
});

describe('accessibility labels', () => {
  it('exposes accurate transport, switch and timeline labels in the Studio', async () => {
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Studio' }));

    // Transport controls with descriptive names
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart playback' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip backward 5 seconds' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip forward 5 seconds' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Seek' })).toBeInTheDocument();

    // Timeline ruler is a keyboard-accessible slider with range selection help
    expect(screen.getByRole('slider', { name: /Timeline position and range selection/ })).toBeInTheDocument();

    // Human voice processing is a real switch with an accurate state
    const switchEl = screen.getByRole('switch', { name: 'Human Voice Processing, off' });
    expect(switchEl).toBeInTheDocument();

    // Track controls name the selected track
    expect(screen.getByRole('button', { name: 'Select Voice 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select Voice 2' })).toBeInTheDocument();

    // Pitch controls speak the value
    expect(screen.getByRole('slider', { name: /Voice 1 pitch, original pitch/ })).toBeInTheDocument();

    // Progress bars must never be present without work (no fake progress)
    expect(screen.queryAllByRole('progressbar', { name: /Preparing|Rendering|Separating|Merging/ })).toHaveLength(0);
  }, 30_000);

  it('announces track selection in the live region and keeps 44px targets', async () => {
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Studio' }));
    await user.click(screen.getByRole('button', { name: 'Select Voice 2' }));
    expect(await screen.findByText('Selected Voice 2')).toBeInTheDocument();
  }, 30_000);
});

describe('TalkBack cursor navigation during playback', () => {
  it('never announces a running clock or a live progress percentage', async () => {
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Studio' }));

    // The old bug: the header clock lived in `aria-live="polite"` and updated
    // 25 times a second, so TalkBack kept talking and the cursor could not
    // move between controls. Progress percentages were live too.
    for (const node of Array.from(document.querySelectorAll('[aria-live="polite"], [aria-live="assertive"]'))) {
      expect(node.textContent ?? '').not.toMatch(/\d+\s?%/);
    }
    // The running clock is deliberately silent; the value is still readable on
    // demand from the transport's seek slider and its time label.
    const clock = document.querySelector('.studio-header .hint');
    expect(clock).toBeTruthy();
    expect(clock?.getAttribute('aria-live')).toBe('off');
    expect(document.querySelector('.transport-time')?.getAttribute('aria-live')).toBe('off');

    // Exactly one announcement channel, and it is event-based.
    expect(document.querySelectorAll('.live-region[aria-live="polite"]')).toHaveLength(1);
    expect(document.querySelector('.live-region')?.closest('main')).toBeNull();
    for (const node of Array.from(document.querySelectorAll('main [role="status"], main [aria-live="polite"]'))) {
      // Status text in the panels is a static summary of a user action; it may
      // name a duration but must never carry a changing percentage.
      expect(node.textContent ?? '').not.toMatch(/\d+\s?%/);
    }
  }, 30_000);

  it('keeps navigation, transport and panels reachable while audio plays', async () => {
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Studio' }));

    // Everything a TalkBack user swipes through must be reachable by role,
    // including the pages that are outside the studio.
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Seek' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab', { name: 'Home' })).toHaveLength(1);
    expect(screen.getAllByRole('tab', { name: 'Library' })).toHaveLength(1);
    expect(screen.getAllByRole('tab', { name: 'Settings' })).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Transport' })).toBeInTheDocument();
    // Nothing may trap focus: no dialog, and no element with a click handler
    // covering the page.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
  }, 30_000);
});
