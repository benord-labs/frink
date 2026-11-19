import { describe, expect, it } from 'vitest';
import {
  parseProcessTable,
  readOutputWriters,
  readProcessTable,
  readStdoutPaths,
  type RunFile,
} from './process-table';

const ROWS =
  '    1     0     1 Tue  3 Nov 09:50:40 2026    \n  357   1  357 Wed 18 Nov 18:42:22 2026\n\n';
const LSOF = 'p42\nf1\nn/t/tasks/a.output\n';
const ran =
  (failed: boolean, stopped: boolean, stdout: string): RunFile =>
  async () => ({ failed, stopped, stdout });

describe('parseProcessTable', () => {
  it('keeps the whole spaced start time, so a reused pid reads as a new process', () => {
    expect(parseProcessTable(ROWS)).toEqual([
      { pid: 1, ppid: 0, pgid: 1, start: 'Tue  3 Nov 09:50:40 2026' },
      { pid: 357, ppid: 1, pgid: 357, start: 'Wed 18 Nov 18:42:22 2026' },
    ]);
  });
});

describe('reading under load', () => {
  it('reports an unreadable table rather than a cut-off one when ps is stopped', async () => {
    expect(await readProcessTable(ran(true, true, ROWS))).toBeNull();
  });

  it.skipIf(process.platform !== 'darwin')(
    'returns no paths when lsof is stopped, but keeps them when it only skipped some pids',
    async () => {
      expect(await readStdoutPaths([42], ran(true, true, LSOF))).toEqual(new Map());
      expect(await readStdoutPaths([42], ran(true, false, LSOF))).toEqual(
        new Map([[42, '/t/tasks/a.output']]),
      );
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'says it could not tell who writes to the task outputs when lsof is stopped',
    async () => {
      const stdout = 'p7\nf2\nn/s/tasks/a.output\np8\nf1\nn/s/tasks/deeper/b.output\n';
      expect(await readOutputWriters('/s/tasks', [], ran(true, true, stdout))).toBeNull();
      expect(await readOutputWriters('/s/tasks', [], ran(true, false, stdout))).toEqual([
        { pid: 7, path: '/s/tasks/a.output' },
      ]);
    },
  );
});
