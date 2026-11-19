import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  noteTaskGroupsNow,
  reapAllTaskGroupsSync,
  reapStoppedTaskGroups,
  trackAgentProcess,
  trackClaudeCli,
} from '.';
import { confirmedWriterGroups, groupsToSignal, processReaders } from './task-group-reaper';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;
const row = (pid: number, pgid: number, start = 's') => ({ pid, ppid: 1, pgid, start });

describe('groupsToSignal', () => {
  it('skips a group whose noted processes are gone, even if its id is in use again', () => {
    const recorded = new Map([[500, new Set(['501@old'])]]);
    expect(groupsToSignal(recorded, [row(501, 500, 'new')], new Set())).toEqual([]);
    expect(groupsToSignal(recorded, [row(501, 500, 'old')], new Set())).toEqual([500]);
  });

  it('records no group a reused writer pid now names, and reads again only outside confirmed groups', () => {
    const before = [row(10, 10, 'old'), row(11, 11, 'same')];
    const after = [
      row(10, 77, 'new'),
      row(11, 11, 'same'),
      row(14, 11, 'late'),
      row(13, 13, 'late'),
    ];

    const { groups, unconfirmed } = confirmedWriterGroups(new Set([10, 11, 13, 14]), before, after);

    expect([...groups.keys()]).toEqual([11]);
    expect([...(groups.get(11) ?? [])]).toEqual(['11@same', '14@late']);
    expect(unconfirmed).toBe(2);
  });

  it("never signals Frink's own group or pgid 1", () => {
    const recorded = new Map([
      [1, new Set(['2@s'])],
      [700, new Set(['700@s'])],
    ]);
    expect(groupsToSignal(recorded, [row(2, 1), row(700, 700)], new Set([700]))).toEqual([]);
  });
});

// A fake CLI whose task shell (own group, stdout on tasks/t1.output) starts a nested process in a
// group of its own: a child, a double-forked orphan writing to the output, or one ignoring SIGTERM.
const NESTED = {
  child: `spawn('sleep', ['600'], { detached: true, stdio: 'ignore' }).pid`,
  orphan: `(() => {
    spawn(process.execPath, ['-e', "const n = require('child_process').spawn('sleep', ['600'], { detached: true, stdio: ['ignore', 'ignore', 'inherit'] }); require('fs').writeFileSync(process.env.TASK_DIR + '/nested', String(n.pid)); n.unref();"], { stdio: 'inherit' });
    return 0;
  })()`,
  stubborn: `spawn('sh', ['-c', "trap '' TERM; while :; do sleep 1; done"], { detached: true, stdio: 'ignore' }).pid`,
};

const fakeCli = (nested: string) => `
const { spawn } = require('child_process');
const fs = require('fs');
const dir = process.env.TASK_DIR;
const out = fs.openSync(dir + '/tasks/t1.output', 'w');
spawn(process.execPath, ['-e', \`
  const { spawn } = require('child_process');
  const fs = require('fs');
  if (fs.existsSync('\${dir}/end')) process.exit(0);
  const nested = ${nested.replaceAll('`', '\\`')};
  if (nested) fs.writeFileSync('\${dir}/nested', String(nested));
  fs.writeFileSync('\${dir}/shell', String(process.pid));
  setInterval(() => { if (fs.existsSync('\${dir}/end')) process.exit(0); }, 50);
\`], { detached: true, stdio: ['ignore', out, out], env: process.env });
if (process.env.EXIT_ON_EOF) process.stdin.on('end', () => process.exit(0)).resume();
setInterval(() => {}, 1e6);
`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const started: number[] = [];
const fixtureDirs: string[] = [];

async function startCli(
  nested: keyof typeof NESTED = 'child',
  options: { exitOnEof?: boolean; track?: typeof trackClaudeCli } = {},
): Promise<{ cli: ChildProcess; dir: string; shell: number; nested: number }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-groups-'));
  fs.mkdirSync(path.join(dir, 'tasks'));
  fixtureDirs.push(dir);
  const cli = spawn(process.execPath, ['-e', fakeCli(NESTED[nested])], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      TASK_DIR: dir,
      ...(options.exitOnEof && { EXIT_ON_EOF: '1' }),
    },
    stdio: [options.exitOnEof ? 'pipe' : 'ignore', 'ignore', 'ignore'],
  });
  (options.track ?? trackClaudeCli)(cli);
  // Registered at once, so a start that times out is still cleaned up. Never pid 0: killing it
  // would signal the test runner's own process group.
  if (cli.pid !== undefined) started.push(cli.pid);
  const pids = () => ({ shell: readPid(dir, 'shell'), nested: readPid(dir, 'nested') });
  try {
    await until(() => pids().shell !== undefined && pids().nested !== undefined);
  } finally {
    for (const pid of Object.values(pids())) if (pid !== undefined) started.push(pid);
  }
  const { shell, nested: nestedPid } = pids();
  if (shell === undefined || nestedPid === undefined) throw new Error('fixture pid files vanished');
  return { cli, dir, shell, nested: nestedPid };
}

