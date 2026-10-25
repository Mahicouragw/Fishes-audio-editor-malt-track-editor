import { executeJob, type WorkerRequest, type WorkerResponse } from './dspJobs';

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const progress: (p: number, m: string) => void = (p, m) => {
    ctx.postMessage({ id: request.id, progress: p, message: m } satisfies WorkerResponse);
  };
  try {
    const outcome = executeJob(request, progress);
    ctx.postMessage({ id: request.id, ok: true, data: outcome.data, result: outcome.result } satisfies WorkerResponse);
  } catch (error) {
    ctx.postMessage({ id: request.id, ok: false, error: (error as Error).message } satisfies WorkerResponse);
  }
};
