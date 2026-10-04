import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHookCommand } from './index';

type Run = Parameters<typeof runHookCommand>[0];

// Hooks get a constructed environment, never the test process's own.
const ENV = { PATH: '/usr/bin:/bin' };
const SLOW = 20_000;
/** The characters the runner keeps of each output stream. */
const KEPT = 4 * 1024 * 1024;

// Three different directories, so a hook that starts in the wrong one shows.
let root: string;
let session: string;
let worktree: string;
/** One file per process group a long hook started, named by its id. */
let groups: string;
let ready: string;

function input(extra: Partial<PreToolUseHookInput> = {}): PreToolUseHookInput {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'session-1',
    transcript_path: '/dev/null',
    cwd: worktree,
    tool_name: 'Bash',
    tool_input: { command: 'true' },
    tool_use_id: 'toolu_1',
    ...extra,
  };
}

function run(fields: Partial<Run> & Pick<Run, 'command'>) {
  return runHookCommand({
    input: input(),
    cwd: session,
    sessionCwd: session,
    projectRoot: root,
    env: ENV,
    signal: new AbortController().signal,
    ...fields,
  });
}

async function writeScript(name: string, body: string): Promise<string> {
  const file = path.join(root, name);
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Records the hook's process group, so a failing test leaves nothing running. */
function tracked(command: string): string {
  return `: > "${groups}/$$"; ${command}`;
}

function killGroup(id: number): void {
  try {
    // Ids 0 and 1 would address this process's own group or every process.
    if (id > 1) process.kill(-id, 'SIGKILL');
  } catch {
    // The group has already gone.
  }
}

/** Starts a hook, waits until it has created the `ready` file, then aborts it. */
async function abortWhenReady(fields: Parameters<typeof run>[0]) {
  const controller = new AbortController();
  const pending = run({ ...fields, signal: controller.signal });
  await vi.waitFor(() => fs.access(ready), { timeout: SLOW });
  controller.abort();
  return pending;
}

/** Fails when the work raises an uncaught exception here; always removes its listener. */
async function withoutUncaught<T>(work: () => Promise<T>): Promise<T> {
  const uncaught = vi.fn();
  process.on('uncaughtException', uncaught);
  const result = await work().finally(() => process.off('uncaughtException', uncaught));
  expect(uncaught).not.toHaveBeenCalled();
  return result;
}

beforeEach(async () => {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'run-command-')));
  root = path.join(tmp, 'my project');
  session = path.join(tmp, 'session');
  worktree = path.join(tmp, 'worktree');
  groups = path.join(tmp, 'groups');
  ready = path.join(tmp, 'ready');
  await Promise.all([root, session, worktree, groups].map((dir) => fs.mkdir(dir)));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const id of await fs.readdir(groups)) killGroup(Number(id));
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

