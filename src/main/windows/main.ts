/* eslint-disable max-lines, max-lines-per-function */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
} from 'electron';
import log from 'electron-log';
import { createIPCHandler, ELECTRON_TRPC_CHANNEL } from 'trpc-electron/main';
import { isAllowedShellOpenExternalUrl } from '../../shared/shell-external-url';
import { registerGitWatcherIPC } from '../lib/git/watcher';
import { setupLanguageServerIPC } from '../lib/language-server/transports';
import { shellOpenExternalGuarded } from '../lib/open-external-guarded';
import { createAppRouter } from '../lib/trpc/routers';
import { registerArtifactPreviewIpc } from '.';
import { attachAgentAbortOnRendererLifecycle } from './navigation-abort';
import { windowManager } from './window-manager';

// Default zoom factor — the app was designed at this zoom level
// The design was accidental and will be re-designed over time
export const DEFAULT_ZOOM_FACTOR = 0.9;

// Register IPC handlers for window operations (only once)
let ipcHandlersRegistered: boolean = false;

function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  if (ipcHandlersRegistered) return;
  ipcHandlersRegistered = true;

  // App info
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:isPackaged', () => app.isPackaged);

  // Windows: Frame preference persistence
  ipcMain.handle('window:set-frame-preference', (_event, useNativeFrame: boolean) => {
    try {
      writeWindowSettings({ useNativeFrame });
      return true;
    } catch (_error) {
      return false;
    }
  });

  // Windows: Get current window frame state
  ipcMain.handle('window:get-frame-state', () => {
    if (process.platform !== 'win32') return false;
    const settings = readWindowSettings();
    return settings.useNativeFrame === true;
  });

  // Note: Update checking is now handled by auto-updater module (lib/auto-updater.ts)
  ipcMain.handle('app:set-badge', (_event, count: number | null) => {
    const win = getWindow();
    if (process.platform === 'darwin') {
      app.dock?.setBadge(count ? String(count) : '');
    } else if (process.platform === 'win32' && win) {
      // Windows: Update title with count as fallback
      if (count !== null && count > 0) {
        win.setTitle(`Frink (${count})`);
      } else {
        win.setTitle('Frink');
        win.setOverlayIcon(null, '');
      }
    }
  });

  // Windows: Badge overlay icon
  ipcMain.handle('app:set-badge-icon', (_event, imageData: string | null) => {
    const win = getWindow();
    if (process.platform === 'win32' && win) {
      if (imageData) {
        const image = nativeImage.createFromDataURL(imageData);
        win.setOverlayIcon(image, 'New messages');
      } else {
        win.setOverlayIcon(null, '');
      }
    }
  });

  ipcMain.handle('app:show-notification', (_event, options: { title: string; body: string }) => {
    try {
      const { Notification } = require('electron');
      const iconPath = join(__dirname, '../../../build/icon.ico');
      const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

      const notification = new Notification({
        title: options.title,
        body: options.body,
        icon,
        ...(process.platform === 'win32' && { silent: false }),
      });

      notification.show();

      notification.on('click', () => {
        const win = getWindow();
        if (win) {
          if (win.isMinimized()) win.restore();
          win.focus();
        }
      });
    } catch (_error) {}
  });

  // Window controls
  ipcMain.handle('window:minimize', () => getWindow()?.minimize());
  ipcMain.handle('window:maximize', () => {
    const win = getWindow();
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });
  ipcMain.handle('window:close', () => getWindow()?.close());
  ipcMain.handle('window:is-maximized', () => getWindow()?.isMaximized() ?? false);
  ipcMain.handle('window:toggle-fullscreen', () => {
    const win = getWindow();
    if (win) {
      win.setFullScreen(!win.isFullScreen());
    }
  });
  ipcMain.handle('window:is-fullscreen', () => getWindow()?.isFullScreen() ?? false);

  // Zoom controls (persisted to window-settings.json). Cmd+Shift+Plus/Minus handled by renderer (zoom + grow/shrink pane).
  ipcMain.handle('window:zoom-in', doZoomIn);
  ipcMain.handle('window:zoom-out', doZoomOut);
  ipcMain.handle('window:zoom-reset', () => {
    const win = getWindow();
    if (win) {
      win.webContents.setZoomFactor(DEFAULT_ZOOM_FACTOR);
      writeWindowSettings({ zoomFactor: DEFAULT_ZOOM_FACTOR });
    }
  });
  ipcMain.handle(
    'window:get-zoom',
    () => getWindow()?.webContents.getZoomFactor() ?? DEFAULT_ZOOM_FACTOR,
  );

  // DevTools - only allowed in dev mode or when unlocked
  ipcMain.handle('window:toggle-devtools', () => {
    const win = getWindow();
    // Check if devtools are unlocked (or in dev mode)
    const isUnlocked = !app.isPackaged || globalThis.__devToolsUnlocked;
    if (win && isUnlocked) {
      win.webContents.toggleDevTools();
    }
  });

  // Unlock DevTools (hidden feature - 5 clicks on Beta tab)
  ipcMain.handle('window:unlock-devtools', () => {
    // Mark as unlocked locally for IPC check
    globalThis.__devToolsUnlocked = true;
    // Call the global function to rebuild menu
    if (globalThis.__unlockDevTools) {
      globalThis.__unlockDevTools();
    }
  });

  // Analytics
  ipcMain.handle('analytics:set-opt-out', async (_event, optedOut: boolean) => {
    const { setOptOut } = await import('../lib/analytics');
    setOptOut(optedOut);
  });

  // Shell — only http(s)/mailto (defense in depth vs renderer)
  ipcMain.handle('shell:open-external', (_event, url: string) => shellOpenExternalGuarded(url));

  // Clipboard
  ipcMain.handle('clipboard:write', (_event, text: string) => clipboard.writeText(text));
  ipcMain.handle('clipboard:read', () => clipboard.readText());

  registerGitWatcherIPC(getWindow);
  registerArtifactPreviewIpc(() => currentWindow);
}