/** The pid a fixture file holds, once fully written. */
function readPid(dir: string, name: string): number | undefined {
  const file = path.join(dir, name);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return /^[1-9]\d*$/.test(text) ? Number(text) : undefined;
}

afterEach(() => {
  // A task shell that starts late sees this and exits before it starts anything.
  for (const dir of fixtureDirs.splice(0)) fs.writeFileSync(path.join(dir, 'end'), '');
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
});

posixOnly('task group reaping', () => {
  it('ends what a running task started in its own group once the CLI dies', async () => {
    const { cli, shell, nested } = await startCli();
    await noteTaskGroupsNow();

    cli.kill('SIGKILL');

    await until(() => !alive(nested) && !alive(shell));
  });

  it('leaves alone what a task that already ended started, like a daemon', async () => {
    const { cli, dir, shell, nested } = await startCli();
    await noteTaskGroupsNow();
    fs.writeFileSync(path.join(dir, 'end'), '');
    await until(() => !alive(shell));
    await noteTaskGroupsNow();

    cli.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(alive(nested)).toBe(true);
  });

  it('retries a task shell whose stdout could not be read, as under heavy load', async () => {
    const { cli, nested } = await startCli();
    vi.spyOn(processReaders, 'readStdoutPaths').mockResolvedValueOnce(new Map());
    await noteTaskGroupsNow();
    await noteTaskGroupsNow();

    cli.kill('SIGKILL');

    await until(() => !alive(nested));
  });

  it('checks again a task shell first read before its stdout pointed at its output', async () => {
    const { cli, nested } = await startCli();
    vi.spyOn(processReaders, 'readStdoutPaths').mockImplementationOnce(async (pids) => {
      return new Map(pids.map((pid) => [pid, 'pipe:[1]']));
    });
    await noteTaskGroupsNow();
    await noteTaskGroupsNow();

    cli.kill('SIGKILL');

    await until(() => !alive(nested));
  });

  it('ends a stopped task’s groups by its task id while the CLI runs on', async () => {
    const { cli, nested } = await startCli();
    await noteTaskGroupsNow();

    await reapStoppedTaskGroups('t1');

    expect(alive(nested)).toBe(false);
    expect(alive(cli.pid ?? 0)).toBe(true);
  });

  it('ends an orphaned process still writing to the task output when the session ends', async () => {
    const { cli, nested } = await startCli('orphan', { exitOnEof: true });
    // A poll links the task shell, but not the orphan: its parent is already gone.
    await noteTaskGroupsNow();

    // The session ends by closing the CLI's stdin.
    cli.stdin?.end();

    await until(() => !alive(nested));
  });

  it('ends what an ended task left writing to its output once the session ends', async () => {
    const { cli, dir, shell, nested } = await startCli('orphan', { exitOnEof: true });
    await noteTaskGroupsNow();
    fs.writeFileSync(path.join(dir, 'end'), '');
    await until(() => !alive(shell));
    await noteTaskGroupsNow();
    expect(alive(nested)).toBe(true);

    cli.stdin?.end();

    await until(() => !alive(nested));
  });

  it('still ends a stopped task’s groups when a poll saw its shell end first', async () => {
    const { dir, shell, nested } = await startCli();
    await noteTaskGroupsNow();
    fs.writeFileSync(path.join(dir, 'end'), '');
    await until(() => !alive(shell));
    await noteTaskGroupsNow();

    await reapStoppedTaskGroups('t1');

    expect(alive(nested)).toBe(false);
  });

  it('ends what a running command of a Codex, ACP or Cursor agent started once the agent exits', async () => {
    const { cli, shell, nested } = await startCli('child', { track: trackAgentProcess });
    await noteTaskGroupsNow();

    cli.kill('SIGKILL');

    await until(() => !alive(nested) && !alive(shell));
  });

  it('keeps a stopped task’s groups for the quit sweep while no process table can be read', async () => {
    const { nested } = await startCli();
    await noteTaskGroupsNow();
    const unreadable = vi.spyOn(processReaders, 'readProcessTable').mockResolvedValue(null);

    await reapStoppedTaskGroups('t1');
    expect(alive(nested)).toBe(true);
    unreadable.mockRestore();
    reapAllTaskGroupsSync();

    await until(() => !alive(nested), 1000);
  });

  it('ends at app quit what a stop had found while it was still reading writers', async () => {
    const { nested } = await startCli();
    await noteTaskGroupsNow();
    const reading = vi
      .spyOn(processReaders, 'readOutputWriters')
      .mockReturnValueOnce(new Promise(() => {}));

    void reapStoppedTaskGroups('t1');
    await until(() => reading.mock.calls.length > 0);
    reapAllTaskGroupsSync();

    await until(() => !alive(nested), 1000);
  });

  it('force-ends at app quit a group that ignored SIGTERM, without waiting out the grace', async () => {
    const { cli, nested } = await startCli('stubborn');
    await noteTaskGroupsNow();
    cli.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(nested)).toBe(true);

    expect(process.listeners('exit')).toContain(reapAllTaskGroupsSync);
    reapAllTaskGroupsSync();

    await until(() => !alive(nested), 1000);
  });
});
