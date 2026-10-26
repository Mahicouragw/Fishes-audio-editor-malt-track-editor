import { useCallback, useRef, useState } from 'react';
import { runDspJob } from './dspRunner';
import type { JobOutcome, WorkerJob } from './dspJobs';
import type { ProgressFn } from './dsp';
import { terminateSharedWorker } from './sharedWorker';

export { terminateSharedWorker as terminateAudioWorker };

export interface DspState {
  busy: boolean;
  progress: number;
  message: string;
}

/**
 * React binding around the shared DSP job runner. The heavy lifting (Web
 * Worker with main-thread fallback, real progress reporting) lives in
 * dspRunner — this hook only mirrors job state into React so the UI can show
 * live progress bars, disable buttons while busy, and supersede stale jobs.
 */
export function useDsp() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const tokenRef = useRef(0);

  const run = useCallback(async <T extends JobOutcome = JobOutcome>(
    request: WorkerJob,
    options: { signal?: AbortSignal; onProgress?: ProgressFn } = {},
  ): Promise<T> => {
    const token = ++tokenRef.current;
    setBusy(true);
    setProgress(0);
    setMessage('Starting');
    try {
      const outcome = await runDspJob(request, (p, m) => {
        if (token === tokenRef.current) {
          setProgress(p);
          setMessage(m);
        }
        // Callers that own their own progress UI (vocal separation) get the
        // same events; a superseded job never reaches them.
        if (token === tokenRef.current) options.onProgress?.(p, m);
      }, { signal: options.signal });
      if (token !== tokenRef.current) throw new Error('Job cancelled');
      return outcome as T;
    } finally {
      if (token === tokenRef.current) {
        setBusy(false);
        setProgress(0);
        setMessage('');
      }
    }
  }, []);

  return { busy, progress, message, run };
}