// Current window reference
let currentWindow: BrowserWindow | null = null;

// Singleton IPC handler (prevents duplicate handlers on macOS window recreation)
let ipcHandler: ReturnType<typeof createIPCHandler> | null = null;

/**
 * Get the current window reference (focused window, or main window fallback).
 * Used by tRPC procedures that need window access.
 */
export function getWindow(): BrowserWindow | null {
  // Prefer the live focused window; fall back to the stored reference.
  const focused = windowManager.getFocused();
  if (focused) return focused;
  return currentWindow;
}

/**
 * Read all window settings from disk.
 */
function readWindowSettings(): Record<string, unknown> {
  try {
    const settingsPath = join(app.getPath('userData'), 'window-settings.json');
    if (existsSync(settingsPath)) {
      return JSON.parse(readFileSync(settingsPath, 'utf-8'));
    }
  } catch {
    // Ignore read errors
  }
  return {};
}

/**
 * Merge and persist window settings to disk.
 */
export function writeWindowSettings(updates: Record<string, unknown>): void {
  const settingsPath = join(app.getPath('userData'), 'window-settings.json');
  const settingsDir = app.getPath('userData');
  mkdirSync(settingsDir, { recursive: true });
  const current = readWindowSettings();
  writeFileSync(settingsPath, JSON.stringify({ ...current, ...updates }, null, 2));
}

/** Zoom in (menu and IPC). Cmd+Shift+Plus is reserved for renderer: zoom + grow pane. */
export function doZoomIn(): void {
  const win = getWindow();
  if (win) {
    const zoom = Math.min(win.webContents.getZoomFactor() + 0.1, 3);
    win.webContents.setZoomFactor(zoom);
    writeWindowSettings({ zoomFactor: Math.round(zoom * 100) / 100 });
  }
}

/** Zoom out (menu and IPC). Cmd+Shift+Minus is reserved for renderer: zoom + shrink pane. */
export function doZoomOut(): void {
  const win = getWindow();
  if (win) {
    const zoom = Math.max(win.webContents.getZoomFactor() - 0.1, 0.5);
    win.webContents.setZoomFactor(zoom);
    writeWindowSettings({ zoomFactor: Math.round(zoom * 100) / 100 });
  }
}

/**
 * Read window frame preference from settings file (Windows only)
 * Returns true if native frame should be used, false for frameless
 */
function getUseNativeFramePreference(): boolean {
  if (process.platform !== 'win32') return false;
  const settings = readWindowSettings();
  return settings.useNativeFrame === true;
}

/**
 * Read persisted zoom factor, falling back to the designed default.
 */
function getPersistedZoomFactor(): number {
  const settings = readWindowSettings();
  if (
    typeof settings.zoomFactor === 'number' &&
    settings.zoomFactor >= 0.5 &&
    settings.zoomFactor <= 3
  ) {
    return settings.zoomFactor;
  }
  return DEFAULT_ZOOM_FACTOR;
}

/**
 * Create the main application window
 */
