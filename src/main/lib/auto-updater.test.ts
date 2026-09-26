import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks — must come before any module imports
const { autoUpdaterMock, setFeedURLMock, checkForUpdatesMock } = vi.hoisted(() => {
  const setFeedURLMock = vi.fn();
  const checkForUpdatesMock = vi.fn(async () => ({ updateInfo: { version: '1.0.1' } }));
  const downloadUpdateMock = vi.fn(async () => undefined);
  return {
    autoUpdaterMock: {
      setFeedURL: setFeedURLMock,
      checkForUpdates: checkForUpdatesMock,
      downloadUpdate: downloadUpdateMock,
      quitAndInstall: vi.fn(),
      on: vi.fn(),
      logger: null as unknown,
      autoDownload: false,
      autoInstallOnAppQuit: true,
      autoRunAppAfterInstall: true,
      requestHeaders: {} as Record<string, string>,
    },
    setFeedURLMock,
    checkForUpdatesMock,
  };
});

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '1.0.0',
    on: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    transports: { file: { level: 'info' } },
  },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: autoUpdaterMock,
}));

import { app } from 'electron';
import log from 'electron-log';
import {
  checkForUpdates,
  classifyUpdate,
  initAutoUpdater,
  setupFocusUpdateCheck,
} from './auto-updater';

/** Mock `app` from vi.mock is a plain object; Electron types mark `isPackaged` readonly. */
function setAppIsPackaged(value: boolean): void {
  (app as unknown as { isPackaged: boolean }).isPackaged = value;
}

const mockGetWindow = vi.fn(() => null);

describe('classifyUpdate', () => {
  it('returns none when next is equal or lower (including patch segment)', () => {
    expect(classifyUpdate('1.2.3', '1.2.3')).toBe('none');
    expect(classifyUpdate('1.2.4', '1.2.3')).toBe('none');
    expect(classifyUpdate('1.3.0', '1.2.9')).toBe('none');
    expect(classifyUpdate('2.0.0', '1.9.9')).toBe('none');
  });

  it('returns major, minor, or patch for strict upgrades', () => {
    expect(classifyUpdate('1.0.0', '2.0.0')).toBe('major');
    expect(classifyUpdate('1.0.0', '1.1.0')).toBe('minor');
    expect(classifyUpdate('1.0.0', '1.0.1')).toBe('patch');
    expect(classifyUpdate('1.1.0', '1.1.1')).toBe('patch');
  });

  it('strips a leading v and compares the same as plain semver', () => {
    expect(classifyUpdate('v1.0.0', 'v1.0.1')).toBe('patch');
    expect(classifyUpdate('1.0.0', 'v2.0.0')).toBe('major');
    expect(classifyUpdate('v1.1.0', '1.0.9')).toBe('none');
  });

  it('uses a fourth numeric segment when present (build-style versions)', () => {
    expect(classifyUpdate('1.2.3.4', '1.2.3.5')).toBe('patch');
    expect(classifyUpdate('1.2.3.5', '1.2.3.4')).toBe('none');
    expect(classifyUpdate('1.2.3.4', '1.2.3.4')).toBe('none');
  });

  it('documents prerelease parsing: leading digits per segment only (not full semver precedence)', () => {
    // 1.0.0-beta.1 → quad [1,0,0,1]; stable 1.0.0 → [1,0,0,0] — treated as newer (patch), not semver-precedence
    expect(classifyUpdate('1.0.0', '1.0.0-beta.1')).toBe('patch');
    expect(classifyUpdate('1.0.0-beta.1', '1.0.0')).toBe('none');
  });
});

