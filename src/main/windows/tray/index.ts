import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron';
import { getDatabase } from '../../lib/db';
import { getPreference, setPreference } from '../../lib/db/repos/composer-settings';
import { subscribeFlowEvents } from '../../lib/flows/events';
import { executionReady } from '../../lib/mobile/domain/context';
import { resolveElectronResourcePath } from '../../lib/platform/electron-resource-path';
import { onPermissionRequest, onPermissionResponse } from '../../lib/socket/client';
import { subscribeSessionCompletions } from '../../lib/socket/streaming/live-stream/completion-events';
import { bringToFront } from '../../lib/window';
import { createTrayController, type TrayStatus } from './controller';
import type { TrayTarget } from './model';
import { answerTrayRequest, readTraySaved, readTrayLive } from './sources';

type OpenWindow = (search?: URLSearchParams) => BrowserWindow;

const SHOW_TRAY_KEY = 'tray.showStatus';
const TICK_MS = 5_000;
const SAVED_FALLBACK_MS = 60_000;

let openWindow: OpenWindow | null = null;
let stopTray: (() => void) | null = null;

function icon(alert: boolean) {
  const mac = process.platform === 'darwin';
  // Black template glyphs vanish on a dark Windows taskbar, so other systems use the colour mark.
  const name = `tray${alert ? 'Alert' : ''}${mac ? 'Template' : ''}.png`;
  const image = nativeImage.createFromPath(
    resolveElectronResourcePath(app, {
      development: ['resources', 'tray', name],
      packaged: ['tray', name],
    }),
  );
  image.setTemplateImage(mac);
  return image;
}

/** Brings Frink's window forward and returns it; a window closed on macOS reopens at `search`. */
function showFrink(search?: URLSearchParams): BrowserWindow | undefined {
  const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
  if (!window) return void openWindow?.(search);
  bringToFront(window);
  return window;
}

function createTray(): () => void {
  const tray = new Tray(icon(false));
  let alert = false;
  // The previous menu stays referenced until its click has been delivered.
  let menus: Menu[] = [];
  const setStatus = ({ alert: next, count, summary }: TrayStatus) => {
    if (next !== alert) tray.setImage(icon((alert = next)));
    tray.setToolTip(`Frink: ${summary}`);
    if (process.platform === 'darwin')
      tray.setTitle(count ? String(count) : '', { fontType: 'monospacedDigit' });
  };
  const controller = createTrayController({
    view: {
      setStatus,
      setMenu: (template) => {
        const menu = Menu.buildFromTemplate(template);
        menu.on('menu-will-show', controller.menuOpened);
        menu.on('menu-will-close', controller.menuClosed);
        menus = [...menus.slice(-1), menu];
        tray.setContextMenu(menu);
      },
    },
    readLive: () => readTrayLive(executionReady()),
    readSaved: readTraySaved,
    respond: answerTrayRequest,
    actions: {
      open: (target: TrayTarget) =>
        showFrink(
          new URLSearchParams('chatId' in target ? { chat: target.chatId } : { view: target.view }),
        )?.webContents.send('tray:open', target),
      newChat: () =>
        showFrink(new URLSearchParams({ newChat: '1' }))?.webContents.send('shortcut:new-agent'),
      openFrink: () => void showFrink(),
      quit: () => app.quit(),
    },
    platform: process.platform,
    now: Date.now,
    defer: (run) => setTimeout(run, 0),
    schedule: (run, ms) => setTimeout(run, ms),
  });
  // Windows opens a tray menu on right-click only; a left-click should show the status too.
  if (process.platform === 'win32') tray.on('click', () => tray.popUpContextMenu());
  const timers = [
    setInterval(controller.render, TICK_MS),
    setInterval(controller.loadSoon, SAVED_FALLBACK_MS),
  ];
  for (const timer of timers) timer.unref();
  const unsubscribe = [
    onPermissionRequest(controller.render),
    onPermissionResponse(controller.render),
    subscribeSessionCompletions(controller.noteCompletion),
    subscribeFlowEvents(controller.loadSoon),
  ];
  controller.loadSoon();
  controller.render();
  return () => {
    controller.stop();
    for (const timer of timers) clearInterval(timer);
    for (const stop of unsubscribe) stop();
    tray.destroy();
  };
}

export const getTrayEnabled = (): boolean =>
  getPreference<boolean>(getDatabase(), SHOW_TRAY_KEY) ?? true;

/** Shows Frink's status in the menu bar (system tray) once; safe to call for every new window. */
export function startTray(open: OpenWindow): void {
  openWindow = open;
  if (stopTray || !getTrayEnabled()) return;
  stopTray = createTray();
  app.once('before-quit', disposeTray);
}

function disposeTray(): void {
  if (!stopTray) return;
  stopTray();
  stopTray = null;
  app.off('before-quit', disposeTray);
}

/** Linux keeps a removed tray icon registered until Frink restarts, so it applies there on launch. */
export function setTrayEnabled(enabled: boolean): boolean {
  setPreference(getDatabase(), SHOW_TRAY_KEY, enabled);
  if (process.platform === 'linux') return enabled;
  if (!enabled) disposeTray();
  else if (openWindow) startTray(openWindow);
  return enabled;
}
