import { describe, it, expect } from 'vitest';
import { validateMediaFile, extensionOf } from './decode';

function file(name: string, type: string, size: number): File {
  return { name, type, size } as unknown as File;
}

describe('validateMediaFile', () => {
  it('accepts supported audio', () => {
    expect(validateMediaFile(file('song.mp3', 'audio/mpeg', 1000), 'audio', 250)).toBeNull();
    expect(validateMediaFile(file('song.wav', '', 1000), 'audio', 250)).toBeNull();
  });
  it('rejects unsupported', () => {
    expect(validateMediaFile(file('doc.pdf', 'application/pdf', 1000), 'audio', 250)).not.toBeNull();
    expect(validateMediaFile(file('vid.mp4', 'video/mp4', 1000), 'audio', 250)).toBeNull(); // video can be decoded for audio
  });
  it('enforces size', () => {
    expect(validateMediaFile(file('big.wav', 'audio/wav', 300 * 1024 * 1024), 'audio', 250)).not.toBeNull();
  });
  it('extensionOf', () => {
    expect(extensionOf('song.Mp3')).toBe('mp3');
  });
});
