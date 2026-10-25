import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlaybackEngine } from './engine';

class FakeGain {
  gain = { value: 1, setTargetAtTime: vi.fn(), setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
  connect() {}
  disconnect() {}
}
class FakeCompressor {
  threshold = { value: 0 };
  knee = { value: 0 };
  ratio = { value: 0 };
  attack = { value: 0 };
  release = { value: 0 };
  connect() {}
  disconnect() {}
}
class FakeSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  connect() {}
  disconnect() {}
  start(_when: number, _offset: number, _duration: number) {}
  stop() {}
}

function makeContext() {
  let now = 0;
  const ctx = {
    get currentTime() { return now; },
    set currentTime(v: number) { now = v; },
    state: 'running' as AudioContextState,
    sampleRate: 44100,
    destination: {},
    createGain: () => new FakeGain() as unknown as GainNode,
    createDynamicsCompressor: () => new FakeCompressor() as unknown as DynamicsCompressorNode,
    createBufferSource: () => new FakeSource() as unknown as AudioBufferSourceNode,
    close: async () => { (ctx as unknown as { state: string }).state = 'closed'; },
    resume: async () => { (ctx as unknown as { state: string }).state = 'running'; },
    advance: (dt: number) => { now += dt; },
  };
  return ctx as unknown as AudioContext & { advance: (n: number) => void };
}

describe('PlaybackEngine', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  it('play sets playing, pause records position, stop resets', async () => {
    const ctx = makeContext();
    const engine = new PlaybackEngine(() => ctx as unknown as AudioContext);
    const buffer = { duration: 5 } as AudioBuffer;
    await engine.play([{ id: 'a', buffer, start: 0, sourceStart: 0, duration: 5, gain: 1 }], 0, 5, {});
    expect(engine.isPlaying()).toBe(true);
    ctx.advance(2);
    const p = engine.pause();
    expect(p).toBeCloseTo(2, 1);
    expect(engine.isPlaying()).toBe(false);
    expect(engine.isPaused()).toBe(true);
    await engine.seek(1);
    expect(engine.getPosition()).toBeCloseTo(1, 5);
    await engine.restart();
    expect(engine.isPlaying()).toBe(true);
    engine.stop();
    expect(engine.getPosition()).toBe(0);
    await engine.dispose();
    vi.useRealTimers();
  });
  it('skip clamps to boundaries', async () => {
    const ctx = makeContext();
    const engine = new PlaybackEngine(() => ctx as unknown as AudioContext);
    const buffer = { duration: 10 } as AudioBuffer;
    await engine.play([{ id: 'a', buffer, start: 0, sourceStart: 0, duration: 10, gain: 1 }], 0, 10, {});
    await engine.skip(100);
    expect(engine.getPosition()).toBe(10);
    await engine.skip(-100);
    expect(engine.getPosition()).toBe(0);
    await engine.dispose();
    vi.useRealTimers();
  });
  it('second play stops first (single playback engine)', async () => {
    const ctx = makeContext();
    const engine = new PlaybackEngine(() => ctx as unknown as AudioContext);
    const buffer = { duration: 5 } as AudioBuffer;
    await engine.play([{ id: 'a', buffer, start: 0, sourceStart: 0, duration: 5, gain: 1 }], 0, 5, {});
    await engine.play([{ id: 'b', buffer, start: 0, sourceStart: 0, duration: 5, gain: 1 }], 0, 5, {});
    expect(engine.isPlaying()).toBe(true);
    await engine.dispose();
    vi.useRealTimers();
  });
});
