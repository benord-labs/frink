import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { existsMock, statMock, chmodMock, warnMock, captureMock } = vi.hoisted(() => ({
  existsMock: vi.fn(),
  statMock: vi.fn(),
  chmodMock: vi.fn(),
  warnMock: vi.fn(),
  captureMock: vi.fn(),
}));

vi.mock('../sentry/init', () => ({ captureMainMessage: captureMock }));

vi.mock('electron-log', () => ({ default: { warn: warnMock } }));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: existsMock,
  statSync: statMock,
  chmodSync: chmodMock,
}));

import { ensureSpawnHelperExecutable, spawnHelperCandidates } from './node-pty-spawn-helper';

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

const realPlatform = process.platform;

describe('spawnHelperCandidates', () => {
  it('probes build/Release, build/Debug, then the platform prebuild — node-pty loader order', () => {
    const resolve = () => '/repo/node_modules/node-pty/lib/index.js';
    expect(spawnHelperCandidates(resolve)).toEqual([
      '/repo/node_modules/node-pty/build/Release/spawn-helper',
      '/repo/node_modules/node-pty/build/Debug/spawn-helper',
      `/repo/node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`,
    ]);
  });

  it('remaps asar paths to app.asar.unpacked, where asarUnpack places binaries', () => {
    const resolve = () =>
      '/Applications/Frink.app/Contents/Resources/app.asar/node_modules/node-pty/lib/index.js';
    for (const candidate of spawnHelperCandidates(resolve)) {
      expect(candidate).toContain('/app.asar.unpacked/node_modules/node-pty/');
    }
  });
});

describe('ensureSpawnHelperExecutable', () => {
  beforeEach(() => {
    existsMock.mockReset();
    statMock.mockReset();
    chmodMock.mockReset();
  });

  afterEach(() => {
    setPlatform(realPlatform);
  });

  it('adds the exec bit when the loaded candidate lacks one', () => {
    existsMock.mockReturnValue(true);
    statMock.mockReturnValue({ mode: 0o100644 });

    ensureSpawnHelperExecutable();

    expect(chmodMock).toHaveBeenCalledTimes(1);
    expect(chmodMock).toHaveBeenCalledWith(
      expect.stringContaining('spawn-helper'),
      0o100644 | 0o755,
    );
  });

  it('stops at the first existing candidate — later ones are never loaded by node-pty', () => {
    existsMock.mockReturnValueOnce(false).mockReturnValueOnce(true);
    statMock.mockReturnValue({ mode: 0o100644 });

    ensureSpawnHelperExecutable();

    expect(existsMock).toHaveBeenCalledTimes(2);
    expect(chmodMock).toHaveBeenCalledWith(
      expect.stringContaining('build/Debug/spawn-helper'),
      expect.any(Number),
    );
  });

  it('leaves an already-executable helper untouched', () => {
    existsMock.mockReturnValue(true);
    statMock.mockReturnValue({ mode: 0o100755 });

    ensureSpawnHelperExecutable();

    expect(chmodMock).not.toHaveBeenCalled();
  });

  it('no-ops on win32, which has no spawn-helper', () => {
    setPlatform('win32');

    ensureSpawnHelperExecutable();

    expect(existsMock).not.toHaveBeenCalled();
  });

  it('warns instead of throwing when the filesystem rejects the repair', () => {
    existsMock.mockReturnValue(true);
    statMock.mockReturnValue({ mode: 0o100644 });
    chmodMock.mockImplementation(() => {
      throw new Error('EPERM');
    });

    expect(() => ensureSpawnHelperExecutable()).not.toThrow();
    expect(warnMock).toHaveBeenCalledOnce();
    expect(captureMock).toHaveBeenCalledWith('spawn-helper exec-bit repair failed', 'warning', {
      message: 'EPERM',
    });
  });
});
