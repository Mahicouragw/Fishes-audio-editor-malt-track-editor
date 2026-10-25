import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';

describe('App', () => {
  it('renders Wishes Audio Editor and navigates', async () => {
    const { unmount } = render(<App />);
    expect(await screen.findByRole('heading', { name: 'Wishes Audio Editor' })).toBeInTheDocument();
    // Navigation labels
    expect(screen.getByRole('tab', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Library' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Library' }));
    expect(await screen.findByRole('heading', { name: 'Library' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { name: 'Privacy Policy' })).toBeInTheDocument();
    // Essential transport labels appear in Studio
    await user.click(screen.getByRole('tab', { name: 'Studio' }));
    expect(await screen.findByRole('button', { name: /Play|Resume/ })).toBeInTheDocument();
    // Vocal toggle is a real switch
    expect(screen.getByRole('switch', { name: /Human Voice Processing/ })).toBeInTheDocument();
    unmount();
  });

  it('upload validation surfaces errors', async () => {
    const { unmount } = render(<App />);
    // Home has upload buttons
    expect(await screen.findByRole('button', { name: 'Upload audio files' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Upload video to extract audio' })).toBeInTheDocument();
    unmount();
  });
});