export function createMainWindow(): BrowserWindow {
  // Register IPC handlers before creating window
  registerIpcHandlers(getWindow);
  setupLanguageServerIPC(getWindow);

  // Read Windows frame preference
  const useNativeFrame = getUseNativeFramePreference();

  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 500, // Allow narrow mobile-like mode
    minHeight: 600,
    show: false,
    title: 'Frink',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#050505' : '#ffffff',
    // hiddenInset shows native traffic lights inset; they start off-screen (custom ones show in
    // normal mode) and move on-screen in fullscreen.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 15, y: 12 } : undefined,
    // Windows: Use native frame or frameless based on user preference
    ...(process.platform === 'win32' && {
      frame: useNativeFrame,
      autoHideMenuBar: true,
    }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // Required for electron-trpc
      webSecurity: true,
      partition: 'persist:main', // Use persistent session for cookies
      plugins: true, // Required for Chromium PDF viewer in iframe
      backgroundThrottling: !process.env.FRINK_CDP_PORT, // QA instances are driven unfocused
    },
  });

  // Update current window reference and register with window manager
  currentWindow = window;
  windowManager.register(window);

  // Setup tRPC IPC handler (singleton pattern)
  if (ipcHandler) {
    // Reuse existing handler, just attach new window
    ipcHandler.attachWindow(window);
  } else {
    // Defensive: strip any prior listeners on this channel before creating the
    // fresh handler. Not load-bearing under electron-vite's main restart model,
    // but cheap protection if future dev workflows HMR main without restart.
    ipcMain.removeAllListeners(ELECTRON_TRPC_CHANNEL);

    ipcHandler = createIPCHandler({
      router: createAppRouter(getWindow),
      windows: [window],
      createContext: async (opts) => ({
        getWindow,
        senderWebContentsId: opts?.event?.sender?.id,
      }),
    });
  }

  // Show window when ready
  window.on('ready-to-show', () => {
    // Apply persisted zoom factor (or default)
    window.webContents.setZoomFactor(getPersistedZoomFactor());

    // Ensure native traffic lights are visible by default (login page, loading states)
    if (process.platform === 'darwin') {
      window.setWindowButtonVisibility(true);
    }
    window.show();
  });

  // Emit fullscreen change events and manage traffic lights
  window.on('enter-full-screen', () => {
    // Always show native traffic lights in fullscreen
    if (process.platform === 'darwin') {
      window.setWindowButtonVisibility(true);
    }
    window.webContents.send('window:fullscreen-change', true);
  });
  window.on('leave-full-screen', () => {
    // Show native traffic lights when exiting fullscreen (macOS hides them during the transition)
    if (process.platform === 'darwin') {
      window.setWindowButtonVisibility(true);
    }
    window.webContents.send('window:fullscreen-change', false);
  });

  // Emit focus change events
  window.on('focus', () => {
    window.webContents.send('window:focus-change', true);
  });
  window.on('blur', () => {
    window.webContents.send('window:focus-change', false);
  });

  // Disable Cmd+R / Ctrl+R to prevent accidental page refresh
  // Users can still use Cmd+Shift+R / Ctrl+Shift+R for intentional reloads
  window.webContents.on('before-input-event', (event, input) => {
    const isMac = process.platform === 'darwin';
    const modifierKey = isMac ? input.meta : input.control;
    if (modifierKey && input.key.toLowerCase() === 'r' && !input.shift) {
      event.preventDefault();
    }
  });

  // Handle external links (deny new window; same allowlist as shell:open-external)
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedShellOpenExternalUrl(url)) {
      return { action: 'deny' };
    }
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Handle window close
  window.on('closed', () => {
    currentWindow = null;
  });

  // Load the renderer. Signing in is a feature of the app, not a precondition for it.
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) {
    window.loadURL(devServerUrl);
    // Only open DevTools automatically in development
    if (!app.isPackaged) {
      window.webContents.openDevTools();
    }
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // Ensure traffic lights are visible after page load (covers reload/Cmd+R case)
  window.webContents.on('did-finish-load', () => {
    if (process.platform === 'darwin') {
      window.setWindowButtonVisibility(true);
    }
  });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    log.error('[Window] Failed to load:', { errorCode, errorDescription, validatedURL });
  });

  // Renderer crash / hard navigation (cmd+shift+r): tear down window-scoped agents only.
  attachAgentAbortOnRendererLifecycle(window.webContents);

  window.on('unresponsive', () => {
    log.error('[Window] Window became unresponsive');
  });

  return window;
}
