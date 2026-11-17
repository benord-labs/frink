import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { revealWhenReady } from './reveal';

function fakeWindow(destroyed = false) {
  return Object.assign(new EventEmitter(), {
    webContents: new EventEmitter(),
    isDestroyed: () => destroyed,
  });
}

describe('revealWhenReady', () => {
  it('reveals on did-finish-load on Linux when ready-to-show never fires (Wayland)', () => {
    const window = fakeWindow();
    const reveal = vi.fn();
    revealWhenReady(window, reveal, 'linux');

    window.webContents.emit('did-finish-load');

    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it('reveals only once on Linux when both events fire', () => {
    const window = fakeWindow();
    const reveal = vi.fn();
    revealWhenReady(window, reveal, 'linux');

    window.webContents.emit('did-finish-load');
    window.emit('ready-to-show');
    window.webContents.emit('did-finish-load');

    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it('waits for ready-to-show on macOS and Windows', () => {
    for (const platform of ['darwin', 'win32'] satisfies NodeJS.Platform[]) {
      const window = fakeWindow();
      const reveal = vi.fn();
      revealWhenReady(window, reveal, platform);

      window.webContents.emit('did-finish-load');
      expect(reveal).not.toHaveBeenCalled();

      window.emit('ready-to-show');
      expect(reveal).toHaveBeenCalledTimes(1);
    }
  });

  it('does not reveal a destroyed window', () => {
    const window = fakeWindow(true);
    const reveal = vi.fn();
    revealWhenReady(window, reveal, 'linux');

    window.webContents.emit('did-finish-load');

    expect(reveal).not.toHaveBeenCalled();
  });
});
