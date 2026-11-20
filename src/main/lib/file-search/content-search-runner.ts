/// <reference types="electron-vite/node" />
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { ContentSearchJob, FileContentMatch } from './content-search';
import workerPath from './content-search-worker?modulePath';

export type ContentSearchResult = {
  matches: FileContentMatch[];
  invalidRegex: boolean;
  /** The search hit its deadline; `matches` holds what it found before then. */
  timedOut: boolean;
};

/** A newer search from the same caller replaced this one before it finished. */
export class ContentSearchSuperseded extends Error {
  override name = 'ContentSearchSuperseded';
}

type RunnerDeps = { workerSource?: string; deadlineMs?: number };

// Long enough for a full walk of a large repo; it only exists to end a runaway regex.
const DEADLINE_MS = 30_000;
const running = new Map<string, () => void>();
let bundledSource: string | undefined;

/** The worker's code. It starts from this text, read through Electron's asar-aware fs, so it never
 * needs worker_threads to open a path inside app.asar (electron#22446). Tests set `read`. */
export const bundledWorker = {
  read: (): string => (bundledSource ??= readFileSync(workerPath, 'utf8')),
};

type WorkerMessage =
  | { type: 'matches'; matches: FileContentMatch[] }
  | { type: 'done'; invalidRegex: boolean };

/**
 * Run one find-in-files search on a worker thread. A new search with the same `searchKey`
 * stops the earlier one, whose call rejects with ContentSearchSuperseded.
 */
export function runContentSearch(
  searchKey: string | undefined,
  job: ContentSearchJob,
  deps: RunnerDeps = {},
): Promise<ContentSearchResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(deps.workerSource ?? bundledWorker.read(), {
      eval: true,
      workerData: job,
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    const matches: FileContentMatch[] = [];
    let settled = false;

    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (searchKey !== undefined && running.get(searchKey) === supersede)
        running.delete(searchKey);
      void worker.terminate();
      settle();
    };
    const supersede = () =>
      finish(() => reject(new ContentSearchSuperseded('Replaced by a newer search')));
    const timer = setTimeout(
      () => finish(() => resolve({ matches, invalidRegex: false, timedOut: true })),
      deps.deadlineMs ?? DEADLINE_MS,
    );

    if (searchKey !== undefined) {
      running.get(searchKey)?.();
      running.set(searchKey, supersede);
    }

    worker.on('message', (message: WorkerMessage) => {
      if (settled) return;
      if (message.type === 'matches') {
        matches.push(...message.matches);
        return;
      }
      finish(() => resolve({ matches, invalidRegex: message.invalidRegex, timedOut: false }));
    });
    worker.on('error', (error) => finish(() => reject(error)));
    worker.on('exit', () =>
      finish(() => reject(new Error('Content search stopped before it finished'))),
    );
  });
}
