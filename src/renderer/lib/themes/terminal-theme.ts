import type { ITheme } from 'xterm';
import type { ActivePalette } from './palette/apply';
import { mixOklab } from './palette/color';

/** Frink dark terminal. A theme's palette replaces background, foreground, cursor and selection. */
export const TERMINAL_THEME_DARK = {
  background: '#0a0a0a',
  foreground: '#e8e8e8',
  cursor: '#a78bfa',
  cursorAccent: '#0a0a0a',
  selectionBackground: '#a78bfa40',

  // Pastel ANSI set, readable on the near-black panel
  black: '#1f1f1f',
  red: '#fca5a5',
  green: '#86efac',
  yellow: '#fde68a',
  blue: '#93c5fd',
  magenta: '#ddd6fe',
  cyan: '#a5f3fc',
  white: '#e8e8e8',
  brightBlack: '#6b6b6b',
  brightRed: '#fecaca',
  brightGreen: '#bbf7d0',
  brightYellow: '#fef3c7',
  brightBlue: '#bfdbfe',
  brightMagenta: '#e9d5ff',
  brightCyan: '#cffafe',
  brightWhite: '#ffffff',
} satisfies ITheme;

/** Frink light terminal. A theme's palette replaces background, foreground, cursor and selection. */
export const TERMINAL_THEME_LIGHT = {
  background: '#fafafa',
  foreground: '#0a0a0a',
  cursor: '#0a0a0a',
  cursorAccent: '#fafafa',
  selectionBackground: '#7c3aed33',

  // Tailwind 600-weight ANSI set, darkened for the light panel
  black: '#18181b',
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#ca8a04',
  blue: '#2563eb',
  magenta: '#9333ea',
  cyan: '#0891b2',
  white: '#f4f4f5',
  brightBlack: '#52525b',
  brightRed: '#ef4444',
  brightGreen: '#22c55e',
  brightYellow: '#eab308',
  brightBlue: '#3b82f6',
  brightMagenta: '#a855f7',
  brightCyan: '#06b6d4',
  brightWhite: '#fafafa',
} satisfies ITheme;

/**
 * xterm theme: Frink's ANSI set for the palette's appearance (`isDark` only before a palette
 * exists), painted with the palette unless stock Frink owns the look.
 */
export function getTerminalTheme(
  isDark: boolean,
  palette?: ActivePalette | null,
): ITheme & { background: string } {
  const dark = palette ? palette.appearance === 'dark' : isDark;
  const base = dark ? TERMINAL_THEME_DARK : TERMINAL_THEME_LIGHT;
  if (!palette?.inline) return base;
  const { sidebar, text, accent } = palette.colors;
  return {
    ...base,
    background: sidebar,
    foreground: text,
    cursor: accent,
    cursorAccent: sidebar,
    selectionBackground: mixOklab(sidebar, accent, 0.25),
  };
}
