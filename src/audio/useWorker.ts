import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkerRequest, WorkerResponse } from './worker';
import type { AudioData } from '../types';
import { makeId } from '../types';

let sharedWorker: Worker | null = null;

function getWorker(): Worker {
  if (sharedWorker) return sharedWorker;
  sharedWorker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  return sharedWorker;
}

export function useAudioWorker() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const pending = useRef<Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>>(new Map());

  useEffect(() => {
    const worker = getWorker();
    const handler = (event: MessageEvent<WorkerResponse>) => {
      const data = event.data as unknown as (WorkerResponse & { progress?: number; message?: string });
      if ('progress' in data && typeof (data as { progress?: number }).progress === 'number') {
        setProgress((data as { progress: number }).progress);
        setMessage((data as { message?: string }).message ?? '');
        return;
      }
      const entry = pending.current.get((data as { id: string }).id);
      if (!entry) return;
      pending.current.delete((data as { id: string }).id);
      if ((data as { ok: boolean }).ok) entry.resolve(data);
      else entry.reject(new Error((data as { ok: false; error: string }).error));
      if (pending.current.size === 0) {
        setBusy(false);
        setProgress(0);
        setMessage('');
      }
    };
    worker.addEventListener('message', handler);
    return () => worker.removeEventListener('message', handler);
  }, []);

  const run = useCallback(async <T,>(request: Omit<WorkerRequest, 'id'> & { id?: string }): Promise<T> => {
    const worker = getWorker();
    const id = request.id ?? makeId('job');
    setBusy(true);
    setProgress(0);
    setMessage('Starting');
    return new Promise<T>((resolve, reject) => {
      pending.current.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      worker.postMessage({ ...request, id });
    });
  }, []);

  const runAudio = useCallback(async (request: Omit<WorkerRequest, 'id'>): Promise<{ data: AudioData; result?: unknown }> => {
    const response = await run<{ data: AudioData; result?: unknown }>(request as WorkerRequest);
    const typed = response as { data?: AudioData; result?: unknown };
    if (!typed.data && typed.result && typeof typed.result === 'object' && 'vocal' in (typed.result as Record<string, unknown>)) {
      // separate returns vocal in result but also data
    }
    return typed as { data: AudioData; result?: unknown };
  }, [run]);

  return { busy, progress, message, run, runAudio };
}

export function terminateWorker() {
  sharedWorker?.terminate();
  sharedWorker = null;
}
