import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkerRequest } from '../audio/dspJobs';
import { useProjectStore, type ProjectStore } from '../store/projectStore';
import { StudioPage } from './StudioPage';
import { buildSong } from '../test/songFixture';
import * as db from '../storage/db';

/**
 * The user's report: "when I turn on Human Voice it shows 0 % and waits for
 * ever". This is the exact flow — render the studio, seed a song, click the
 * Human Voice Processing switch — with a worker stub that executes the *real*
 * DSP job. It fails if the panel never leaves 0 %, never finishes, or never
 * enables Human Voice Mode once the stems exist.
 */
class ExecutingWorker {
  static instances: ExecutingWorker[] = [];
  listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(public url: URL, public options?: WorkerOptions) {
    ExecutingWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(request: WorkerRequest) {
    // Run the real job off the current tick, exactly like a worker would.
    setTimeout(async () => {
      const { executeJob } = await import('../audio/dspJobs');
      try {
        const outcome = executeJob(request, (progress, message) => {
          for (const listener of this.listeners.get('message') ?? []) {
            listener({ data: { id: request.id, progress, message } });
          }
        });
        for (const listener of this.listeners.get('message') ?? []) {
          listener({ data: { id: request.id, ok: true, data: outcome.data, result: outcome.result } });
        }
      } catch (error) {
        for (const listener of this.listeners.get('message') ?? []) {
          listener({ data: { id: request.id, ok: false, error: (error as Error).message } });
        }
      }
    }, 0);
  }

  terminate() {}
}

const realWorker = globalThis.Worker;

beforeEach(async () => {
  ExecutingWorker.instances = [];
  vi.resetModules();
  globalThis.Worker = ExecutingWorker as unknown as typeof Worker;
  await db.clearAll();
});

afterEach(() => {
  cleanup();
  globalThis.Worker = realWorker;
});

describe('turning on Human Voice Processing', () => {
  it('leaves 0 % immediately, reports real stages and finishes with stems', async () => {
    const ref: { current: ProjectStore | null } = { current: null };
    function Harness() {
      const store = useProjectStore();
      ref.current = store;
      return <StudioPage store={store} />;
    }
    render(<Harness />);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    const store = ref.current!;
    const song = buildSong(2, 22050, 330, 0);
    let trackId = '';
    await act(async () => {
      trackId = store.project.tracks[0].id;
      await store.addClip(trackId, song.mix, 'song.wav');
    });

    const user = userEvent.setup();
    const toggle = screen.getByRole('switch', { name: /Human Voice Processing/ });
    await user.click(toggle);

    // Something must be on screen straight away, and it must not be a bare
    // "Starting" that never changes.
    const seen = new Set<string>();
    const values = new Set<number>();
    const samples: string[] = [];
    const observe = () => {
      const bars = Array.from(document.querySelectorAll('[role="progressbar"]'));
      for (const bar of bars) {
        const label = bar.getAttribute('aria-label') ?? '';
        const value = Number(bar.getAttribute('aria-valuenow'));
        seen.add(label);
        values.add(value);
        const panel = bar.closest('section')?.getAttribute('aria-label') ?? '(top of page)';
        samples.push(`${value}% "${label}" @ ${panel}`);
      }
    };
    const poll = setInterval(observe, 8);

    await waitFor(() => {
      observe();
      const track = ref.current!.project.tracks.find((t) => t.id === trackId)!;
      expect(track.vocal.status).toBe('ready');
    }, { timeout: 120_000, interval: 60 });

    clearInterval(poll);
    observe();
    // The top-of-page bar and the vocal panel may report; no *other* panel may
    // show a progress bar for a job the user did not start there. The
    // Harmonization panel used to render an empty "0 %" bar during separation.
    const strayBars = [...new Set(samples.filter((line) => !/Human voice processing|\(top of page\)/.test(line)))];
    expect(strayBars).toEqual([]);
    // The vocal panel reported real stages, not a bare 0 % placeholder.
    const vocalStages = [...new Set(samples.filter((line) => line.includes('Human voice processing')))];
    expect(vocalStages.length).toBeGreaterThan(0);
    const track = ref.current!.project.tracks.find((t) => t.id === trackId)!;
    expect(track.vocal.error).toBeUndefined();
    expect(track.vocal.vocalAssetId).toBeTruthy();
    expect(track.vocal.instrumentalAssetId).toBeTruthy();

    // The progress bar really moved through named stages rather than sitting at 0.
    const labels = [...seen].filter(Boolean);
    expect(labels.length).toBeGreaterThan(0);
    expect([...values].some((v) => v > 0)).toBe(true);
    expect(labels.some((label) => /separat|analys|mask|rebuild|complete/i.test(label))).toBe(true);
    // And no bar was left on screen afterwards.
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
  }, 180_000);
});
