import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelClaudeSignIn, signInToClaude } from './index';

/** Stands in for the bundled Claude: records how it was started, then acts out `$FAKE_MODE`. */
const FAKE_CLAUDE = `#!/bin/sh
printf '%s\\n' "$*" >> "$OUT/args"
env > "$OUT/env"
case "$FAKE_MODE" in
  done) exit 0 ;;
  fail) exit 3 ;;
esac
sleep 300 &
echo $! > "$OUT/helper"
cat
`;

const alive = (pid: number) => {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
};

describe('signInToClaude', () => {
  let dir = '';
  let app = new EventEmitter();
  const spawned: ChildProcess[] = [];

  const deps = (
    mode: string,
    extra: Record<string, string> = {},
  ): NonNullable<Parameters<typeof signInToClaude>[0]> => ({
    binaryPath: () => path.join(dir, 'claude'),
    baseEnv: () => ({ PATH: process.env.PATH ?? '', OUT: dir, FAKE_MODE: mode, ...extra }),
    app,
    spawn: (command, args, options) => {
      const child = spawn(command, args, options);
      spawned.push(child);
      return child;
    },
  });
  const read = (name: string) => readFile(path.join(dir, name), 'utf8');
  const started = () => vi.waitFor(() => read('helper'), { timeout: 5000 });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'claude login '));
    await writeFile(path.join(dir, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
    app = new EventEmitter();
  });
  afterEach(async () => {
    cancelClaudeSignIn();
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  it("runs Claude's own sign-in into the shared login store, with no config folder", async () => {
    const finished = signInToClaude(
      deps('done', {
        CLAUDE_CONFIG_DIR: '/tmp/somewhere-else',
        ANTHROPIC_API_KEY: 'exported-key',
        CLAUDE_CODE_OAUTH_TOKEN: 'exported-token',
        CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
        CLAUDE_CODE_ENABLE_TASKS: 'true',
      }),
    );

    await expect(finished).resolves.toBe('finished');
    expect(await read('args')).toBe('auth login --claudeai\n');
    const env = (await read('env')).split('\n');
    expect(env).toContain('CLAUDE_SECURESTORAGE_CONFIG_DIR=');
    for (const key of [
      'CLAUDE_CONFIG_DIR',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_ENABLE_TASKS',
    ]) {
      expect(env.some((line) => line.startsWith(`${key}=`))).toBe(false);
    }
    expect(app.listenerCount('before-quit')).toBe(0);
  });

  it('keeps waiting while stdin is open, and Cancel ends Claude and everything it started', async () => {
    const finished = signInToClaude(deps('wait'));
    const helper = Number(await started());
    expect(alive(helper)).toBe(true);

    cancelClaudeSignIn();

    await expect(finished).resolves.toBe('stopped');
    await vi.waitFor(() => expect(alive(helper)).toBe(false));
  });

  it('never starts a second sign-in while one waits', async () => {
    const first = signInToClaude(deps('wait'));
    await started();

    expect(signInToClaude(deps('wait'))).toBe(first);
    cancelClaudeSignIn();
    await first;
    expect(await read('args')).toBe('auth login --claudeai\n');
  });

  it('starts a fresh sign-in right after Cancel', async () => {
    const first = signInToClaude(deps('wait'));
    await started();

    cancelClaudeSignIn();
    const second = signInToClaude(deps('done'));

    expect(second).not.toBe(first);
    await expect(second).resolves.toBe('finished');
    await expect(first).resolves.toBe('stopped');
    expect(await read('args')).toBe('auth login --claudeai\nauth login --claudeai\n');
  });

  it('gives up after three minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const finished = signInToClaude(deps('wait'));
    await started();

    vi.advanceTimersByTime(180_000);

    await expect(finished).resolves.toBe('stopped');
  });

  it('stops when Frink quits', async () => {
    const finished = signInToClaude(deps('wait'));
    await started();

    app.emit('before-quit');

    await expect(finished).resolves.toBe('stopped');
  });

  it('says it did not finish when Claude fails', async () => {
    await expect(signInToClaude(deps('fail'))).resolves.toBe('stopped');
  });

  it('counts an error from a running Claude, such as a stop that could not be delivered, as stopped', async () => {
    const finished = signInToClaude(deps('wait'));
    await started();
    const child = spawned.at(-1);

    child?.emit('error', new Error('kill EPERM'));

    await expect(finished).resolves.toBe('stopped');
    if (child?.pid) process.kill(-child.pid, 'SIGKILL');
  });

  it('says it could not start when the system ends Claude, as macOS does an unsigned binary', async () => {
    const finished = signInToClaude(deps('wait'));
    await started();
    const pid = spawned.at(-1)?.pid;
    // A pid of 0 would signal this test run's own process group.
    if (!pid) throw new Error('Claude did not start through the given spawn');

    process.kill(-pid, 'SIGKILL');

    await expect(finished).resolves.toBe('unavailable');
  });

  it('says it could not start when the bundled Claude will not run', async () => {
    const missing = { ...deps('done'), binaryPath: () => path.join(dir, 'missing') };
    await expect(signInToClaude(missing)).resolves.toBe('unavailable');
  });
});
