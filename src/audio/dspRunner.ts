import { executeJob, type JobOutcome, type WorkerJob, type WorkerRequest, type WorkerResponse } from './dspJobs';
import type { ProgressFn } from './dsp';
import { makeId } from '../types';
import { getSharedWorker } from './sharedWorker';

/**
 * Promise-based job runner. Uses the shared Web Worker when the environment
 * supports it (real browsers) and falls back to the main thread otherwise
 * (tests, old WebViews). Progress callbacks are always real DSP progress.
 */
export async function runDspJob(
  request: WorkerJob,
  onProgress?: ProgressFn,
): Promise<JobOutcome> {
  if (typeof Worker === 'undefined') {
    return executeJob(request, onProgress);
  }
  const worker = getSharedWorker();
  const id = makeId('job');
  return new Promise<JobOutcome>((resolve, reject) => {
    const handler = (event: MessageEvent<WorkerResponse>) => {
      const data = event.data;
      if (data.id !== id) return;
      if ('progress' in data) {
        if (typeof data.progress === 'number') onProgress?.(data.progress, data.message);
        return;
      }
      worker.removeEventListener('message', handler);
      if (data.ok) resolve({ data: data.data, result: data.result });
      else reject(new Error(data.error));
    };
    worker.addEventListener('message', handler);
    worker.postMessage({ ...request, id } as WorkerRequest);
  });
}