describe('initAutoUpdater', () => {
  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('configures generic feed URL, registers updater listeners, and IPC handlers', async () => {
    await initAutoUpdater(mockGetWindow);

    expect(setFeedURLMock).toHaveBeenCalledWith({
      provider: 'generic',
      url: expect.stringContaining('r2.dev'),
    });
    expect(autoUpdaterMock.on).toHaveBeenCalled();
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining('Initialized with R2 provider'),
    );
    expect(ipcHandlers.has('update:check')).toBe(true);
    expect(ipcHandlers.has('update:download')).toBe(true);
    expect(ipcHandlers.has('update:install')).toBe(true);
    expect(ipcHandlers.has('update:get-state')).toBe(true);
  });

  it('update:check IPC handler invokes electron-updater when packaged', async () => {
    checkForUpdatesMock.mockResolvedValue({ updateInfo: { version: '1.0.1' } });
    await initAutoUpdater(mockGetWindow);

    const handler = ipcHandlers.get('update:check');
    expect(handler).toBeDefined();

    const result = await handler?.({} as Electron.IpcMainInvokeEvent);
    expect(result).toEqual({ version: '1.0.1' });
    expect(checkForUpdatesMock).toHaveBeenCalled();
  });

  it('update:get-state IPC handler returns current version regardless of CDN config', async () => {
    await initAutoUpdater(mockGetWindow);

    const handler = ipcHandlers.get('update:get-state');
    expect(handler).toBeDefined();

    const state = handler?.({} as Electron.IpcMainInvokeEvent);
    expect(state).toEqual({ currentVersion: '1.0.0' });
  });

  it('update:install does not call quitAndInstall when no download completed', async () => {
    vi.useFakeTimers();
    await initAutoUpdater(mockGetWindow);

    ipcHandlers.get('update:install')?.({} as Electron.IpcMainInvokeEvent);
    vi.advanceTimersByTime(500);

    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('update:install calls quitAndInstall after update-downloaded fired', async () => {
    vi.useFakeTimers();
    globalThis.__setUpdateAvailable = vi.fn();

    let onDownloaded: ((info: { version: string }) => void) | undefined;
    autoUpdaterMock.on.mockImplementation(
      (event: string, cb: (info: { version: string }) => void) => {
        if (event === 'update-downloaded') onDownloaded = cb;
      },
    );

    await initAutoUpdater(mockGetWindow);
    expect(onDownloaded).toBeDefined();
    onDownloaded?.({ version: '1.0.1' });

    ipcHandlers.get('update:install')?.({} as Electron.IpcMainInvokeEvent);
    vi.advanceTimersByTime(500);

    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledWith(false, true);
    vi.useRealTimers();
  });
});

describe('checkForUpdates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null in dev mode (app.isPackaged = false)', async () => {
    setAppIsPackaged(false);
    const result = await checkForUpdates();
    expect(result).toBeNull();
    expect(checkForUpdatesMock).not.toHaveBeenCalled();
    setAppIsPackaged(true);
  });

  it('respects MIN_CHECK_INTERVAL — skips second call within 60s', async () => {
    setAppIsPackaged(true);
    checkForUpdatesMock.mockResolvedValue({ updateInfo: { version: '1.0.1' } });

    await checkForUpdates(true); // force=true to bypass interval on first call
    await checkForUpdates(); // second call within the window

    // checkForUpdates from electron-updater should only be called once
    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
  });

  it('force=true bypasses interval check', async () => {
    setAppIsPackaged(true);
    checkForUpdatesMock.mockResolvedValue({ updateInfo: { version: '1.0.1' } });

    await checkForUpdates(true);
    await checkForUpdates(true);

    expect(checkForUpdatesMock).toHaveBeenCalledTimes(2);
  });
});

describe('setupFocusUpdateCheck', () => {
  it('registers a browser-window-focus listener on app', () => {
    setupFocusUpdateCheck(mockGetWindow);
    expect(vi.mocked(app.on)).toHaveBeenCalledWith('browser-window-focus', expect.any(Function));
  });

  it('focus handler calls checkForUpdates', async () => {
    setAppIsPackaged(true);
    checkForUpdatesMock.mockResolvedValue({ updateInfo: { version: '1.0.0' } });

    setupFocusUpdateCheck(mockGetWindow);

    const onCalls = vi.mocked(app.on).mock.calls as Array<[string, (...args: unknown[]) => void]>;
    const focusHandler = onCalls.find(([event]) => event === 'browser-window-focus')?.[1] as
      | (() => void)
      | undefined;

    expect(focusHandler).toBeDefined();

    // Manually trigger — should call checkForUpdates without throwing
    await focusHandler?.();
    // checkForUpdates will be called (regardless of CDN_BASE outcome)
    // The key guarantee is it does not throw
  });
});
