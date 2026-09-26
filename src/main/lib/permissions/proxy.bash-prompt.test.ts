/**
 * Regression: promptUserForBashCommand must always settle the Promise on abort/timeout
 * (cleanup() sets resolved=true; resolve() must still run afterward).
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const windowState = { destroyed: false };
const webContents = {
  // Mimic Electron: sending to a destroyed webContents throws ("Object has been destroyed").
  send: vi.fn((_channel: string, _payload?: unknown) => {
    if (windowState.destroyed) throw new Error('Object has been destroyed');
  }),
  on: vi.fn(),
  removeListener: vi.fn(),
};
const mainWindow = {
  isDestroyed: () => windowState.destroyed,
  isVisible: () => true,
  show: vi.fn(),
  focus: vi.fn(),
  webContents,
};

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'home' ? '/home' : '/tmp') },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [mainWindow]),
  },
  ipcMain: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ipcMain } from 'electron';
import { PERMISSION_PROMPT_TIMEOUT_MS } from './constants';
import { promptUserForBashCommand } from './proxy';

describe('promptUserForBashCommand', () => {
  beforeEach(() => {
    windowState.destroyed = false;
    vi.mocked(ipcMain.on).mockClear();
    vi.mocked(ipcMain.removeListener).mockClear();
    webContents.send.mockClear();
  });

  it('resolves denied when abort fires after the prompt is registered', async () => {
    const ac = new AbortController();
    const p = promptUserForBashCommand({
      command: 'echo 1',
      projectPath: '/tmp/p',
      signal: ac.signal,
    });
    queueMicrotask(() => {
      ac.abort();
    });
    await expect(p).resolves.toEqual({ approved: false });
  });

  it('resolves denied when signal is already aborted before await', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      promptUserForBashCommand({
        command: 'echo 2',
        projectPath: '/tmp/p',
        signal: ac.signal,
      }),
    ).resolves.toEqual({ approved: false });
  });

  it('sends permission:dismiss on abort so the renderer pops the stale card', async () => {
    const ac = new AbortController();
    const p = promptUserForBashCommand({
      command: 'echo 3',
      projectPath: '/tmp/p',
      signal: ac.signal,
    });
    queueMicrotask(() => {
      ac.abort();
    });
    await p;
    expect(webContents.send).toHaveBeenCalledWith('permission:dismiss', {
      requestId: expect.any(String),
    });
  });

  it('sends permission:dismiss when the prompt times out', async () => {
    vi.useFakeTimers();
    try {
      const p = promptUserForBashCommand({ command: 'echo 4', projectPath: '/tmp/p' });
      vi.advanceTimersByTime(PERMISSION_PROMPT_TIMEOUT_MS);
      await expect(p).resolves.toEqual({ approved: false });
      expect(webContents.send).toHaveBeenCalledWith('permission:dismiss', {
        requestId: expect.any(String),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not crash when the window is destroyed before the timeout fires', async () => {
    vi.useFakeTimers();
    try {
      const p = promptUserForBashCommand({ command: 'echo 5', projectPath: '/tmp/p' });
      // User closed the window during the 10-min wait. A dismiss send to a destroyed
      // webContents throws in Electron — the timeout must guard isDestroyed().
      windowState.destroyed = true;
      expect(() => vi.advanceTimersByTime(PERMISSION_PROMPT_TIMEOUT_MS)).not.toThrow();
      await expect(p).resolves.toEqual({ approved: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire a dismiss after the user already responded (timer cleared)', async () => {
    vi.useFakeTimers();
    try {
      const p = promptUserForBashCommand({ command: 'echo 6', projectPath: '/tmp/p' });

      const reqCall = webContents.send.mock.calls.find(([ch]) => ch === 'permission:request');
      const requestId = (reqCall?.[1] as { requestId: string }).requestId;
      const onCall = vi
        .mocked(ipcMain.on)
        .mock.calls.find(([event]) => event === 'permission:response');
      const handleResponse = onCall?.[1] as (e: unknown, r: unknown) => void;

      handleResponse({}, { requestId, approved: true });
      await expect(p).resolves.toMatchObject({ approved: true });

      // The 10-min timer must have been cleared by the response — no phantom dismiss later.
      webContents.send.mockClear();
      vi.advanceTimersByTime(PERMISSION_PROMPT_TIMEOUT_MS);
      expect(webContents.send).not.toHaveBeenCalledWith('permission:dismiss', expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });
});
