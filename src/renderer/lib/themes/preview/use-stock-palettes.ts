import { useLayoutEffect, useState } from 'react';
import type { Appearance, Palette } from '../palette/roles';
import { getStockPalette } from '../palette/stock-palette';

/**
 * Stock Frink as globals.css paints it, for previews. The read touches the DOM, so it runs in a
 * layout effect (before paint) and never during render; the result is null only until then.
 */
export function useStockPalettes(): Record<Appearance, Palette> | null {
  const [stock, setStock] = useState<Record<Appearance, Palette> | null>(null);
  useLayoutEffect(() => {
    setStock({ light: getStockPalette('light'), dark: getStockPalette('dark') });
  }, []);
  return stock;
}
