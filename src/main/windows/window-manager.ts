import { BrowserWindow } from 'electron';

/**
 * Tracks the application's windows (Frink is single-window) for focus resolution and lookup.
 */
class WindowManager {
  private windows: Map<number, BrowserWindow> = new Map();
  private focusedWindowId: number | null = null;

  /** Register a window with the manager so it can be focused / looked up. */
  register(window: BrowserWindow): void {
    const electronId = window.id;
    this.windows.set(electronId, window);

    // Track focus
    window.on('focus', () => {
      this.focusedWindowId = electronId;
    });

    // Clean up on close
    window.on('closed', () => {
      this.windows.delete(electronId);
      if (this.focusedWindowId === electronId) {
        this.focusedWindowId = null;
      }
    });

    if (this.windows.size === 1) {
      this.focusedWindowId = electronId;
    }
  }

  /** Unregister a window */
  unregister(window: BrowserWindow): void {
    this.windows.delete(window.id);
    if (this.focusedWindowId === window.id) {
      this.focusedWindowId = null;
    }
  }

  /** Get a window by Electron ID */
  get(id: number): BrowserWindow | undefined {
    return this.windows.get(id);
  }

  /** Get the currently focused window */
  getFocused(): BrowserWindow | null {
    if (this.focusedWindowId !== null) {
      const win = this.windows.get(this.focusedWindowId);
      if (win && !win.isDestroyed()) {
        return win;
      }
    }
    const focusedWin = BrowserWindow.getFocusedWindow();
    if (focusedWin && !focusedWin.isDestroyed()) {
      return focusedWin;
    }
    return null;
  }

  /** Get all active windows */
  getAll(): BrowserWindow[] {
    return Array.from(this.windows.values()).filter((w) => !w.isDestroyed());
  }

  /** Get the number of active windows */
  count(): number {
    return this.windows.size;
  }

  /** Find window by webContents ID */
  findByWebContentsId(webContentsId: number): BrowserWindow | undefined {
    for (const window of this.windows.values()) {
      if (!window.isDestroyed() && window.webContents.id === webContentsId) {
        return window;
      }
    }
    return undefined;
  }
}

// Singleton instance
export const windowManager = new WindowManager();
