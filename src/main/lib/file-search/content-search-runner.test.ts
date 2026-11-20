import { describe, expect, it } from 'vitest';
import type { ContentSearchJob } from './content-search';
import { ContentSearchSuperseded, runContentSearch } from './content-search-runner';

const JOB: ContentSearchJob = {
  rootPath: '/unused',
  query: 'x',
  matchCase: false,
  wholeWord: false,
  useRegex: false,
  limit: 10,
  include: [],
  exclude: [],
};

const PORT = "const { parentPort } = require('node:worker_threads');";
const MATCH =
  "{ id: 'm', filePath: 'a.ts', lineNumber: 1, startColumn: 1, endColumn: 2, lineText: 'a' }";
const done = (afterMs: number) =>
  `${PORT} setTimeout(() => parentPort.postMessage({ type: 'done', invalidRegex: false }), ${afterMs});`;

describe('runContentSearch', () => {
  it('stops a runaway regex at the deadline, keeps earlier matches, and leaves main free', async () => {
    const redos = `${PORT}
      parentPort.postMessage({ type: 'matches', matches: [${MATCH}] });
      setTimeout(() => { /(a+)+$/.test('a'.repeat(60) + 'b'); parentPort.postMessage({ type: 'done', invalidRegex: false }); }, 20);`;
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 10);

    const result = await runContentSearch(undefined, JOB, { workerSource: redos, deadlineMs: 300 });
    clearInterval(ticker);

    expect(result).toMatchObject({ timedOut: true, invalidRegex: false });
    expect(result.matches).toHaveLength(1);
    expect(ticks).toBeGreaterThan(5);
  });

  it('rejects the older search when a newer one starts with the same key', async () => {
    const older = runContentSearch('pane-1', JOB, { workerSource: done(5000) });
    const newer = runContentSearch('pane-1', JOB, { workerSource: done(10) });

    await expect(older).rejects.toBeInstanceOf(ContentSearchSuperseded);
    await expect(newer).resolves.toMatchObject({ timedOut: false, matches: [] });
  });

  it('lets searches with different keys run side by side', async () => {
    const results = await Promise.all([
      runContentSearch('pane-1', JOB, { workerSource: done(50) }),
      runContentSearch('pane-2', JOB, { workerSource: done(10) }),
    ]);

    expect(results.map((r) => r.timedOut)).toEqual([false, false]);
  });

  it('rejects when the worker exits without finishing', async () => {
    const quits = `${PORT} process.exit(0);`;

    await expect(runContentSearch(undefined, JOB, { workerSource: quits })).rejects.toThrow(
      'stopped before it finished',
    );
  });
});
