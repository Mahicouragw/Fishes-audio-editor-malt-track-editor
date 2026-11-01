import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { WorkerRequest, WorkerResponse } from '../audio/dspJobs';
import { audioData } from '../audio/dsp';
import { useDsp } from '../audio/useDsp';

/**
 * The bug the user reported was a progress bar that never left 0 %. The DSP
 * jobs are covered by jobProgress.test.ts and the runner by dspRunner.test.ts;
 * this test covers the last link — that those events actually reach React state
 * and therefore the progress bar — and that a failure leaves the UI with a real
 * error instead of a busy bar that never finishes.
 */
class ScriptedWorker {
  static instances: ScriptedWorker[] = [];
  static script: 'manual' | 'fail' = 'manual';
  requests: WorkerRequest[] = [];
  listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(public url: URL, public options?: WorkerOptions) {
    ScriptedWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(request: WorkerRequest) {
    this.requests.push(request);
    if (ScriptedWorker.script === 'fail') {
      setTimeout(() => {
        for (const listener of this.listeners.get('error') ?? []) listener({ message: 'the worker crashed' });
      }, 0);
    }
  }

  /** Deliver one message as if it came from inside the worker thread. */
  emit(data: WorkerResponse) {
    for (const listener of this.listeners.get('message') ?? []) listener({ data });
  }

  terminate() {}
}

const realWorker = globalThis.Worker;

function Harness({ log }: { log: Array<{ busy: boolean; progress: number; message: string }> }) {
  const dsp = useDsp();
  log.push({ busy: dsp.busy, progress: dsp.progress, message: dsp.message });
  return (
    <div>
      <span data-testid="busy">{String(dsp.busy)}</span>
      <span data-testid="progress">{Math.round(dsp.progress * 100)}</span>
      <span data-testid="message">{dsp.message}</span>
      {dsp.busy && (
        <div role="progressbar" aria-valuenow={Math.round(dsp.progress * 100)} aria-label={dsp.message} />
      )}
      <button type="button" onClick={() => { void dsp.run({ kind: 'separate', data: audioData([new Float32Array(16)], 8000) }); }}>
        Run
      </button>
    </div>
  );
}

beforeEach(() => {
  ScriptedWorker.instances = [];
  ScriptedWorker.script = 'manual';
  vi.resetModules();
  globalThis.Worker = ScriptedWorker as unknown as typeof Worker;
});

afterEach(() => {
  cleanup();
  globalThis.Worker = realWorker;
});

describe('progress reaches the UI', () => {
  it('moves the bar off 0 % through real messages and finishes clean', async () => {
    const log: Array<{ busy: boolean; progress: number; message: string }> = [];
    render(<Harness log={log} />);
    act(() => { screen.getByRole('button', { name: 'Run' }).click(); });

    const worker = ScriptedWorker.instances[0];
    expect(worker).toBeDefined();
    const id = worker.requests[0].id;

    // The bar is on screen at 0 % the moment the job starts...
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByTestId('busy').textContent).toBe('true');

    // ...and every worker message must move it. Reaching the end of the audio
    // used to leave it at 0 % because no progress events were ever emitted.
    act(() => { worker.emit({ id, progress: 0.42, message: 'Separating vocals' } as WorkerResponse); });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByTestId('message').textContent).toBe('Separating vocals');

    act(() => { worker.emit({ id, progress: 1, message: 'Vocal isolation complete' } as WorkerResponse); });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');

    await act(async () => {
      worker.emit({ id, ok: true, data: audioData([new Float32Array(8)], 8000) } as WorkerResponse);
      await new Promise((r) => setTimeout(r, 10));
    });
    // Finished: the bar is gone again, not stuck busy at 0 %.
    expect(screen.getByTestId('busy').textContent).toBe('false');
    expect(screen.queryByRole('progressbar')).toBeNull();
    const seen = log.map((entry) => Math.round(entry.progress * 100));
    expect(Math.max(...seen)).toBeGreaterThan(0);
  });

  it('surfaces a worker crash as an error instead of a bar stuck at 0 %', async () => {
    ScriptedWorker.script = 'fail';
    const errors: string[] = [];
    function FailingHarness() {
      const dsp = useDsp();
      return (
        <div>
          <span data-testid="busy">{String(dsp.busy)}</span>
          <button
            type="button"
            onClick={() => { dsp.run({ kind: 'separate', data: audioData([new Float32Array(16)], 8000) }).catch((e: Error) => errors.push(e.message)); }}
          >
            Run
          </button>
        </div>
      );
    }
    render(<FailingHarness />);
    await act(async () => {
      screen.getByRole('button', { name: 'Run' }).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatch(/memory|failed/i);
    expect(screen.getByTestId('busy').textContent).toBe('false');
  });
});
