import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import { buildUpdateMenuItem } from './auto-updater';

/**
 * The submenu under the app's name: About, the update item, and the standard macOS roles.
 */
export function buildAppSubmenu(
  getWindow: () => BrowserWindow | null,
  update: { available: boolean; version: string | null },
  buildUpdateItem: typeof buildUpdateMenuItem = buildUpdateMenuItem,
): MenuItemConstructorOptions[] {
  return [
    { role: 'about', label: 'About Frink' },
    buildUpdateItem(getWindow, update),
    { type: 'separator' },
    { role: 'services' },
    { type: 'separator' },
    { role: 'hide' },
    { role: 'hideOthers' },
    { role: 'unhide' },
    { type: 'separator' },
    { role: 'quit' },
  ];
}
