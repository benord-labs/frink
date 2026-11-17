import { afterEach, describe, expect, it, vi } from 'vitest';

// PATH extension is the platform module's job.
const buildExtendedPath = vi.fn((p?: string) => `EXTENDED::${p ?? ''}`);

vi.mock('../platform', () => ({
  platform: { buildExtendedPath },
}));

const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => (execFileMock as unknown as (...a: unknown[]) => void)(...args),
}));

const realPlatform = process.platform;
function withPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  vi.clearAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** Import shell-env with the login shell answering `PATH` (null: the shell is unavailable). */
async function importWithLoginShell(path: string | null) {
  vi.resetModules();
  vi.stubEnv('PATH', process.env.PATH ?? '');
  const { LoginShellEnvResolver, setLoginShellEnvResolver } =
    await import('../platform/login-shell-env');
  setLoginShellEnvResolver(
    new LoginShellEnvResolver({
      spawnShell: async () =>
        path === null
          ? {
              ok: false,
              failure: { message: 'no shell', code: 1, signal: null, stderr: '', timedOut: false },
            }
          : { ok: true, env: { PATH: path } },
      extendPath: (p) => p ?? '',
    }),
  );
  return import('./shell-env');
}

/** Import shell-env with a login shell whose profile PATH the test edits between spawns. */
async function importWithEditableProfile(initialPath: string) {
  vi.resetModules();
  vi.stubEnv('PATH', '/usr/bin:/bin');
  const loginShell = await import('../platform/login-shell-env');
  const profile = { PATH: initialPath };
  const spawnShell = vi.fn(async () => ({ ok: true as const, env: { PATH: profile.PATH } }));
  loginShell.setLoginShellEnvResolver(
    new loginShell.LoginShellEnvResolver({ spawnShell, extendPath: (p) => p ?? '' }),
  );
  await loginShell.resolveLoginShellEnv();
  return { ...(await import('./shell-env')), profile, spawnShell, loginShell };
}

describe('git shell-env consolidation (SC-84)', () => {
  it('win32: derives PATH via platform.buildExtendedPath instead of a local buildWindowsPath', async () => {
    withPlatform('win32');
    vi.resetModules();
    const { getGitEnv } = await import('./shell-env');

    await getGitEnv();
    expect(buildExtendedPath).toHaveBeenCalledWith(process.env.PATH);
  });

  it('win32: getGitEnv stays behaviour-neutral — git receives the untouched process.env PATH, not the extended value', async () => {
    withPlatform('win32');
    vi.resetModules();
    const { getGitEnv } = await import('./shell-env');

    const env = await getGitEnv();
    // getGitEnv reads key `Path` on win32 while the extended value is written under `PATH`,
    // so the value git actually consumes is the unmodified process.env PATH (see SC-84 follow-up).
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.PATH).not.toContain('EXTENDED::');
  });

  it('posix: git gets the shared login-shell PATH on top of process.env', async () => {
    withPlatform('darwin');
    const { getGitEnv } = await importWithLoginShell('/login/path');

    const env = await getGitEnv();
    expect(env.PATH?.split(':')[0]).toBe('/login/path');
    expect(env.HOME).toBe(process.env.HOME);
  });

  it('posix: keeps process.env PATH while the login shell is unavailable', async () => {
    withPlatform('darwin');
    const { getGitEnv } = await importWithLoginShell(null);

    expect((await getGitEnv()).PATH).toBe(process.env.PATH);
  });
});

describe('execWithShellEnv', () => {
  type Callback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;
  type ExecArgs = [cmd: string, args: string[], options: object, cb: Callback];
  const enoent = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });

  it('retries a command that was not found with the login-shell PATH', async () => {
    withPlatform('darwin');
    execFileMock
      .mockImplementationOnce((...[, , , cb]: ExecArgs) => cb(enoent))
      .mockImplementationOnce((...[, , , cb]: ExecArgs) => cb(null, { stdout: 'ok', stderr: '' }));
    const { execWithShellEnv } = await importWithLoginShell('/login/path');

    const result = await execWithShellEnv('gh', ['--version'], { env: { GH_TOKEN: 't' } });

    expect(result.stdout).toBe('ok');
    expect(execFileMock.mock.calls[1][2]).toMatchObject({
      env: { PATH: expect.stringMatching(/^\/login\/path(:|$)/), GH_TOKEN: 't' },
    });
  });

  it('rethrows the original error when the login shell is unavailable', async () => {
    withPlatform('darwin');
    execFileMock.mockImplementationOnce((...[, , , cb]: ExecArgs) => cb(enoent));
    const { execWithShellEnv } = await importWithLoginShell(null);

    await expect(execWithShellEnv('gh', ['--version'])).rejects.toBe(enoent);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('finds a tool installed after the shell env was read, without a restart (sc-4772)', async () => {
    withPlatform('darwin');
    vi.useFakeTimers();
    const { execWithShellEnv, profile, loginShell } = await importWithEditableProfile('/old/bin');
    // `brew install gh` into a new directory while Frink runs.
    profile.PATH = '/new/bin:/old/bin';
    vi.advanceTimersByTime(loginShell.FORCED_REFRESH_MIN_INTERVAL_MS);
    execFileMock
      .mockImplementationOnce((...[, , , cb]: ExecArgs) => cb(enoent))
      .mockImplementationOnce((...[, , , cb]: ExecArgs) => cb(null, { stdout: 'ok', stderr: '' }));

    const result = await execWithShellEnv('gh', ['--version']);

    expect(result.stdout).toBe('ok');
    expect(execFileMock.mock.calls[1][2]).toMatchObject({
      env: { PATH: '/new/bin:/old/bin:/usr/bin:/bin' },
    });
    expect(process.env.PATH).toBe('/new/bin:/old/bin:/usr/bin:/bin');
  });

  it('rethrows at once for a tool that is genuinely missing, re-reading the shell at most once', async () => {
    withPlatform('darwin');
    vi.useFakeTimers();
    const { execWithShellEnv, spawnShell, loginShell } =
      await importWithEditableProfile('/old/bin');
    vi.advanceTimersByTime(loginShell.FORCED_REFRESH_MIN_INTERVAL_MS);
    execFileMock
      .mockImplementationOnce((...[, , , cb]: ExecArgs) => cb(enoent))
      .mockImplementationOnce((...[, , , cb]: ExecArgs) => cb(enoent));

    await expect(execWithShellEnv('gh', ['--version'])).rejects.toBe(enoent);
    await expect(execWithShellEnv('gh', ['--version'])).rejects.toBe(enoent);

    // The refreshed PATH matched the one that failed: no retry exec, and the second call is inside
    // the forced-refresh throttle, so no second shell either.
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(spawnShell).toHaveBeenCalledTimes(2);
  });
});
