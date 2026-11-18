import { isMacOS } from '../utils/platform';

/** Registry bindings use `cmd`; on Windows/Linux the equivalent modifier is Ctrl. */
export function toPlatformHotkey(hotkey: string, isMac: boolean): string {
  if (isMac) return hotkey;
  const parts = hotkey
    .toLowerCase()
    .split('+')
    .map((part) => (part === 'cmd' || part === 'meta' ? 'ctrl' : part));
  // A Win+Ctrl recording ("cmd+ctrl+k") is Ctrl+K here; one `ctrl` keeps conflict checks honest.
  return parts.filter((part, i) => part !== 'ctrl' || parts.indexOf('ctrl') === i).join('+');
}

/** Off Mac the focused field owns some Ctrl chords: plain ones are shell keys in the terminal, and
 * Ctrl+Shift+V is plain-text paste there and in any text field. */
export function isFieldReservedChord(
  platformHotkey: string,
  target: EventTarget | null,
  isMac: boolean,
): boolean {
  if (isMac || !(target instanceof HTMLElement)) return false;
  const parts = platformHotkey.toLowerCase().split('+');
  if (!parts.includes('ctrl')) return false;
  const isPlainPaste = parts.includes('shift') && parts[parts.length - 1] === 'v';
  if (target.closest('.xterm')) return !parts.includes('shift') || isPlainPaste;
  return isPlainPaste && (target.matches('input, textarea') || target.isContentEditable);
}

/**
 * For handlers hardcoded to a registry `cmd` default: Cmd on Mac, Ctrl elsewhere (never both).
 * Off Mac it yields field-reserved chords (see isFieldReservedChord), like the hotkeys manager.
 */
export function isPrimaryChord(e: KeyboardEvent, isMac = isMacOS()): boolean {
  if (isMac) return e.metaKey && !e.ctrlKey;
  if (!e.ctrlKey || e.metaKey) return false;
  const chord = `ctrl+${e.shiftKey ? 'shift+' : ''}${e.key.toLowerCase()}`;
  return !isFieldReservedChord(chord, e.target, false);
}
