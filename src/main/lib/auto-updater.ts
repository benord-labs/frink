import { app, type BrowserWindow, ipcMain, type MenuItemConstructorOptions } from 'electron';
import log from 'electron-log';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import { resolveUpdateFeedUrl } from './updates';

/**
 * IMPORTANT: Do NOT use lazy/dynamic imports for electron-updater!
 *
 * In v0.0.6 we tried using async getAutoUpdater() with dynamic imports,
 * which broke the auto-updater completely. The synchronous import is required
 * for electron-updater to work correctly.
 *
 * See commit d946614c5 for the broken implementation - do not repeat this mistake.
 */

function initAutoUpdaterConfig() {
  log.transports.file.level = 'info';
  autoUpdater.logger = log;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.autoRunAppAfterInstall = true;
}

// Null = no update traffic at all: without setFeedURL electron-updater falls back to app-update.yml
// (the maintainer's feed from package.json), so every entry point checks this (sc-3780).
function configuredFeedUrl(): string | null {
  return resolveUpdateFeedUrl(import.meta.env.MAIN_VITE_UPDATE_FEED_URL);
}

export function isAutoUpdateEnabled(): boolean {
  return configuredFeedUrl() !== null;
}

const LEADING_V_PREFIX = /^v/i;

const MIN_CHECK_INTERVAL = 60 * 1000;
let lastCheckTime: number = 0;

/** Set when `update-downloaded` fires; cleared when install runs. Used by app menu (patch vs download). */
let downloadedUpdateVersion: string | null = null;

let mainWindow: (() => BrowserWindow | null) | null = null;

function sendToRenderer(channel: string, data?: unknown) {
  const win = mainWindow?.();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data);
  }
}

type UpdateClass = 'none' | 'patch' | 'minor' | 'major';

/**
 * Up to four dot-separated leading numeric segments (missing → 0).
 * Covers `1.2.3.4` build-style versions; pre-release tails still parse only leading digits per segment.
 */
export function parseVersionQuad(version: string): [number, number, number, number] {
  const trimmed = version.trim().replace(LEADING_V_PREFIX, '');
  const parts = trimmed.split('.');
  const num = (i: number): number => {
    const raw = parts[i];
    if (raw === undefined) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  };
  return [num(0), num(1), num(2), num(3)];
}

export function compareVersionQuad(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function classifyUpdate(current: string, next: string): UpdateClass {
  const c = parseVersionQuad(current);
  const n = parseVersionQuad(next);

  if (compareVersionQuad(n, c) <= 0) {
    return 'none';
  }
  if (n[0] > c[0]) return 'major';
  if (n[0] === c[0] && n[1] > c[1]) return 'minor';
  return 'patch';
}

export async function initAutoUpdater(getWindow: () => BrowserWindow | null) {
  mainWindow = getWindow;

  initAutoUpdaterConfig();

  const feedUrl = configuredFeedUrl();
  if (!feedUrl) {
    // IPC stays registered so the renderer's invoke calls resolve instead of rejecting.
    registerIpcHandlers();
    log.info('[AutoUpdater] Disabled — MAIN_VITE_UPDATE_FEED_URL not set (fork or self-built)');
    return;
  }

  autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });

  autoUpdater.on('checking-for-update', () => {
    log.info('[AutoUpdater] Checking for updates...');
    sendToRenderer('update:checking');
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    downloadedUpdateVersion = null;
    log.info(`[AutoUpdater] Update available: v${info.version}`);

    const updateType = classifyUpdate(app.getVersion(), info.version);
    log.info(`[AutoUpdater] Update type: ${updateType}`);

    if (updateType === 'none') {
      log.warn(
        `[AutoUpdater] Feed reports v${info.version} but current is v${app.getVersion()} — not treating as upgrade`,
      );
      return;
    }

    if (updateType === 'patch') {
      log.info('[AutoUpdater] Patch update — auto-downloading silently');
      autoUpdater.downloadUpdate().catch((err) => {
        log.error('[AutoUpdater] Silent download failed:', err);
      });
    } else {
      const setUpdateAvailable = globalThis.__setUpdateAvailable;
      if (setUpdateAvailable) {
        setUpdateAvailable(true, info.version);
      }
      sendToRenderer('update:available', {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes,
      });
    }
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    log.info(`[AutoUpdater] App is up to date (v${info.version})`);
    sendToRenderer('update:not-available', {
      version: info.version,
    });
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    log.info(
      `[AutoUpdater] Download progress: ${progress.percent.toFixed(1)}% ` +
        `(${formatBytes(progress.transferred)}/${formatBytes(progress.total)})`,
    );
    sendToRenderer('update:progress', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log.info(`[AutoUpdater] Update downloaded: v${info.version}`);

    const setUpdateAvailable = globalThis.__setUpdateAvailable;
    if (setUpdateAvailable) {
      setUpdateAvailable(false);
    }

    const updateType = classifyUpdate(app.getVersion(), info.version);
    if (updateType === 'none') {
      log.warn(
        `[AutoUpdater] Ignoring downloaded build: v${info.version} is not newer than v${app.getVersion()}`,
      );
      return;
    }

    downloadedUpdateVersion = info.version;

    const payload = {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes,
    };

    if (updateType !== 'patch') {
      sendToRenderer('update:downloaded', payload);
    } else {
      log.info('[AutoUpdater] Patch update downloaded — will install on quit');
      if (setUpdateAvailable) {
        setUpdateAvailable(true, info.version);
      }
      sendToRenderer('update:downloaded', { ...payload, silent: true });
    }
  });

  autoUpdater.on('error', (error: Error) => {
    log.error('[AutoUpdater] Error:', error.message);
    sendToRenderer('update:error', error.message);
  });

  registerIpcHandlers();

  log.info(`[AutoUpdater] Initialized with generic feed ${feedUrl}`);
}

