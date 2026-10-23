import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { buildTrayMenu, type TrayMenuActions, traySummary } from './menu';
import type { TrayModel, TrayRow } from './model';

function actions(): TrayMenuActions {
  return { open: vi.fn(), respond: vi.fn(), newChat: vi.fn(), openFrink: vi.fn(), quit: vi.fn() };
}

const approvalRow: TrayRow = {
  key: 'permission:r',
  title: 'Fix the checkout bug',
  detail: 'Wants to run a command',
  target: { chatId: 'a', subChatId: 'a1' },
  approval: { chatId: 'a', subChatId: 'a1', requestId: 'r', command: 'bun test checkout' },
};

const model: TrayModel = {
  needs: [approvalRow],
  working: [
    {
      key: 'working:b',
      title: 'Add dark mode',
      detail: 'Running a command',
      target: { chatId: 'b' },
    },
  ],
  done: [],
};

// SAFETY: the tray's click handlers take no arguments, so calling them bare is what a click does.
const click = (item?: MenuItemConstructorOptions) => (item?.click as (() => void) | undefined)?.();

describe('traySummary', () => {
  it.each([
    [{ needs: [], working: [], done: [] }, 'All quiet'],
    [{ needs: [approvalRow], working: [], done: [] }, '1 needs you'],
    [model, '1 working · 1 needs you'],
    [{ needs: [approvalRow, approvalRow], working: [], done: [] }, '2 need you'],
  ])('summarises %#', (input, expected) => {
    expect(traySummary(input)).toBe(expected);
  });
});

describe('buildTrayMenu', () => {
  it('draws a second line on macOS and folds it into the label elsewhere', () => {
    const mac = buildTrayMenu(model, actions(), 'darwin');
    const windows = buildTrayMenu(model, actions(), 'win32');

    expect(mac.find((item) => item.label === 'Add dark mode')?.sublabel).toBe('Running a command');
    expect(windows.some((item) => item.label === 'Add dark mode — running a command')).toBe(true);
    expect(windows.some((item) => 'sublabel' in item)).toBe(false);
  });

  it('lists sections in order, skipping empty ones, then the app actions', () => {
    const labels = buildTrayMenu(model, actions(), 'linux').map((item) => item.label ?? item.type);

    expect(labels).toEqual([
      '1 working · 1 needs you',
      'separator',
      'Needs you',
      'Fix the checkout bug — wants to run a command',
      'separator',
      'Working',
      'Add dark mode — running a command',
      'separator',
      'New chat',
      'Open Frink',
      'separator',
      'Quit Frink',
    ]);
  });

  it('shows the full command above Allow and Deny, and answers through respond', () => {
    const spy = actions();
    const row = buildTrayMenu(model, spy, 'darwin').find(
      (item) => item.label === approvalRow.title,
    );
    // SAFETY: an approval row is always built with an array submenu.
    const submenu = row?.submenu as MenuItemConstructorOptions[];

    expect(submenu[0]).toMatchObject({ label: 'bun test checkout', enabled: false });
    click(submenu.find((item) => item.label === 'Allow'));
    click(submenu.find((item) => item.label === 'Deny'));
    click(submenu.find((item) => item.label === 'Open chat'));

    expect(spy.respond).toHaveBeenNthCalledWith(1, approvalRow.approval, true);
    expect(spy.respond).toHaveBeenNthCalledWith(2, approvalRow.approval, false);
    expect(spy.open).toHaveBeenCalledWith(approvalRow.target);
  });

  it('opens a row without an approval directly, and clips long names', () => {
    const spy = actions();
    const long: TrayModel = {
      needs: [],
      working: [{ key: 'w', title: 'x'.repeat(80), detail: 'Working', target: { chatId: 'b' } }],
      done: [],
    };
    const row = buildTrayMenu(long, spy, 'darwin').find((item) => item.sublabel === 'Working');

    expect(row?.label).toHaveLength(64);
    expect(row?.label?.endsWith('…')).toBe(true);
    click(row);
    expect(spy.open).toHaveBeenCalledWith({ chatId: 'b' });
  });
});
