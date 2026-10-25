import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { createTrayController, type TrayControllerDeps, type TrayStatus } from './controller';
import { EMPTY_SAVED, type TrayLive, type TraySaved } from './model';

type Harness = {
  deps: TrayControllerDeps;
  menus: MenuItemConstructorOptions[][];
  statuses: TrayStatus[];
  scheduled: Array<() => void>;
  setLive: (next: Partial<TrayLive>) => void;
  setSaved: (next: Partial<TraySaved>) => void;
};

function harness(): Harness {
  let live: TrayLive = {
    permissions: [],
    questions: [],
    working: [],
    canApprove: true,
  };
  let saved: TraySaved = { ...EMPTY_SAVED, names: new Map([['a', 'Fix the checkout bug']]) };
  const menus: MenuItemConstructorOptions[][] = [];
  const statuses: TrayStatus[] = [];
  const scheduled: Array<() => void> = [];
  const deps: TrayControllerDeps = {
    view: { setMenu: (menu) => menus.push(menu), setStatus: (status) => statuses.push(status) },
    readLive: () => live,
    readSaved: vi.fn(async () => saved),
    respond: vi.fn(async () => undefined),
    actions: { open: vi.fn(), newChat: vi.fn(), openFrink: vi.fn(), quit: vi.fn() },
    platform: 'darwin',
    now: () => 0,
    defer: (run) => run(),
    schedule: (run) => void scheduled.push(run),
  };
  return {
    deps,
    menus,
    statuses,
    scheduled,
    setLive: (next) => (live = { ...live, ...next }),
    setSaved: (next) => (saved = { ...saved, ...next }),
  };
}

const commandFor = (chatId: string): TrayLive['permissions'] => [
  { chatId, subChatId: `${chatId}1`, requestId: 'r', command: 'bun test' },
];

// SAFETY: approval rows always carry an array submenu; the tray's click handlers take no arguments.
const submenuOf = (menu: MenuItemConstructorOptions[], label: string) =>
  menu.find((item) => item.label === label)?.submenu as MenuItemConstructorOptions[];
// SAFETY: the tray's click handlers take no arguments, so calling them bare is what a click does.
const click = (item?: MenuItemConstructorOptions) => (item?.click as (() => void) | undefined)?.();

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Starts a controller with its first database read done, as the tray does at launch. */
async function started(h: Harness) {
  const controller = createTrayController(h.deps);
  controller.loadSoon();
  h.scheduled.shift()?.();
  await flush();
  h.menus.length = 0;
  h.statuses.length = 0;
  return controller;
}

describe('createTrayController', () => {
  it('shows the count and alert, and rebuilds the menu only when what it shows changes', async () => {
    const h = harness();
    const controller = await started(h);
    h.setLive({ permissions: commandFor('a') });

    controller.render();
    controller.render();

    expect(h.menus).toHaveLength(1);
    expect(h.statuses).toEqual([{ alert: true, count: 1, summary: '1 needs you' }]);
  });

  it('holds a new menu while the open one is in use and applies it once it closes', async () => {
    const h = harness();
    const controller = await started(h);
    controller.menuOpened();
    h.setLive({ permissions: commandFor('a') });

    controller.render();
    expect(h.menus).toHaveLength(0);
    expect(h.statuses.at(-1)?.alert).toBe(true);

    controller.menuClosed();
    expect(h.menus).toHaveLength(1);
    controller.menuClosed();
    expect(h.menus).toHaveLength(1);
  });

  it('looks up chats it has not seen once, after a short pause', async () => {
    const h = harness();
    const controller = createTrayController(h.deps);
    h.setLive({ working: [{ chatId: 'new', subChatId: 'n1', held: false, activity: 'Working' }] });
    h.setSaved({ names: new Map([['new', 'Write the README']]) });

    controller.render();
    controller.render();
    expect(h.scheduled).toHaveLength(1);

    h.scheduled[0]();
    await flush();
    expect(h.deps.readSaved).toHaveBeenCalledWith(['new']);
    expect(h.statuses.at(-1)).toEqual({ alert: false, count: 1, summary: '1 working' });
  });

  it('answers a command from the menu and refreshes', async () => {
    const h = harness();
    const controller = await started(h);
    h.setLive({ permissions: commandFor('a') });
    controller.render();

    click(submenuOf(h.menus[0], 'Fix the checkout bug').find((item) => item.label === 'Allow'));
    h.setLive({ permissions: [] });
    await flush();

    expect(h.deps.respond).toHaveBeenCalledWith(
      { chatId: 'a', subChatId: 'a1', requestId: 'r', command: 'bun test' },
      true,
    );
    expect(h.statuses.at(-1)?.summary).toBe('All quiet');
  });

  it('opens the chat when the answer cannot be given from the menu', async () => {
    const h = harness();
    vi.mocked(h.deps.respond).mockRejectedValueOnce(
      new Error('Open Frink on your computer to continue.'),
    );
    const controller = await started(h);
    h.setLive({ permissions: commandFor('a') });
    controller.render();

    click(submenuOf(h.menus[0], 'Fix the checkout bug').find((item) => item.label === 'Deny'));
    await flush();

    expect(h.deps.actions.open).toHaveBeenCalledWith({ chatId: 'a', subChatId: 'a1' });
  });

  it('keeps a failing menu action from escaping the click', () => {
    const h = harness();
    vi.mocked(h.deps.actions.newChat).mockImplementation(() => {
      throw new Error('no window');
    });
    const controller = createTrayController(h.deps);
    controller.render();

    expect(() => click(h.menus[0].find((item) => item.label === 'New chat'))).not.toThrow();
    expect(h.deps.actions.newChat).toHaveBeenCalled();
  });

  it('records a finished chat and re-reads the database for it', async () => {
    const h = harness();
    const controller = await started(h);

    controller.noteCompletion({ chatId: 'a', subChatId: 'a1' });
    controller.render();

    expect(h.scheduled).toHaveLength(1);
    expect(h.menus[0].some((item) => item.sublabel === 'Finished just now')).toBe(true);
  });

  it('reports a failed database read and keeps the last state', async () => {
    const h = harness();
    vi.mocked(h.deps.readSaved).mockRejectedValueOnce(new Error('busy'));
    const controller = createTrayController(h.deps);

    controller.loadSoon();
    h.scheduled[0]();
    await flush();

    expect(h.statuses.at(-1)?.summary).toBe('All quiet');
  });

  it('leaves the tray alone once removed, even for timers and reads already in flight', async () => {
    const h = harness();
    const deferred: Array<() => void> = [];
    h.deps.defer = (run) => void deferred.push(run);
    const controller = await started(h);
    h.setLive({ permissions: commandFor('a') });
    controller.render();
    controller.loadSoon();
    controller.menuOpened();
    controller.menuClosed();

    controller.stop();
    for (const run of deferred.splice(0)) run();
    h.scheduled.shift()?.();
    await flush();
    controller.render();

    expect(h.menus).toEqual([]);
    expect(h.statuses).toEqual([]);
    expect(h.deps.readSaved).toHaveBeenCalledTimes(1);
  });

  it('only holds an open menu on macOS, where the menu reports closing', async () => {
    const h = harness();
    h.deps.platform = 'linux';
    const controller = await started(h);
    controller.menuOpened();
    h.setLive({ permissions: commandFor('a') });

    controller.render();

    expect(h.menus).toHaveLength(1);
  });
});