function registerIpcHandlers() {
  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) {
      log.info('[AutoUpdater] Skipping update check in dev mode');
      return null;
    }
    if (!isAutoUpdateEnabled()) return null;
    try {
      const result = await autoUpdater.checkForUpdates();
      return result?.updateInfo || null;
    } catch (error) {
      log.error('[AutoUpdater] Check failed:', error);
      return null;
    }
  });

  ipcMain.handle('update:download', async () => {
    if (!isAutoUpdateEnabled()) return false;
    try {
      await autoUpdater.downloadUpdate();
      return true;
    } catch (error) {
      log.error('[AutoUpdater] Download failed:', error);
      return false;
    }
  });

  ipcMain.handle('update:install', () => {
    installDownloadedUpdate();
  });

  ipcMain.handle('update:get-state', () => {
    return {
      currentVersion: app.getVersion(),
    };
  });
}

export async function checkForUpdates(force = false) {
  if (!app.isPackaged) {
    log.info('[AutoUpdater] Skipping update check in dev mode');
    return Promise.resolve(null);
  }
  if (!isAutoUpdateEnabled()) return Promise.resolve(null);

  const now = Date.now();
  if (!force && now - lastCheckTime < MIN_CHECK_INTERVAL) {
    log.info(
      `[AutoUpdater] Skipping check - last check was ${Math.round((now - lastCheckTime) / 1000)}s ago`,
    );
    return Promise.resolve(null);
  }

  lastCheckTime = now;
  return autoUpdater.checkForUpdates();
}

/** Whether a build is already downloaded and can be installed (restart) from the app menu. */
function isUpdateDownloadedPending(): boolean {
  return downloadedUpdateVersion !== null;
}

function installDownloadedUpdate(): void {
  if (!isUpdateDownloadedPending()) {
    log.warn('[AutoUpdater] quitAndInstall requested but no update download is pending');
    return;
  }
  log.info('[AutoUpdater] Installing update and restarting...');
  downloadedUpdateVersion = null;
  setTimeout(() => {
    autoUpdater.quitAndInstall(false, true);
  }, 100);
}

export async function downloadUpdate() {
  if (!app.isPackaged) {
    log.info('[AutoUpdater] Skipping download in dev mode');
    return false;
  }
  if (!isAutoUpdateEnabled()) return false;

  try {
    log.info('[AutoUpdater] Starting update download...');
    await autoUpdater.downloadUpdate();
    return true;
  } catch (error) {
    log.error('[AutoUpdater] Download failed:', error);
    return false;
  }
}

/**
 * The app menu's update item. Hidden in builds without a feed (forks, self-built): there is no
 * updater to offer, and every action below would no-op anyway.
 */
export function buildUpdateMenuItem(
  getWindow: () => BrowserWindow | null,
  update: { available: boolean; version: string | null },
): MenuItemConstructorOptions {
  return {
    label: update.available ? `Update to v${update.version}...` : 'Check for Updates...',
    visible: isAutoUpdateEnabled(),
    click: () => {
      // Clears the renderer's dismiss state so the banner shows again.
      getWindow()?.webContents.send('update:manual-check');
      if (!update.available) {
        checkForUpdates(true);
      } else if (isUpdateDownloadedPending()) {
        installDownloadedUpdate();
      } else {
        downloadUpdate();
      }
    },
  };
}

export function setupFocusUpdateCheck(_getWindow: () => BrowserWindow | null) {
  if (!isAutoUpdateEnabled()) return;
  app.on('browser-window-focus', () => {
    log.info('[AutoUpdater] Window focused - checking for updates');
    checkForUpdates();
  });
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}