describe('runHookCommand', () => {
  it('writes the input as one JSON line to stdin, then closes it', async () => {
    const result = await run({ command: 'cat' });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.stdout).toBe(`${JSON.stringify(input())}\n`);
  });

  it('starts the hook in the given directory, whatever `cwd` its input carries', async () => {
    const result = await run({ command: 'cat; pwd -P', cwd: root });
    expect(result.stdout).toBe(`${JSON.stringify(input())}\n${root}\n`);
  });

  it('falls back to the session cwd, then the project root, when the directory is gone', async () => {
    const gone = path.join(session, 'gone');
    expect((await run({ command: 'pwd -P', cwd: gone })).stdout).toBe(`${session}\n`);
    // A path that exists but is a file is no directory to start in either.
    const file = path.join(session, 'a-file');
    await fs.writeFile(file, '');
    expect((await run({ command: 'pwd -P', cwd: file })).stdout).toBe(`${session}\n`);
    const last = await run({ command: 'pwd -P', cwd: gone, sessionCwd: gone });
    expect(last.stdout).toBe(`${root}\n`);
  });

  it('gives the hook the given environment without OTEL_*, plus Claude variables', async () => {
    vi.stubEnv('FRINK_TEST_PARENT_ONLY', 'parent');
    const result = await run({
      command:
        'printf "%s|%s|%s|%s|%s|%s" "$CLAUDE_PROJECT_DIR" "$CLAUDE_EFFORT" "$GIVEN" "${FRINK_TEST_PARENT_ONLY-unset}" "${OTEL_EXPORTER_OTLP_ENDPOINT-unset}" "$PATH"',
      input: input({ effort: { level: 'high' } }),
      env: {
        ...ENV,
        GIVEN: 'given',
        CLAUDE_PROJECT_DIR: '/stale',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      },
    });
    // A login shell, or a runner that passes its own PATH on, would print a longer PATH.
    // Compared as a boolean so a failure never prints the machine's real PATH.
    expect(result.stdout === `${root}|high|given|unset|unset|${ENV.PATH}`).toBe(true);
  });

  it('gives an exec-form hook the same stdin, start directory and environment', async () => {
    vi.stubEnv('FRINK_TEST_PARENT_ONLY', 'parent');
    const script =
      'cat; pwd -P; printf "%s|%s|%s" "$CLAUDE_PROJECT_DIR" "$PATH" "${FRINK_TEST_PARENT_ONLY-unset}"';
    const result = await run({ command: 'sh', args: ['-c', script] });
    const stdin = `${JSON.stringify(input())}\n`;
    expect(result.stdout === `${stdin}${session}\n${root}|${ENV.PATH}|unset`).toBe(true);
  });

  it('runs a script under a root with spaces in both forms', async () => {
    await writeScript('hook script.sh', 'printf "[%s]" "$@"');
    const shell = await run({ command: '"$CLAUDE_PROJECT_DIR"/"hook script.sh" one' });
    expect(shell).toMatchObject({ exitCode: 0, stdout: '[one]' });
    const exec = await run({
      command: '${CLAUDE_PROJECT_DIR}/hook script.sh',
      args: [
        '${CLAUDE_PROJECT_DIR}/a b',
        '${CLAUDE_PROJECT_DIR}:${CLAUDE_PROJECT_DIR}',
        '$CLAUDE_PROJECT_DIR',
      ],
    });
    const stdout = `[${root}/a b][${root}:${root}][$CLAUDE_PROJECT_DIR]`;
    expect(exec).toMatchObject({ exitCode: 0, stdout });
  });

  it('passes exec-form arguments verbatim, with no shell', async () => {
    const script = await writeScript('args.sh', 'printf "[%s]" "$@"');
    const args = ['$HOME', '`id`', "it's", 'a  b', '*', '&& echo no'];
    const result = await run({ command: script, args });
    expect(result.stdout).toBe(args.map((arg) => `[${arg}]`).join(''));
    expect((await run({ command: 'printf', args: ['%s', 'on PATH'] })).stdout).toBe('on PATH');
  });

  it('runs shell form through /bin/sh, so pipes, expansion and redirects work', async () => {
    const result = await run({ command: 'echo "$0"; echo one | tr a-z A-Z && echo $((1+2)) >&2' });
    expect(result).toMatchObject({ exitCode: 0, stdout: '/bin/sh\nONE\n', stderr: '3\n' });
  });

  it.each([0, 1, 2])('reports exit code %i with stdout and stderr', async (code) => {
    const result = await run({ command: `echo out; echo err >&2; exit ${code}` });
    expect(result).toEqual({
      exitCode: code,
      signal: null,
      stdout: 'out\n',
      stderr: 'err\n',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
    });
  });

  it.each([0, 1e7])('lets a quick hook finish when timeoutSec is %d', async (timeoutSec) => {
    const result = await run({ command: 'sleep 0.2; echo done', timeoutSec });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'done\n', timedOut: false });
  });

  it('ignores a hook that exits without reading a large input', async () => {
    const big = input({ tool_input: { command: 'x'.repeat(2_000_000) } });
    const result = await withoutUncaught(() => run({ command: 'exit 0', input: big }));
    expect(result).toMatchObject({ exitCode: 0 });
  });

  it('reports a program that cannot start instead of throwing', async () => {
    const exec = await run({ command: path.join(root, 'missing'), args: [] });
    expect(exec).toMatchObject({ exitCode: null, startError: expect.stringContaining('ENOENT') });
    // In shell form the shell starts and reports the missing program itself.
    const shell = await run({ command: '"$CLAUDE_PROJECT_DIR"/missing' });
    expect(shell.exitCode).toBe(127);
    expect(shell.startError).toBeUndefined();
  });

  it('refuses a plugin placeholder, which only a plugin hook can use', async () => {
    const exec = await run({ command: 'printf', args: ['${CLAUDE_PLUGIN_ROOT}/x'] });
    const startError = expect.stringContaining('${CLAUDE_PLUGIN_ROOT}');
    expect(exec).toMatchObject({ exitCode: null, stdout: '', startError });
    const shell = await run({ command: 'echo "${CLAUDE_PLUGIN_DATA}"' });
    expect(shell).toMatchObject({ exitCode: null, stdout: '' });
    expect(shell.startError).toContain('${CLAUDE_PLUGIN_DATA}');
  });

  it('waits for output written after the hook itself has exited', async () => {
    const result = await run({ command: '(sleep 0.3; echo late) & echo early' });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'early\nlate\n', timedOut: false });
  });

  it.each(['shell', 'exec'])(
    'stops a hook in %s form at its timeout',
    async (form) => {
      const command = tracked('sleep 60');
      const fields = form === 'shell' ? { command } : { command: 'sh', args: ['-c', command] };
      const result = await run({ ...fields, timeoutSec: 1 });
      expect(result).toMatchObject({ timedOut: true, exitCode: null, signal: 'SIGTERM' });
    },
    SLOW,
  );

  it(
    'stops a child of the hook that ignores SIGTERM',
    async () => {
      // The child reports its pid only once it ignores SIGTERM.
      const child = `trap "" TERM; echo $$ > "${ready}.tmp"; mv "${ready}.tmp" "${ready}"; exec sleep 60`;
      const result = await abortWhenReady({
        command: tracked(`sh -c '${child}' >/dev/null 2>&1 & wait`),
      });
      expect(result).toMatchObject({ timedOut: false, exitCode: null, signal: 'SIGTERM' });
      const pid = Number(await fs.readFile(ready, 'utf8'));
      await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: SLOW });
    },
    SLOW,
  );

  it(
    'reports a timeout when a child holds the output after the hook exits 0',
    async () => {
      // Generous: the shell only has to start the child and exit before the timeout.
      const result = await run({ command: tracked('sleep 60 & exit 0'), timeoutSec: 3 });
      expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: true });
    },
    SLOW,
  );

  it(
    'stops waiting for a descendant that left the group and holds the output',
    async () => {
      const script = `const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const [groups, ready] = process.argv.slice(1);
        const held = spawn('sleep', ['60'], { detached: true, stdio: 'inherit' });
        for (const id of [process.pid, held.pid]) writeFileSync(groups + '/' + id, '');
        console.log('held');
        writeFileSync(ready, '');
        setInterval(() => {}, 1000);`;
      const args = ['-e', script, groups, ready];
      const result = await abortWhenReady({ command: process.execPath, args });
      // The runner does not chase a process outside the group; the cleanup stops it.
      expect(result).toMatchObject({ timedOut: false, signal: 'SIGTERM', stdout: 'held\n' });
    },
    SLOW,
  );

  it(
    'kills a hook that ignores SIGTERM',
    async () => {
      const command = tracked(`trap '' TERM; touch "${ready}"; sleep 60`);
      expect(await abortWhenReady({ command })).toMatchObject({
        timedOut: false,
        signal: 'SIGKILL',
      });
    },
    SLOW,
  );

  it(
    'stops the hook when the signal aborts',
    async () => {
      const result = await abortWhenReady({ command: tracked(`touch "${ready}"; sleep 60`) });
      expect(result).toMatchObject({ timedOut: false, signal: 'SIGTERM' });

      // An already aborted signal starts nothing.
      const marker = path.join(root, 'ran');
      const early = await run({ command: `touch "${marker}"`, signal: AbortSignal.abort() });
      expect(early).toMatchObject({ exitCode: null, startError: expect.any(String) });
      // A later hook has come and gone, so a started one would have left its marker.
      await run({ command: 'sleep 0.3' });
      await expect(fs.access(marker)).rejects.toThrow();
    },
    SLOW,
  );

  it(
    'captures output up to the limit whole, keeping multi-byte characters intact',
    async () => {
      const command = `yes é | head -n ${KEPT / 2}; yes é | head -n 500000 >&2`;
      const result = await run({ command: tracked(command) });
      expect(result).toMatchObject({ exitCode: 0, stdoutTruncated: false, stderrTruncated: false });
      expect(result.stdout === 'é\n'.repeat(KEPT / 2)).toBe(true);
      expect(result.stderr === 'é\n'.repeat(500_000)).toBe(true);
    },
    SLOW,
  );

  it(
    'cuts before a character that would be split in two at the limit',
    async () => {
      const filler = `head -c ${KEPT - 1} /dev/zero | tr '\\0' a`;
      const result = await run({ command: tracked(`${filler}; printf '😀tail'`) });
      expect(result).toMatchObject({ exitCode: 0, stdoutTruncated: true });
      expect(result.stdout === 'a'.repeat(KEPT - 1)).toBe(true);
    },
    SLOW,
  );

  it('stops a hook whose signal aborts while it is being started', async () => {
    const marker = path.join(root, 'ran-late');
    const controller = new AbortController();
    const pending = run({ command: `touch "${marker}"`, signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ exitCode: null, startError: expect.any(String) });
    await run({ command: 'sleep 0.3' });
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it.each([
    ['stdout', '', 'stderr'],
    ['stderr', ' >&2', 'stdout'],
  ] as const)(
    'keeps the start of %s above the limit, reads the rest and says so',
    async (stream, redirect, other) => {
      // Twice the limit; a runner that stopped reading would leave the hook blocked.
      const command = tracked(`(echo first; yes é | head -n ${KEPT})${redirect}`);
      const result = await withoutUncaught(() => run({ command }));
      expect(result).toMatchObject({
        exitCode: 0,
        [`${stream}Truncated`]: true,
        [other]: '',
        [`${other}Truncated`]: false,
      });
      // The first line marks the start, so a runner that kept the end would fail.
      expect(result[stream] === `first\n${'é\n'.repeat((KEPT - 6) / 2)}`).toBe(true);
    },
    SLOW,
  );
});
