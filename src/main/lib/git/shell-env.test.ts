import { afterEach, describe, expect, it, vi } from 'vitest';

// PATH extension and default-shell resolution are the platform module's job.
const buildExtendedPath = vi.fn((p?: string) => `EXTENDED::${p ?? ''}`);
const platformDefaultShell = vi.fn(() => '/bin/zsh');

vi.mock('../platform', () => ({
  getDefaultShell: platformDefaultShell,
  platform: { buildExtendedPath },
}));

// Stub the login-shell spawn so the posix branch never touches a real shell.
const execFileMock = vi.fn(
  (_cmd: string, _args: string[], _opts: unknown, cb: (e: unknown, r: unknown) => void) => {
    cb(null, { stdout: 'PATH=/login/path\n', stderr: '' });
  },
);
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
});

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

  it('posix: spawns the platform default shell as the login shell', async () => {
    withPlatform('darwin');
    vi.resetModules();
    const { getGitEnv } = await import('./shell-env');

    await getGitEnv();
    expect(platformDefaultShell).toHaveBeenCalled();
    expect(execFileMock).toHaveBeenCalledWith(
      '/bin/zsh',
      ['-lc', 'env'],
      expect.anything(),
      expect.anything(),
    );
  });
});
