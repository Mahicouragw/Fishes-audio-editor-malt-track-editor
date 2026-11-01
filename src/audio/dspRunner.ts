import { executeJob, type JobOutcome, type WorkerJob, type WorkerRequest, type WorkerResponse } from './dspJobs';
import type { ProgressFn } from './dsp';
import { makeId } from '../types';
import { getSharedWorker, terminateSharedWorker } from './sharedWorker';

/**
 * How long a job may run without sending a single message before it is treated
 * as dead. Real progress arrives several times a second while audio is being
 * rendered, so a silent job is a stalled worker (a crash, an out-of-memory
 * kill, or a module that never loaded) — never a slow one.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export interface DspRunOptions {
  /** Override the no-message watchdog (tests use a short one). */
  idleTimeoutMs?: number;
  /** Force the synchronous main-thread path (used by tests and fallbacks). */
  forceMainThread?: boolean;
  /**
   * Cancel the job. The worker is terminated (a synchronous JS loop cannot be
   * interrupted any other way) and the promise rejects, so a long render can
   * always be stopped by the user instead of requiring a page reload.
   */
  signal?: AbortSignal;
}

/** Run a job synchronously on the main thread. */
function runOnMainThread(request: WorkerJob, onProgress?: ProgressFn): Promise<JobOutcome> {
  return Promise.resolve().then(() => executeJob(request, onProgress));
}

/**
 * Promise-based job runner.
 *
 * Real browsers run every job in the shared Web Worker; tests and old WebViews
 * run the identical code on the main thread. Three failures used to leave the
 * UI stuck on a progress bar at 0 % forever, with no error and no way out:
 *
 *  - the worker module failing to load (no `onmessage`, so no reply ever came),
 *  - the worker crashing or being killed mid-job (e.g. out of memory on a
 *    tablet), and
 *  - `postMessage` throwing because the payload could not be cloned.
 *
 * Each of those is now turned into a settled promise: a failed start falls back
 * to the main thread, and a mid-job failure or a stretch of total silence
 * rejects with a message the UI can show. A worker that dies is discarded, so
 * the next job gets a fresh one.
 */
export async function runDspJob(
  request: WorkerJob,
  onProgress?: ProgressFn,
  options: DspRunOptions = {},
): Promise<JobOutcome> {
  if (options.forceMainThread || typeof Worker === 'undefined') {
    return runOnMainThread(request, onProgress);
  }
  if (options.signal?.aborted) throw new Error('Processing cancelled');

  let worker: Worker;
  try {
    worker = getSharedWorker();
  } catch (error) {
    // No worker at all in this environment (blocked by CSP, unsupported, out of
    // threads). The job must still run rather than hang.
    console.warn('Audio worker unavailable, processing on the main thread:', (error as Error).message);
    return runOnMainThread(request, onProgress);
  }

  const id = makeId('job');
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  return new Promise<JobOutcome>((resolve, reject) => {
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const signal = options.signal;

    const cleanup = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = null;
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      worker.removeEventListener('messageerror', handleMessageError);
      signal?.removeEventListener('abort', handleAbort);
    };

    const finish = (outcome: JobOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    /** Restart the watchdog; called on every message from this job. */
    const arm = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        // A worker that never answered is broken: discard it so the next job
        // starts clean instead of queueing behind a dead thread.
        terminateSharedWorker();
        fail(new Error(
          'Audio processing stopped responding. The browser may have run out of memory — '
          + 'try a shorter selection, close other tabs, or reload the page.',
        ));
      }, idleTimeoutMs);
    };

    function handleMessage(event: MessageEvent<WorkerResponse>) {
      const data = event.data;
      if (!data || data.id !== id) return;
      arm();
      if ('progress' in data) {
        if (typeof data.progress === 'number') onProgress?.(data.progress, data.message);
        return;
      }
      if (data.ok) finish({ data: data.data, result: data.result });
      else fail(new Error(data.error || 'Audio processing failed'));
    }

    function handleError(event: ErrorEvent) {
      // A worker-level error means the module or the job itself blew up outside
      // the job's own try/catch — most often the browser killed the worker for
      // running out of memory. Report it instead of waiting forever, and throw
      // the worker away so the next job starts on a clean thread. Re-running a
      // crashed job on the main thread is deliberately *not* attempted: the
      // same allocation would then freeze (or crash) the whole page.
      event.preventDefault?.();
      terminateSharedWorker();
      const detail = event.message ? `: ${event.message}` : '';
      fail(new Error(`Audio processing failed${detail}. This can happen when the browser is low on memory — try a shorter selection or close other tabs.`));
    }

    function handleAbort() {
      // Terminating the shared worker is the only way to stop a synchronous
      // DSP loop. The next job creates a fresh worker.
      terminateSharedWorker();
      fail(new Error('Processing cancelled'));
    }

    function handleMessageError() {
      terminateSharedWorker();
      fail(new Error('Audio processing failed: the job result could not be transferred'));
    }

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);
    worker.addEventListener('messageerror', handleMessageError);
    signal?.addEventListener('abort', handleAbort, { once: true });
    arm();

    try {
      worker.postMessage({ ...request, id } as WorkerRequest);
    } catch (error) {
      cleanup();
      settled = true;
      // Structured-clone failures (and a worker that was terminated between
      // calls) are recoverable: run the job synchronously instead.
      console.warn('Could not send the job to the worker, running it here:', (error as Error).message);
      void runOnMainThread(request, onProgress).then(resolve, reject);
    }
  });
}
