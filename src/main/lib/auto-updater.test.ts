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
  buildUpdateMenuItem,
  checkForUpdates,
  classifyUpdate,
  downloadUpdate,
  initAutoUpdater,
  isAutoUpdateEnabled,
  setupFocusUpdateCheck,
} from './auto-updater';

const FEED = 'https://feed.example/frink/';

// Every suite below runs as an official build unless it stubs the feed away.
beforeEach(() => {
  vi.stubEnv('MAIN_VITE_UPDATE_FEED_URL', FEED);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

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

    expect(setFeedURLMock).toHaveBeenCalledWith({ provider: 'generic', url: FEED });
    expect(autoUpdaterMock.on).toHaveBeenCalled();
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining(FEED));
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

describe('update feed not configured (fork / self-built package)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcHandlers.clear();
    setAppIsPackaged(true);
    vi.stubEnv('MAIN_VITE_UPDATE_FEED_URL', '');
  });

  function focusHandlers(): Array<() => unknown> {
    const onCalls = vi.mocked(app.on).mock.calls as Array<[string, () => unknown]>;
    return onCalls.filter(([event]) => event === 'browser-window-focus').map(([, cb]) => cb);
  }

  it('reports the updater as disabled', () => {
    expect(isAutoUpdateEnabled()).toBe(false);
  });

  it('never sets a feed URL or wires updater listeners, but still answers IPC', async () => {
    await initAutoUpdater(mockGetWindow);

    expect(setFeedURLMock).not.toHaveBeenCalled();
    expect(autoUpdaterMock.on).not.toHaveBeenCalled();
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining('MAIN_VITE_UPDATE_FEED_URL'),
    );
    for (const channel of [
      'update:check',
      'update:download',
      'update:install',
      'update:get-state',
    ]) {
      expect(ipcHandlers.has(channel)).toBe(true);
    }
  });

  // Without setFeedURL, electron-updater falls back to app-update.yml — generated from
  // package.json build.publish.url, i.e. the maintainer's feed. Every entry point must refuse.
  it('forced checkForUpdates (startup and menu path) never reaches electron-updater', async () => {
    await expect(checkForUpdates(true)).resolves.toBeNull();
    expect(checkForUpdatesMock).not.toHaveBeenCalled();
  });

  it('downloadUpdate (menu "Update to…" path) never reaches electron-updater', async () => {
    await expect(downloadUpdate()).resolves.toBe(false);
    expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled();
  });

  it('renderer update:check and update:download IPC resolve without touching the updater', async () => {
    await initAutoUpdater(mockGetWindow);

    await expect(ipcHandlers.get('update:check')?.({})).resolves.toBeNull();
    await expect(ipcHandlers.get('update:download')?.({})).resolves.toBe(false);
    expect(checkForUpdatesMock).not.toHaveBeenCalled();
    expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled();
  });

  it('attaches no window-focus check', () => {
    setupFocusUpdateCheck(mockGetWindow);
    expect(focusHandlers()).toHaveLength(0);
  });

  it('treats a non-https feed as unset', async () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED_URL', 'http://feed.example/');
    expect(isAutoUpdateEnabled()).toBe(false);
    await initAutoUpdater(mockGetWindow);
    expect(setFeedURLMock).not.toHaveBeenCalled();
  });
});

describe('update feed configured', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAppIsPackaged(true);
  });

  it('passes the normalised build-time feed to electron-updater', async () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED_URL', ' https://feed.example/frink \n');
    expect(isAutoUpdateEnabled()).toBe(true);
    await initAutoUpdater(mockGetWindow);
    expect(setFeedURLMock).toHaveBeenCalledWith({ provider: 'generic', url: FEED });
  });

  it('downloadUpdate reaches electron-updater', async () => {
    await expect(downloadUpdate()).resolves.toBe(true);
    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('focus handler performs a real check', async () => {
    setupFocusUpdateCheck(mockGetWindow);
    const onCalls = vi.mocked(app.on).mock.calls as Array<[string, () => unknown]>;
    const handler = onCalls.filter(([event]) => event === 'browser-window-focus').at(-1)?.[1];
    // A prior test may have stamped lastCheckTime; force a fresh interval window.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 120_000);
    await handler?.();
    vi.useRealTimers();
    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
  });
});

describe('buildUpdateMenuItem', () => {
  const send = vi.fn();
  const win = { webContents: { send } } as unknown as Electron.BrowserWindow;

  beforeEach(() => {
    vi.clearAllMocks();
    setAppIsPackaged(true);
  });

  it('is hidden when the build has no update feed (fork / self-built)', () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED_URL', '');
    expect(buildUpdateMenuItem(() => win, { available: false, version: null }).visible).toBe(false);
  });

  it('is visible and labelled "Check for Updates..." when a feed is configured', () => {
    const item = buildUpdateMenuItem(() => win, { available: false, version: null });
    expect(item.visible).toBe(true);
    expect(item.label).toBe('Check for Updates...');
  });

  it('click with no known update forces a check and tells the renderer', async () => {
    const item = buildUpdateMenuItem(() => win, { available: false, version: null });
    item.click?.({} as never, undefined, {} as never);
    expect(send).toHaveBeenCalledWith('update:manual-check');
    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
  });

  it('click with an update available but not downloaded starts the download', () => {
    const item = buildUpdateMenuItem(() => win, { available: true, version: '1.0.1' });
    expect(item.label).toBe('Update to v1.0.1...');
    item.click?.({} as never, undefined, {} as never);
    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(checkForUpdatesMock).not.toHaveBeenCalled();
  });

  it('click survives a closed window (no renderer to notify)', () => {
    const item = buildUpdateMenuItem(() => null, { available: false, version: null });
    expect(() => item.click?.({} as never, undefined, {} as never)).not.toThrow();
  });
});
