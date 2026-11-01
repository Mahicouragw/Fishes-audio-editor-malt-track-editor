import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WorkerRequest, WorkerResponse } from './dspJobs';
import { audioData } from './dsp';

/**
 * A stand-in for the browser's Worker that the runner talks to. It can be told
 * to succeed, fail, or stay completely silent — the three cases that used to
 * leave the UI on a progress bar at 0 % forever.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  static behaviour: 'ok' | 'error' | 'silent' | 'clone-error' = 'ok';
  listeners = new Map<string, Set<(event: unknown) => void>>();
  terminated = false;

  constructor(public url: URL, public options?: WorkerOptions) {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  postMessage(request: WorkerRequest) {
    if (this.terminated) throw new Error('Worker has been terminated');
    if (FakeWorker.behaviour === 'clone-error') throw new Error('could not be cloned');
    if (FakeWorker.behaviour === 'silent') return;
    if (FakeWorker.behaviour === 'error') {
      setTimeout(() => this.dispatch('error', { message: 'the worker crashed' }), 0);
      return;
    }
    setTimeout(() => {
      this.dispatch('message', { data: { id: request.id, progress: 0.5, message: 'halfway' } as WorkerResponse });
      this.dispatch('message', {
        data: { id: request.id, ok: true, data: audioData([new Float32Array(8)], 8000) } as WorkerResponse,
      });
    }, 0);
  }

  terminate() {
    this.terminated = true;
  }
}

const source = audioData([new Float32Array(16)], 8000);

async function loadRunner() {
  vi.resetModules();
  return import('./dspRunner');
}

beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.behaviour = 'ok';
  vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DSP job runner over the real worker path', () => {
  it('delivers progress and the result', async () => {
    const { runDspJob } = await loadRunner();
    const events: string[] = [];
    const outcome = await runDspJob(
      { kind: 'gain', data: source, gain: 2 },
      (p, m) => events.push(`${p}:${m}`),
    );
    expect(events).toEqual(['0.5:halfway']);
    expect(outcome.data?.length).toBe(8);
  });

  it('rejects instead of hanging when the worker reports an error', async () => {
    FakeWorker.behaviour = 'error';
    const { runDspJob } = await loadRunner();
    await expect(runDspJob({ kind: 'gain', data: source, gain: 1 })).rejects.toThrow(/worker|crash/i);
  });

  it('rejects instead of hanging when the worker never answers', async () => {
    FakeWorker.behaviour = 'silent';
    const { runDspJob } = await loadRunner();
    await expect(
      runDspJob({ kind: 'gain', data: source, gain: 1 }, undefined, { idleTimeoutMs: 40 }),
    ).rejects.toThrow(/stopped responding/i);
  });

  it('still runs the job when the message cannot be cloned to the worker', async () => {
    FakeWorker.behaviour = 'clone-error';
    const { runDspJob } = await loadRunner();
    const outcome = await runDspJob({ kind: 'gain', data: source, gain: 2 });
    expect(outcome.data?.length).toBe(16);
    expect(outcome.data?.channels[0][0]).toBe(0);
  });

  it('stops a job when the caller cancels it', async () => {
    FakeWorker.behaviour = 'silent';
    const { runDspJob } = await loadRunner();
    const controller = new AbortController();
    const started = runDspJob({ kind: 'gain', data: source, gain: 1 }, undefined, {
      idleTimeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(started).rejects.toThrow(/cancelled/i);
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });

  it('refuses to start a job that was already cancelled', async () => {
    const { runDspJob } = await loadRunner();
    const controller = new AbortController();
    controller.abort();
    await expect(
      runDspJob({ kind: 'gain', data: source, gain: 1 }, undefined, { signal: controller.signal }),
    ).rejects.toThrow(/cancelled/i);
  });

  it('falls back to the main thread when no worker can be created', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('blocked by CSP'); } });
    const { runDspJob } = await loadRunner();
    const outcome = await runDspJob({ kind: 'gain', data: source, gain: 2 });
    expect(outcome.data?.length).toBe(16);
  });
});
