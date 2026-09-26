import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());

// promisify(execFile) reads the custom symbol, so the mock must carry one.
vi.mock('node:child_process', () => {
  const execFile = Object.assign(execFileMock, {
    [Symbol.for('nodejs.util.promisify.custom')]: (...args: unknown[]) => execFileMock(...args),
  });
  return { execFile };
});

vi.mock('node:fs', () => ({ existsSync: existsSyncMock }));

const realPlatform = process.platform;

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  execFileMock.mockReset();
  existsSyncMock.mockReset();
});

afterEach(async () => {
  stubPlatform(realPlatform);
  const { resetCommandShellCache } = await import('./command-shell');
  resetCommandShellCache();
});

describe('resolveCommandShell', () => {
  // On POSIX Node's exec already uses /bin/sh, so returning undefined keeps this a strict no-op
  // outside Windows — the property that makes applying it to every command sink safe.
  it.each(['darwin', 'linux'] as const)(
    'returns undefined on %s without probing git',
    async (p) => {
      stubPlatform(p);
      const { resolveCommandShell } = await import('./command-shell');

      await expect(resolveCommandShell()).resolves.toBeUndefined();
      expect(execFileMock).not.toHaveBeenCalled();
    },
  );

  it('resolves Git Bash beside the git binary on Windows', async () => {
    stubPlatform('win32');
    execFileMock.mockResolvedValue({ stdout: 'C:\\Program Files\\Git\\cmd\\git.exe\r\n' });
    existsSyncMock.mockReturnValue(true);
    const { resolveCommandShell } = await import('./command-shell');

    const shell = await resolveCommandShell();

    expect(shell).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(['git']);
  });

  it('skips a candidate whose sibling bash.exe is missing', async () => {
    stubPlatform('win32');
    execFileMock.mockResolvedValue({
      stdout: 'C:\\shim\\cmd\\git.exe\r\nC:\\Program Files\\Git\\cmd\\git.exe\r\n',
    });
    existsSyncMock.mockImplementation((p: string) => p.includes('Program Files'));
    const { resolveCommandShell } = await import('./command-shell');

    await expect(resolveCommandShell()).resolves.toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  // Falling back to cmd.exe is worse than Git Bash but better than refusing to run at all;
  // the warning is what makes the degraded mode visible.
  it('falls back to the platform default when git is not on PATH', async () => {
    stubPlatform('win32');
    execFileMock.mockRejectedValue(new Error('not found'));
    const { resolveCommandShell } = await import('./command-shell');

    await expect(resolveCommandShell()).resolves.toBeUndefined();
  });

  it('caches a successful resolution instead of re-probing', async () => {
    stubPlatform('win32');
    execFileMock.mockResolvedValue({ stdout: 'C:\\Program Files\\Git\\cmd\\git.exe\r\n' });
    existsSyncMock.mockReturnValue(true);
    const { resolveCommandShell } = await import('./command-shell');

    await resolveCommandShell();
    await resolveCommandShell();

    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  // A cached miss would pin the whole session to cmd.exe even after the user installs git.
  it('re-probes after a miss, so a later git install is picked up', async () => {
    stubPlatform('win32');
    execFileMock.mockRejectedValueOnce(new Error('not found'));
    const { resolveCommandShell } = await import('./command-shell');

    await expect(resolveCommandShell()).resolves.toBeUndefined();

    execFileMock.mockResolvedValue({ stdout: 'C:\\Program Files\\Git\\cmd\\git.exe\r\n' });
    existsSyncMock.mockReturnValue(true);

    await expect(resolveCommandShell()).resolves.toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});
