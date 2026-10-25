let sharedWorker: Worker | null = null;

export function getSharedWorker(): Worker {
  if (!sharedWorker) {
    sharedWorker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  }
  return sharedWorker;
}

export function terminateSharedWorker(): void {
  sharedWorker?.terminate();
  sharedWorker = null;
}
