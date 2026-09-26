import type { ITerminalOptions } from 'xterm';
import { TERMINAL_THEME_DARK } from '@/lib/themes/terminal-theme';

// Nerd Fonts first for shell theme compatibility (Oh My Posh, Powerlevel10k, etc.)
// Geist Mono added for consistency with app font
const TERMINAL_FONT_FAMILY = [
  'Geist Mono',
  'MesloLGM Nerd Font',
  'MesloLGM NF',
  'MesloLGS NF',
  'MesloLGS Nerd Font',
  'Hack Nerd Font',
  'FiraCode Nerd Font',
  'JetBrainsMono Nerd Font',
  'CaskaydiaCove Nerd Font',
  'Menlo',
  'Monaco',
  '"Courier New"',
  'monospace',
].join(', ');

export const TERMINAL_OPTIONS: ITerminalOptions = {
  cursorBlink: true,
  // Font size matches app's compact UI (text-xs = 12px, text-sm = 14px)
  fontSize: 13,
  lineHeight: 1.4,
  fontFamily: TERMINAL_FONT_FAMILY,
  theme: TERMINAL_THEME_DARK, // Default, will be overridden dynamically
  allowProposedApi: true,
  scrollback: 10000,
  macOptionIsMeta: true,
  cursorStyle: 'block',
  cursorInactiveStyle: 'outline',
  fastScrollModifier: 'alt',
  fastScrollSensitivity: 5,
  // Better letter spacing for code readability
  letterSpacing: 0,
};

export const RESIZE_DEBOUNCE_MS = 150;
