import { afterAll, beforeAll } from 'vitest';
import { hexToHslTriplet } from './palette/color';
import { derivePalette } from './palette/derive';
import { type Palette, ROLE_VARS, ROLES } from './palette/roles';

const declarations = (palette: Palette): string =>
  ROLES.map((role) => `${ROLE_VARS[role][0]}: ${hexToHslTriplet(palette[role])};`).join('');

/**
 * Test stand-in for globals.css: installs a stock palette per appearance (`:root` and `.dark`)
 * for the calling test file, so stock Frink is read the way the app reads it.
 */
export function installStockSheet() {
  const stock = {
    light: derivePalette({ background: '#ffffff', accent: '#7c3aed' }),
    dark: derivePalette({ background: '#050505', accent: '#a78bfa' }),
  };
  const sheet = document.createElement('style');
  beforeAll(() => {
    sheet.textContent = `:root{${declarations(stock.light)}} .dark{${declarations(stock.dark)}}`;
    document.head.append(sheet);
  });
  afterAll(() => sheet.remove());
  return stock;
}
