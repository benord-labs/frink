import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, openPathMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  openPathMock: vi.fn(),
}));

vi.mock('node:fs', () => ({
  promises: { stat: vi.fn() },
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('electron', () => ({
  shell: {
    showItemInFolder: vi.fn(),
    openExternal: vi.fn(),
    openPath: openPathMock,
  },
}));

import { openFileInEditor } from './external';

const SPAWN_OPTS = { stdio: 'ignore' };

function exitChild(code: number) {
  return {
    once(event: string, cb: (...args: unknown[]) => void) {
      if (event === 'close') cb(code);
      return this;
    },
  };
}

function errorChild() {
  return {
    once(event: string, cb: (...args: unknown[]) => void) {
      if (event === 'error') cb(new Error('spawn failed'));
      return this;
    },
  };
}

// `close` fires with code=null when the process was killed by a signal.
function signalKilledChild() {
  return {
    once(event: string, cb: (...args: unknown[]) => void) {
      if (event === 'close') cb(null);
      return this;
    },
  };
}

describe('openFileInEditor', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    openPathMock.mockReset();
    openPathMock.mockResolvedValue('');
  });

  it('opens in the first available macOS editor (exit 0 wins)', async () => {
    spawnMock.mockReturnValue(exitChild(0));

    const result = await openFileInEditor('/abs/file.ts', undefined, 'darwin');

    expect(result).toEqual({ success: true, editor: 'Cursor' });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith('open', ['-a', 'Cursor', '/abs/file.ts'], SPAWN_OPTS);
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it('falls through unavailable editors to the default text editor', async () => {
    spawnMock
      .mockReturnValueOnce(exitChild(1)) // Cursor not installed
      .mockReturnValueOnce(exitChild(1)) // VS Code not installed
      .mockReturnValueOnce(exitChild(1)) // Insiders not installed
      .mockReturnValueOnce(exitChild(0)); // open -t

    const result = await openFileInEditor('/abs/file.ts', undefined, 'darwin');

    expect(result).toEqual({ success: true, editor: 'default-text' });
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'open',
      ['-a', 'Visual Studio Code', '/abs/file.ts'],
      SPAWN_OPTS,
    );
    expect(spawnMock).toHaveBeenNthCalledWith(4, 'open', ['-t', '/abs/file.ts'], SPAWN_OPTS);
  });

  it('returns failure when nothing can open the file', async () => {
    spawnMock.mockReturnValue(exitChild(1));
    openPathMock.mockResolvedValue('no application set');

    const result = await openFileInEditor('/abs/file.ts', undefined, 'darwin');

    expect(result).toEqual({ success: false, error: 'no application set' });
  });

  it('survives a spawn launch error and falls back to the system handler', async () => {
    spawnMock.mockReturnValue(errorChild());

    const result = await openFileInEditor('/abs/file.ts', undefined, 'darwin');

    expect(result).toEqual({ success: true, editor: 'default' });
    expect(openPathMock).toHaveBeenCalledWith('/abs/file.ts');
  });

  it('continues past an editor that errors on launch to a working one', async () => {
    spawnMock
      .mockReturnValueOnce(errorChild()) // Cursor launch errors
      .mockReturnValueOnce(exitChild(0)); // VS Code opens

    const result = await openFileInEditor('/abs/file.ts', undefined, 'darwin');

    expect(result).toEqual({ success: true, editor: 'Visual Studio Code' });
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it('treats a signal-killed editor process as a failure and keeps probing', async () => {
    spawnMock
      .mockReturnValueOnce(signalKilledChild()) // Cursor killed (close code null)
      .mockReturnValueOnce(exitChild(0)); // VS Code opens

    const result = await openFileInEditor('/abs/file.ts', undefined, 'darwin');

    expect(result).toEqual({ success: true, editor: 'Visual Studio Code' });
  });

  it('resolves a relative path against cwd', async () => {
    spawnMock.mockReturnValue(exitChild(0));

    await openFileInEditor('src/a.ts', '/project', 'darwin');

    expect(spawnMock).toHaveBeenCalledWith(
      'open',
      ['-a', 'Cursor', '/project/src/a.ts'],
      SPAWN_OPTS,
    );
  });

  it('passes a path with spaces as a single argument', async () => {
    spawnMock.mockReturnValue(exitChild(0));

    await openFileInEditor('/abs/my file.ts', undefined, 'darwin');

    expect(spawnMock).toHaveBeenCalledWith('open', ['-a', 'Cursor', '/abs/my file.ts'], SPAWN_OPTS);
  });

  it('uses the system handler on non-darwin platforms', async () => {
    const result = await openFileInEditor('/abs/file.ts', undefined, 'win32');

    expect(result).toEqual({ success: true, editor: 'default' });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(openPathMock).toHaveBeenCalledWith('/abs/file.ts');
  });
});
