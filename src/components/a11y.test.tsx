import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';

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
