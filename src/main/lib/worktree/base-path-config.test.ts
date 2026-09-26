import { beforeEach, describe, expect, it, vi } from 'vitest';

const readFileMock = vi.fn();
const mkdirMock = vi.fn();
const unlinkMock = vi.fn();
const writeFileMock = vi.fn();
const accessMock = vi.fn();
const statMock = vi.fn();
const mkdtempMock = vi.fn();
const rmMock = vi.fn();
const readFileSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const ensureDirExistsMock = vi.fn();
const ensureDirExistsAsyncMock = vi.fn();

vi.mock('node:fs/promises', () => ({
  access: accessMock,
  stat: statMock,
  mkdtemp: mkdtempMock,
  rm: rmMock,
  mkdir: mkdirMock,
  readFile: readFileMock,
  unlink: unlinkMock,
  writeFile: writeFileMock,
}));

vi.mock('node:fs', () => ({
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncMock,
}));

vi.mock('../fs-helpers', () => ({
  ensureDirExists: ensureDirExistsMock,
  ensureDirExistsAsync: ensureDirExistsAsyncMock,
}));

describe('worktree base path config', () => {
  beforeEach(() => {
    readFileMock.mockReset();
    mkdirMock.mockReset();
    unlinkMock.mockReset();
    writeFileMock.mockReset();
    accessMock.mockReset();
    statMock.mockReset();
    mkdtempMock.mockReset();
    rmMock.mockReset();
    readFileSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    ensureDirExistsMock.mockReset();
    ensureDirExistsAsyncMock.mockReset();
    mkdirMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);
    accessMock.mockResolvedValue(undefined);
    statMock.mockResolvedValue({ isDirectory: () => false });
    mkdtempMock.mockResolvedValue('/tmp/mock-dir');
    rmMock.mockResolvedValue(undefined);
  });

  it('returns default path when config is missing', async () => {
    const mod = await import('./base-path-config');
    readFileMock.mockRejectedValueOnce(new Error('missing'));

    const resolved = await mod.resolveWorktreeBasePath();
    expect(resolved.endsWith('/.frink/worktrees')).toBe(true);
  });

  it('persists custom base path and resolves it', async () => {
    const mod = await import('./base-path-config');
    const customPath = '/Volumes/dev/worktrees';
    readFileMock.mockRejectedValueOnce(new Error('missing'));
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        version: mod.WORKTREE_CONFIG_VERSION,
        worktreeBasePath: customPath,
      }),
    );
    writeFileMock.mockResolvedValue(undefined);

    await mod.setWorktreeBasePath(customPath);
    expect(writeFileMock).toHaveBeenCalled();
    await expect(mod.resolveWorktreeBasePath()).resolves.toEqual(customPath);
  });

  it('resets to default by clearing configured path', async () => {
    const mod = await import('./base-path-config');
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({ version: mod.WORKTREE_CONFIG_VERSION, worktreeBasePath: '/tmp/worktrees' }),
    );
    writeFileMock.mockResolvedValue(undefined);

    await mod.resetWorktreeBasePath();
    expect(writeFileMock).toHaveBeenCalled();
  });

  it('persists migrated config when version is outdated', async () => {
    const mod = await import('./base-path-config');
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({ version: 0, worktreeBasePath: '/tmp/old' }),
    );
    writeFileMock.mockResolvedValue(undefined);

    await mod.resolveWorktreeBasePath();

    expect(writeFileMock).toHaveBeenCalledWith(
      mod.FRINK_WORKTREE_CONFIG_PATH,
      JSON.stringify(
        { version: mod.WORKTREE_CONFIG_VERSION, worktreeBasePath: '/tmp/old' },
        null,
        2,
      ),
      'utf-8',
    );
  });

  it('returns migrated config even when async migration write fails', async () => {
    const mod = await import('./base-path-config');
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({ version: 0, worktreeBasePath: '/tmp/old-async' }),
    );
    writeFileMock.mockRejectedValueOnce(new Error('disk full'));

    await expect(mod.resolveWorktreeBasePath()).resolves.toEqual('/tmp/old-async');
  });

  it('persists migrated config in sync read path', async () => {
    const mod = await import('./base-path-config');
    readFileSyncMock.mockReturnValueOnce(
      JSON.stringify({ version: 0, worktreeBasePath: '/tmp/sync' }),
    );
    writeFileSyncMock.mockImplementation(() => undefined);

    const resolved = mod.resolveWorktreeBasePathSync();
    expect(resolved).toBe('/tmp/sync');
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      mod.FRINK_WORKTREE_CONFIG_PATH,
      JSON.stringify(
        { version: mod.WORKTREE_CONFIG_VERSION, worktreeBasePath: '/tmp/sync' },
        null,
        2,
      ),
      'utf-8',
    );
  });
});
