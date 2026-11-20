import { app, BrowserWindow, ipcMain, type MenuItemConstructorOptions } from 'electron';
import { LEAVE_CHANNELS, type LeaveReason } from '../../shared/leave-reason';

/** A renderer that has not acknowledged a leave request by then is treated as hung. */
export const LEAVE_ACK_TIMEOUT_MS = 10_000;

type GuardApp = {
  on: (event: 'before-quit', listener: () => void) => void;
  quit: () => void;
};
/** The renderer's answers; only the main window's own webContents is listened to. */
type GuardIpc = {
  on: (channel: string, listener: (event: { sender: object }, value?: boolean) => void) => void;
};
type GuardWebContents = {
  isDestroyed: () => boolean;
  isCrashed: () => boolean;
  send: (channel: string, reason: LeaveReason) => void;
  on: (
    event: 'did-start-navigation',
    listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void,
  ) => void;
};
/** The parts of the main BrowserWindow the guard uses. */
type GuardWindow = {
  webContents: GuardWebContents;
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  show: () => void;
  focus: () => void;
  close: () => void;
  on: {
    (event: 'close', listener: (event: { preventDefault: () => void }) => void): void;
    (event: 'closed', listener: () => void): void;
  };
};

export type LeaveGuard = {
  attach: (window: GuardWindow) => void;
  /** Runs `leave` now, or once the renderer confirms its unsaved editor tabs may go. */
  requestLeave: (reason: LeaveReason, leave: () => void) => void;
};

/** A quit or update outranks a close or reload asked for while its prompt is open. */
const outranks = (a: LeaveReason, b: LeaveReason) =>
  (a === 'quit' || a === 'update') && b !== 'quit' && b !== 'update';

export function createLeaveGuard({ app, ipc }: { app: GuardApp; ipc: GuardIpc }): LeaveGuard {
  let win: GuardWindow | null = null;
  let hasUnsaved = false;
  let quitting = false;
  let confirmed = false;
  let pending: { reason: LeaveReason; leave: () => void } | null = null;
  let ackTimer: ReturnType<typeof setTimeout> | undefined;

  const clearAck = () => {
    clearTimeout(ackTimer);
    ackTimer = undefined;
  };
  const canAsk = (): boolean =>
    hasUnsaved &&
    win !== null &&
    !win.isDestroyed() &&
    !win.webContents.isDestroyed() &&
    !win.webContents.isCrashed();
  const fromWindow = (event: { sender: object }) =>
    win !== null && event.sender === win.webContents;

  const proceed = () => {
    const current = pending;
    pending = null;
    clearAck();
    if (!current) return;
    // A reload keeps the window, so its next close must ask again.
    if (current.reason !== 'reload') confirmed = true;
    current.leave();
  };

  const requestLeave = (reason: LeaveReason, leave: () => void) => {
    if (!canAsk() || !win) return leave();
    if (pending && outranks(pending.reason, reason)) return;
    pending = { reason, leave };
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send(LEAVE_CHANNELS.request, reason);
    clearAck();
    ackTimer = setTimeout(proceed, LEAVE_ACK_TIMEOUT_MS);
  };

  app.on('before-quit', () => {
    quitting = true;
  });
  ipc.on(LEAVE_CHANNELS.setUnsaved, (event, value) => {
    if (!fromWindow(event)) return;
    // Edits made after a confirmed leave that never happened (an update that did not install) ask again.
    if (value === true && !hasUnsaved) confirmed = false;
    hasUnsaved = value === true;
  });
  ipc.on(LEAVE_CHANNELS.ack, (event) => {
    if (fromWindow(event)) clearAck();
  });
  ipc.on(LEAVE_CHANNELS.confirm, (event) => {
    if (fromWindow(event)) proceed();
  });
  ipc.on(LEAVE_CHANNELS.cancel, (event) => {
    if (!fromWindow(event)) return;
    pending = null;
    clearAck();
  });

  const attach = (window: GuardWindow) => {
    win = window;
    hasUnsaved = false;
    confirmed = false;
    pending = null;
    clearAck();
    window.on('close', (event) => {
      const reason: LeaveReason = quitting ? 'quit' : 'close';
      // Vetoing the close cancels Electron's quit too; a confirmed quit starts it again.
      quitting = false;
      if (confirmed || !canAsk()) return;
      event.preventDefault();
      requestLeave(reason, reason === 'quit' ? () => app.quit() : () => window.close());
    });
    window.on('closed', () => {
      if (win !== window) return;
      win = null;
      pending = null;
      clearAck();
    });
    // A new document has no unsaved tabs until it says so; a crashed one is never waited on.
    window.webContents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      // The page that showed any open prompt is gone; a prompt left pending would outrank later closes.
      hasUnsaved = false;
      pending = null;
      clearAck();
    });
  };

  return { attach, requestLeave };
}

let shared: LeaveGuard | null = null;

/** The main window's guard; created on first use so its listeners register once. */
export function getLeaveGuard(): LeaveGuard {
  shared ??= createLeaveGuard({ app, ipc: ipcMain });
  return shared;
}

type ReloadableWindow = { webContents: { reloadIgnoringCache: () => void } };

/**
 * Force Reload: the main window reloads only once its unsaved tabs are answered for; another
 * focused window (an artifact preview) holds none and reloads at once, as the menu role did.
 */
export function forceReload(
  main: ReloadableWindow | null,
  focused: ReloadableWindow | null,
  guard: Pick<LeaveGuard, 'requestLeave'>,
): void {
  if (focused && focused !== main) return focused.webContents.reloadIgnoringCache();
  if (main) guard.requestLeave('reload', () => main.webContents.reloadIgnoringCache());
}

/** View → Force Reload (Shift+Cmd/Ctrl+R). */
export function forceReloadMenuItem(
  getWindow: () => BrowserWindow | null,
): MenuItemConstructorOptions {
  return {
    label: 'Force Reload',
    accelerator: 'Shift+CmdOrCtrl+R',
    click: () => forceReload(getWindow(), BrowserWindow.getFocusedWindow(), getLeaveGuard()),
  };
}
