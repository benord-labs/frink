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

  const deps = (mode: string, extra: Record<string, string> = {}) => ({
    binaryPath: () => path.join(dir, 'claude'),
    shellEnv: () => ({ PATH: process.env.PATH ?? '', OUT: dir, FAKE_MODE: mode, ...extra }),
    app,
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
      }),
    );

    await expect(finished).resolves.toBe(true);
    expect(await read('args')).toBe('auth login --claudeai\n');
    const env = (await read('env')).split('\n');
    expect(env).toContain('CLAUDE_SECURESTORAGE_CONFIG_DIR=');
    for (const key of ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      expect(env.some((line) => line.startsWith(`${key}=`))).toBe(false);
    }
    expect(app.listenerCount('before-quit')).toBe(0);
  });

  it('keeps waiting while stdin is open, and Cancel ends Claude and everything it started', async () => {
    const finished = signInToClaude(deps('wait'));
    const helper = Number(await started());
    expect(alive(helper)).toBe(true);

    cancelClaudeSignIn();

    await expect(finished).resolves.toBe(false);
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
    await expect(second).resolves.toBe(true);
    await expect(first).resolves.toBe(false);
    expect(await read('args')).toBe('auth login --claudeai\nauth login --claudeai\n');
  });

  it('gives up after three minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const finished = signInToClaude(deps('wait'));
    await started();

    vi.advanceTimersByTime(180_000);

    await expect(finished).resolves.toBe(false);
  });

  it('stops when Frink quits', async () => {
    const finished = signInToClaude(deps('wait'));
    await started();

    app.emit('before-quit');

    await expect(finished).resolves.toBe(false);
  });

  it('says it did not finish when Claude fails or cannot start', async () => {
    await expect(signInToClaude(deps('fail'))).resolves.toBe(false);
    const missing = { ...deps('done'), binaryPath: () => path.join(dir, 'missing') };
    await expect(signInToClaude(missing)).resolves.toBe(false);
  });
});
