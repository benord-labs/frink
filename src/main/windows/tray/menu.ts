import type { MenuItemConstructorOptions } from 'electron';
import type { TrayApproval, TrayModel, TrayRow, TrayTarget } from './model';

export type TrayMenuActions = {
  open: (target: TrayTarget) => void;
  respond: (approval: TrayApproval, approved: boolean) => void;
  newChat: () => void;
  openFrink: () => void;
  quit: () => void;
};

const MAX_LABEL = 64;

function clip(text: string): string {
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1).trimEnd()}…` : text;
}

/** The one-line summary for the menu's first line and the icon's tooltip. */
export function traySummary(model: TrayModel): string {
  const parts = [];
  if (model.working.length) parts.push(`${model.working.length} working`);
  if (model.needs.length)
    parts.push(`${model.needs.length} need${model.needs.length === 1 ? 's' : ''} you`);
  return parts.length ? parts.join(' · ') : 'All quiet';
}

function rowItem(
  row: TrayRow,
  actions: TrayMenuActions,
  isMac: boolean,
): MenuItemConstructorOptions {
  // Only macOS draws a second line, so other systems fold the detail into the label.
  const text = isMac
    ? { label: clip(row.title), sublabel: clip(row.detail) }
    : { label: clip(`${row.title} — ${row.detail.charAt(0).toLowerCase()}${row.detail.slice(1)}`) };
  const { approval } = row;
  if (!approval) return { ...text, click: () => actions.open(row.target) };
  return {
    ...text,
    submenu: [
      { label: approval.command, enabled: false },
      { type: 'separator' },
      { label: 'Allow', click: () => actions.respond(approval, true) },
      { label: 'Deny', click: () => actions.respond(approval, false) },
      { type: 'separator' },
      { label: 'Open chat', click: () => actions.open(row.target) },
    ],
  };
}

function section(title: string, rows: TrayRow[], actions: TrayMenuActions, isMac: boolean) {
  if (!rows.length) return [];
  const items: MenuItemConstructorOptions[] = [
    { type: 'separator' },
    { label: title, enabled: false },
  ];
  return [...items, ...rows.map((row) => rowItem(row, actions, isMac))];
}

export function buildTrayMenu(
  model: TrayModel,
  actions: TrayMenuActions,
  platform: NodeJS.Platform,
): MenuItemConstructorOptions[] {
  const isMac = platform === 'darwin';
  return [
    { label: traySummary(model), enabled: false },
    ...section('Needs you', model.needs, actions, isMac),
    ...section('Working', model.working, actions, isMac),
    ...section('Done in the last hour', model.done, actions, isMac),
    { type: 'separator' },
    { label: 'New chat', click: actions.newChat },
    { label: 'Open Frink', click: actions.openFrink },
    { type: 'separator' },
    { label: 'Quit Frink', click: actions.quit },
  ];
}
