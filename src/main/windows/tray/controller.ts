import type { MenuItemConstructorOptions } from 'electron';
import log from 'electron-log';
import { buildTrayMenu, traySummary, type TrayMenuActions } from './menu';
import {
  buildTrayModel,
  chatIdsIn,
  EMPTY_SAVED,
  type TrayApproval,
  type TrayCompletion,
  type TrayLive,
  type TraySaved,
} from './model';

export type TrayStatus = { alert: boolean; count: number; summary: string };

/** The Electron side the controller drives; tests pass a fake. */
type TrayView = {
  setMenu: (template: MenuItemConstructorOptions[]) => void;
  setStatus: (status: TrayStatus) => void;
};

export type TrayControllerDeps = {
  view: TrayView;
  readLive: () => TrayLive;
  readSaved: (chatIds: string[]) => Promise<TraySaved>;
  /** Answers a command request; does nothing if it was already answered or timed out. */
  respond: (approval: TrayApproval, approved: boolean) => Promise<void>;
  actions: Omit<TrayMenuActions, 'respond'>;
  platform: NodeJS.Platform;
  now: () => number;
  /** Runs Electron UI changes on a fresh turn, never inside a macOS menu callout. */
  defer: (run: () => void) => void;
  schedule: (run: () => void, ms: number) => void;
};

const SAVED_DEBOUNCE_MS = 1000;
const MAX_COMPLETIONS = 20;

/** Runs a menu click so a failure is logged instead of escaping into Electron's menu. */
function safely(run: () => void | Promise<void>): void {
  try {
    void Promise.resolve(run()).catch((error) => log.warn('[tray] menu action failed', error));
  } catch (error) {
    log.warn('[tray] menu action failed', error);
  }
}

/** Keeps the tray's icon, count and menu in step with what is running and what needs the user. */
export function createTrayController(deps: TrayControllerDeps) {
  let saved = EMPTY_SAVED;
  let shownModel = '';
  let menuOpen = false;
  let heldMenu: MenuItemConstructorOptions[] | null = null;
  let loadPending = false;
  // Set when the tray is removed: a timer or read already in flight must not touch it afterwards.
  let stopped = false;
  const completions: TrayCompletion[] = [];

  async function answer(approval: TrayApproval, approved: boolean) {
    try {
      await deps.respond(approval, approved);
    } catch (error) {
      // The request could not be answered from here (the window is not ready): show it in Frink.
      log.warn('[tray] could not answer the request from the menu', error);
      deps.actions.open({ chatId: approval.chatId, subChatId: approval.subChatId });
    }
    render();
  }

  const actions: TrayMenuActions = {
    open: (target) => safely(() => deps.actions.open(target)),
    respond: (approval, approved) => safely(() => answer(approval, approved)),
    newChat: () => safely(deps.actions.newChat),
    openFrink: () => safely(deps.actions.openFrink),
    quit: () => safely(deps.actions.quit),
  };

  function render() {
    if (stopped) return;
    const live = deps.readLive();
    if (chatIdsIn(live, completions).some((chatId) => !saved.names.has(chatId))) loadSoon();
    const model = buildTrayModel(live, saved, completions, deps.now());
    const key = JSON.stringify(model);
    if (key === shownModel) return;
    shownModel = key;
    const template = buildTrayMenu(model, actions, deps.platform);
    const status = {
      alert: model.needs.length > 0,
      count: model.needs.length + model.working.length,
      summary: traySummary(model),
    };
    deps.defer(() => {
      if (stopped) return;
      deps.view.setStatus(status);
      // Replacing an open menu can drop the click the user is making; apply it once it closes.
      if (menuOpen) heldMenu = template;
      else deps.view.setMenu(template);
    });
  }

  async function load() {
    loadPending = false;
    if (stopped) return;
    try {
      saved = await deps.readSaved(chatIdsIn(deps.readLive(), completions));
    } catch (error) {
      log.warn('[tray] could not read the saved state', error);
    }
    render();
  }

  /** Re-reads the database soon, once for a burst of changes. */
  function loadSoon() {
    if (loadPending) return;
    loadPending = true;
    deps.schedule(() => void load(), SAVED_DEBOUNCE_MS);
  }

  return {
    render,
    loadSoon,
    noteCompletion({ chatId, subChatId }: { chatId: string; subChatId: string }) {
      completions.unshift({ chatId, subChatId, at: deps.now() });
      completions.splice(MAX_COMPLETIONS);
      loadSoon();
    },
    menuOpened() {
      // Only macOS reports a tray menu closing reliably; elsewhere a held menu could stick.
      menuOpen = deps.platform === 'darwin';
    },
    menuClosed() {
      menuOpen = false;
      const template = heldMenu;
      heldMenu = null;
      if (template)
        deps.defer(() => {
          if (!stopped) deps.view.setMenu(template);
        });
    },
    stop() {
      stopped = true;
    },
  };
}
