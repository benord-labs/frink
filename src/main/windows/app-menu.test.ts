import { describe, expect, it, vi } from 'vitest';
import { buildAppSubmenu } from './app-menu';

describe('buildAppSubmenu', () => {
  const getWindow = () => null;
  const update = { available: true, version: '9.9.9' };
  const updateItem = { label: 'Update to v9.9.9...' };
  const buildUpdateItem = vi.fn(() => updateItem);
  const submenu = buildAppSubmenu(getWindow, update, buildUpdateItem);

  it('has no install-frink-command item (no CLI script ships in the bundle)', () => {
    const labels = submenu.map((item) => item.label ?? '');
    expect(labels.some((label) => /'frink' Command/.test(label))).toBe(false);
  });

  it('keeps About, the update item and Quit', () => {
    expect(submenu[0]).toMatchObject({ role: 'about', label: 'About Frink' });
    expect(submenu[1]).toBe(updateItem);
    expect(submenu.at(-1)).toMatchObject({ role: 'quit' });
  });

  it('builds the update item from the live window getter and update state', () => {
    buildAppSubmenu(getWindow, update, buildUpdateItem);
    expect(buildUpdateItem).toHaveBeenCalledWith(getWindow, update);
  });

  it('has no adjacent separators', () => {
    const doubled = submenu.some(
      (item, i) => item.type === 'separator' && submenu[i + 1]?.type === 'separator',
    );
    expect(doubled).toBe(false);
  });
});
