import { describe, it, expect } from 'vitest';
import { formatTime, parseTime, clamp, projectDuration, type Project } from './types';

describe('formatTime/parseTime', () => {
  it('formats and parses', () => {
    expect(formatTime(65.123)).toBe('01:05.123');
    expect(parseTime('01:05.123')).toBeCloseTo(65.123, 3);
    expect(parseTime('5.5')).toBeCloseTo(5.5, 3);
    expect(parseTime('bad')).toBeNull();
    expect(parseTime('00:70.000')).toBeNull();
  });
});

describe('clamp', () => {
  it('clamps', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
  });
});

describe('projectDuration', () => {
  it('computes max end', () => {
    const project = {
      tracks: [
        { clips: [{ start: 0, duration: 2, assetId: 'a', sourceStart: 0 }] },
        { clips: [{ start: 1, duration: 3, assetId: 'b', sourceStart: 0 }] },
      ],
    } as unknown as Project;
    const lengths = new Map([['a', 2], ['b', 3]]);
    expect(projectDuration(project, lengths)).toBe(4);
  });
});
