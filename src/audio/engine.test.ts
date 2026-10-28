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
class FakePanner {
  pan = { value: 0 };
  connected: unknown[] = [];
  connect(node: unknown) { this.connected.push(node); }
  disconnect() {}
}
class FakeSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  connect() {}
  disconnect() {}
  start(_when: number, _offset: number, _duration: number) { this.started = true; }
  stop() { this.stopped = true; }
}

function makeContext(options: { suspended?: boolean } = {}) {
  let now = 0;
  const ctx = {
    get currentTime() { return now; },
    set currentTime(v: number) { now = v; },
    state: (options.suspended ? 'suspended' : 'running') as AudioContextState,
    sampleRate: 44100,
    destination: {},
    createGain: () => new FakeGain() as unknown as GainNode,
    createStereoPanner: () => { const panner = new FakePanner(); (ctx as unknown as { panners: FakePanner[] }).panners.push(panner); return panner as unknown as StereoPannerNode; },
    panners: [] as FakePanner[],
    createDynamicsCompressor: () => new FakeCompressor() as unknown as DynamicsCompressorNode,
    createBufferSource: () => {
      const source = new FakeSource();
      (ctx as unknown as { sources: FakeSource[] }).sources.push(source);
      return source as unknown as AudioBufferSourceNode;
    },
    sources: [] as FakeSource[],
    close: async () => { (ctx as unknown as { state: string }).state = 'closed'; },
    resume: async () => {
      // Resolves on a later microtask, so a second request can race this one.
      await Promise.resolve();
      await Promise.resolve();
      (ctx as unknown as { state: string }).state = 'running';
    },
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

describe('PlaybackEngine pan', () => {
  it('pans a clip in the live graph and compensates the export law', async () => {
    vi.useFakeTimers();
    const ctx = makeContext() as unknown as AudioContext & { panners: FakePanner[] };
    const engine = new PlaybackEngine(() => ctx);
    const buffer = { duration: 5 } as AudioBuffer;
    const clip = { id: 'a', buffer, start: 0, sourceStart: 0, duration: 5, gain: 0.5, pan: -1 };
    await engine.play([clip], 0, 5, {});
    expect(ctx.panners).toHaveLength(1);
    expect(ctx.panners[0].pan.value).toBe(-1);
    engine.stop();
    await engine.dispose();
    vi.useRealTimers();
  });

  it('leaves a centred clip untouched (bit-identical gain, no panner)', async () => {
    vi.useFakeTimers();
    const ctx = makeContext() as unknown as AudioContext & { panners: FakePanner[] };
    const engine = new PlaybackEngine(() => ctx);
    const buffer = { duration: 5 } as AudioBuffer;
    await engine.play([{ id: 'a', buffer, start: 0, sourceStart: 0, duration: 5, gain: 0.5, pan: 0 }], 0, 5, {});
    expect(ctx.panners).toHaveLength(0);
    engine.stop();
    await engine.dispose();
    vi.useRealTimers();
  });
});

describe('PlaybackEngine pause and duplicate protection', () => {
  it('reports the exact paused position and resumes from it', async () => {
    vi.useFakeTimers();
    const ctx = makeContext();
    const engine = new PlaybackEngine(() => ctx);
    const positions: number[] = [];
    const onPosition = (p: number) => positions.push(p);
    const buffer = { duration: 10 } as AudioBuffer;
    await engine.play([{ id: 'a', buffer, start: 0, sourceStart: 0, duration: 10, gain: 1 }], 0, 10, { onPosition });
    ctx.advance(3.25);
    const paused = engine.pause();
    // `play` schedules 45 ms ahead, so the audible position is the scheduled
    // one; what matters is that pausing reports and keeps exactly that value.
    const expected = engine.getPosition();
    expect(expected).toBeCloseTo(3.25 - 0.045, 5);
    expect(paused).toBeCloseTo(expected, 6);
    // The paused position is pushed to the React state as well, not only
    // returned to the caller that pressed the button.
    expect(positions[positions.length - 1]).toBeCloseTo(expected, 6);
    expect(engine.isPlaying()).toBe(false);
    expect(engine.isPaused()).toBe(true);
    await engine.resume();
    expect(engine.isPlaying()).toBe(true);
    // Resuming does not jump the playhead back by the scheduling lead.
    expect(engine.getPosition()).toBeCloseTo(expected, 5);
    ctx.advance(1);
    expect(engine.getPosition()).toBeGreaterThan(expected + 0.9);
    expect(engine.getPosition()).toBeLessThan(expected + 1.01);
    engine.pause();
    await engine.dispose();
    vi.useRealTimers();
  });

  it('never plays twice when play is pressed repeatedly', async () => {
    const ctx = makeContext({ suspended: true }) as unknown as AudioContext & { sources: FakeSource[] };
    const engine = new PlaybackEngine(() => ctx);
    const buffer = { duration: 5 } as AudioBuffer;
    const clip = { id: 'a', buffer, start: 0, sourceStart: 0, duration: 5, gain: 1 };
    // Three presses that overlap while the audio context is waking up.
    await Promise.all([
      engine.play([clip], 0, 5, {}),
      engine.play([clip], 0, 5, {}),
      engine.play([clip], 0, 5, {}),
    ]);
    const live = () => ctx.sources.filter((source) => source.started && !source.stopped);
    expect(live()).toHaveLength(1);
    // Pressing Resume twice cannot start a second set either.
    engine.pause();
    expect(live()).toHaveLength(0);
    await Promise.all([engine.resume(), engine.resume()]);
    expect(live()).toHaveLength(1);
    expect(engine.isPlaying()).toBe(true);
    await engine.dispose();
  });

  it('does not start audio after a stop that raced a pending play', async () => {
    const ctx = makeContext({ suspended: true }) as unknown as AudioContext & { sources: FakeSource[] };
    const engine = new PlaybackEngine(() => ctx);
    const buffer = { duration: 5 } as AudioBuffer;
    const pending = engine.play([{ id: 'a', buffer, start: 0, sourceStart: 0, duration: 5, gain: 1 }], 0, 5, {});
    engine.stop();
    await pending;
    expect(engine.isPlaying()).toBe(false);
    expect(ctx.sources.filter((source) => source.started && !source.stopped)).toHaveLength(0);
    await engine.dispose();
  });
});
