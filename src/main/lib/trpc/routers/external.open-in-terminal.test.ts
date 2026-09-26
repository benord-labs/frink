import { beforeEach, describe, expect, it, vi } from 'vitest';

const { statMock, spawnMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('node:fs', () => ({
  promises: {
    stat: statMock,
  },
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('electron', () => ({
  shell: {
    showItemInFolder: vi.fn(),
    openExternal: vi.fn(),
    openPath: vi.fn(),
  },
}));

import { openInTerminal } from './external';

function createSpawnSuccessChild() {
  return {
    once(event: string, cb: (...args: unknown[]) => void) {
      if (event === 'spawn') cb();
      return this;
    },
    unref: vi.fn(),
  };
}

function createSpawnErrorChild() {
  return {
    once(event: string, cb: (...args: unknown[]) => void) {
      if (event === 'error') cb(new Error('spawn failed'));
      return this;
    },
    unref: vi.fn(),
  };
}

describe('openInTerminal', () => {
  beforeEach(() => {
    statMock.mockReset();
    spawnMock.mockReset();
    statMock.mockResolvedValue({ isDirectory: () => true });
  });

  it('returns error when directory does not exist', async () => {
    statMock.mockRejectedValue(new Error('missing'));

    const result = await openInTerminal('/missing/path', 'darwin');

    expect(result).toEqual({ success: false, error: 'Directory does not exist' });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns error when path is not a directory', async () => {
    statMock.mockResolvedValue({ isDirectory: () => false });

    const result = await openInTerminal('/tmp/file.txt', 'darwin');

    expect(result).toEqual({ success: false, error: 'Path is not a directory' });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('uses Terminal app first on macOS', async () => {
    spawnMock.mockReturnValue(createSpawnSuccessChild());

    const result = await openInTerminal('/tmp/project', 'darwin');

    expect(result).toEqual({ success: true });
    expect(spawnMock).toHaveBeenCalledWith('open', ['-a', 'Terminal', '/tmp/project'], {
      detached: true,
      stdio: 'ignore',
    });
  });

  it('falls back to iTerm on macOS when Terminal launch fails', async () => {
    spawnMock
      .mockReturnValueOnce(createSpawnErrorChild())
      .mockReturnValueOnce(createSpawnSuccessChild());

    const result = await openInTerminal('/tmp/project', 'darwin');

    expect(result).toEqual({ success: true });
    expect(spawnMock).toHaveBeenNthCalledWith(1, 'open', ['-a', 'Terminal', '/tmp/project'], {
      detached: true,
      stdio: 'ignore',
    });
    expect(spawnMock).toHaveBeenNthCalledWith(2, 'open', ['-a', 'iTerm', '/tmp/project'], {
      detached: true,
      stdio: 'ignore',
    });
  });

  it('falls back from Windows Terminal to cmd on win32', async () => {
    spawnMock
      .mockReturnValueOnce(createSpawnErrorChild())
      .mockReturnValueOnce(createSpawnSuccessChild());

    const result = await openInTerminal('C:\\project', 'win32');

    expect(result).toEqual({ success: true });
    expect(spawnMock).toHaveBeenNthCalledWith(1, 'wt.exe', ['-d', 'C:\\project'], {
      detached: true,
      stdio: 'ignore',
    });
    expect(spawnMock).toHaveBeenNthCalledWith(2, 'cmd.exe', ['/c', 'start', '', 'cmd.exe', '/K'], {
      detached: true,
      stdio: 'ignore',
      cwd: 'C:\\project',
    });
  });

  it('falls back between linux terminal candidates', async () => {
    spawnMock
      .mockReturnValueOnce(createSpawnErrorChild())
      .mockReturnValueOnce(createSpawnErrorChild())
      .mockReturnValueOnce(createSpawnSuccessChild());

    const result = await openInTerminal('/tmp/project', 'linux');

    expect(result).toEqual({ success: true });
    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      'x-terminal-emulator',
      ['--working-directory', '/tmp/project'],
      { detached: true, stdio: 'ignore' },
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'gnome-terminal',
      ['--working-directory', '/tmp/project'],
      { detached: true, stdio: 'ignore' },
    );
    expect(spawnMock).toHaveBeenNthCalledWith(3, 'konsole', ['--workdir', '/tmp/project'], {
      detached: true,
      stdio: 'ignore',
    });
  });

  it('returns platform-specific error when all macOS candidates fail', async () => {
    spawnMock.mockReturnValue(createSpawnErrorChild());

    const result = await openInTerminal('/tmp/project', 'darwin');

    expect(result).toEqual({
      success: false,
      error: 'Unable to open an external terminal app on macOS',
    });
  });

  it('returns platform-specific error when all Windows candidates fail', async () => {
    spawnMock.mockReturnValue(createSpawnErrorChild());

    const result = await openInTerminal('C:\\project', 'win32');

    expect(result).toEqual({
      success: false,
      error: 'Unable to open an external terminal app on Windows',
    });
  });

  it('returns platform-specific error when all Linux candidates fail (including sync throw)', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('sync failure');
    });

    const result = await openInTerminal('/tmp/project', 'linux');

    expect(result).toEqual({
      success: false,
      error: 'Unable to open an external terminal app on this platform',
    });
  });
});
