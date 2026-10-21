import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { cancelCodexSignIn, signInToCodex } from './index';

/** Stands in for the bundled Codex app-server: logs each request, then acts out `$FAKE_MODE`. */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs');
const out = (name, text) => fs.appendFileSync(process.env.OUT + '/' + name, text + '\\n');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
fs.writeFileSync(process.env.OUT + '/pid', String(process.pid));
out('args', process.argv.slice(2).join(' '));
out('codex-home', process.env.CODEX_HOME ?? '');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let nl = buffer.indexOf('\\n'); nl !== -1; nl = buffer.indexOf('\\n')) {
    const { id, method, params } = JSON.parse(buffer.slice(0, nl));
    buffer = buffer.slice(nl + 1);
    out('requests', JSON.stringify({ method, params }));
    if (method === 'initialize') send({ id, result: { capabilities: { frinkHostToolPermission: 1 } } });
    if (method === 'account/login/cancel' && process.env.FAKE_MODE !== 'deaf') send({ id, result: { status: 'canceled' } });
    if (method !== 'account/login/start') continue;
    send({ id, result: { type: 'chatgpt', loginId: 'login-1', authUrl: process.env.AUTH_URL } });
    const mode = process.env.FAKE_MODE;
    if (mode === 'exit') process.exit(1);
    if (mode === 'done' || mode === 'fail') {
      send({ method: 'account/login/completed', params: { loginId: 'login-1', success: mode === 'done', error: null } });
    }
  }
});
`;

const AUTH_URL = 'https://auth.openai.example/oauth/authorize?state=1';
const REQUEST = z.object({ method: z.string(), params: z.unknown().optional() });

const alive = (pid: number) => {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
};

describe('signInToCodex', () => {
  let dir = '';
  let app = new EventEmitter();
  const openExternal = vi.fn<(url: string) => Promise<void>>();

  const deps = () => ({ binary: () => path.join(dir, 'codex'), openExternal, app });
  const read = (name: string) => readFile(path.join(dir, name), 'utf8');
  const requests = async () =>
    (await read('requests'))
      .trim()
      .split('\n')
      .map((line) => REQUEST.parse(JSON.parse(line)));
  const opened = () => vi.waitFor(() => expect(openExternal).toHaveBeenCalled(), { timeout: 5000 });
  const mode = (value: string, url = AUTH_URL) => {
    vi.stubEnv('FAKE_MODE', value);
    vi.stubEnv('AUTH_URL', url);
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'codex login '));
    await writeFile(path.join(dir, 'codex'), FAKE_CODEX, { mode: 0o755 });
    vi.stubEnv('OUT', dir);
    vi.stubEnv('CODEX_HOME', '/inherited/codex home');
    app = new EventEmitter();
    openExternal.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => {
    cancelCodexSignIn();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it("asks Codex's app-server for a ChatGPT sign-in, opens its page, and ends Codex when it finishes", async () => {
    mode('done');

    await expect(signInToCodex(deps())).resolves.toBe(true);

    expect(await read('args')).toBe('app-server\n');
    expect(await read('codex-home')).toBe('/inherited/codex home\n');
    expect(openExternal).toHaveBeenCalledWith(AUTH_URL);
    expect(await requests()).toEqual([
      { method: 'initialize', params: expect.anything() },
      { method: 'initialized' },
      { method: 'account/login/start', params: { type: 'chatgpt' } },
    ]);
    await vi.waitFor(async () => expect(alive(Number(await read('pid')))).toBe(false));
    expect(app.listenerCount('before-quit')).toBe(0);
  });

  it('says it did not finish when Codex reports a failed or timed-out sign-in', async () => {
    mode('fail');
    await expect(signInToCodex(deps())).resolves.toBe(false);
  });

  it('cancels the sign-in through Codex, then ends it', async () => {
    mode('wait');
    const finished = signInToCodex(deps());
    await opened();
    const pid = Number(await read('pid'));

    cancelCodexSignIn();

    await expect(finished).resolves.toBe(false);
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
    expect(await requests()).toContainEqual({
      method: 'account/login/cancel',
      params: { loginId: 'login-1' },
    });
  });

  it('ends Codex anyway when it does not answer the cancel', async () => {
    mode('deaf');
    const finished = signInToCodex(deps());
    await opened();
    const pid = Number(await read('pid'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    cancelCodexSignIn();
    await expect(finished).resolves.toBe(false);
    expect(alive(pid)).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);

    vi.useRealTimers();
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  });

  it('opens the same page again instead of a second sign-in while one waits', async () => {
    mode('wait');
    const first = signInToCodex(deps());
    await opened();

    expect(signInToCodex(deps())).toBe(first);
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(2));
    expect(openExternal).toHaveBeenLastCalledWith(AUTH_URL);
    expect(await read('args')).toBe('app-server\n');
  });

  it('starts a fresh sign-in right after Cancel', async () => {
    mode('wait');
    const first = signInToCodex(deps());
    await opened();

    cancelCodexSignIn();
    mode('done');
    const second = signInToCodex(deps());

    expect(second).not.toBe(first);
    await expect(second).resolves.toBe(true);
    expect(await read('args')).toBe('app-server\napp-server\n');
  });

  it('ends Codex at once when Frink quits, without waiting on a cancel', async () => {
    mode('deaf');
    const finished = signInToCodex(deps());
    await opened();
    const pid = Number(await read('pid'));

    app.emit('before-quit');

    await expect(finished).resolves.toBe(false);
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 1_000 });
    expect((await requests()).map((request) => request.method)).not.toContain(
      'account/login/cancel',
    );
  });

  it('says it did not finish when Codex stops early', async () => {
    mode('exit');
    await expect(signInToCodex(deps())).resolves.toBe(false);
  });

  it('opens only a secure web page', async () => {
    mode('wait', 'http://auth.openai.example/');
    await expect(signInToCodex(deps())).resolves.toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('says it did not finish when the browser will not open or Codex is missing', async () => {
    mode('wait');
    openExternal.mockRejectedValue(new Error('no browser'));
    await expect(signInToCodex(deps())).resolves.toBe(false);

    await expect(signInToCodex({ ...deps(), binary: () => null })).resolves.toBe(false);
  });
});
