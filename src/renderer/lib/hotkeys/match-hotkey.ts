/**
 * Shared hotkey-string matcher, used by the global agents hotkey manager and by
 * panel-local fallbacks (e.g. the code editor) that must respect custom bindings.
 */

/**
 * Parse a hotkey string and match against a keyboard event
 * Supports: "?", "shift+?", "cmd+k", "cmd+shift+i"
 */
export type HotkeyEventLike = Pick<
  KeyboardEvent,
  'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'
>;

export function matchesHotkey(e: HotkeyEventLike, hotkey: string): boolean {
  const parts = hotkey.toLowerCase().split('+');
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);

  const needsMeta = modifiers.includes('cmd') || modifiers.includes('meta');
  const needsAlt = modifiers.includes('opt') || modifiers.includes('alt');
  const needsCtrl = modifiers.includes('ctrl');
  let needsShift = modifiers.includes('shift');

  // "?" requires shift implicitly
  if (key === '?' && !modifiers.includes('shift')) {
    needsShift = true;
  }

  if (needsMeta !== e.metaKey) return false;
  if (needsAlt !== e.altKey) return false;
  if (needsCtrl !== e.ctrlKey) return false;

  const eventKey = e.key.toLowerCase();
  const eventCode = e.code.toLowerCase();

  // Plus: match by physical key so UK/macOS Option-modified e.key doesn't break us.
  // UK macOS: Option+Equal produces e.key "≠" (U+2260), e.code "Equal", shiftKey false.
  // We must still enforce the needsShift check so that cmd+shift+plus does not
  // accidentally match cmd+equal (Electron menu's Zoom In uses the unshifted accelerator).
  if (key === 'plus') {
    const isPhysicalPlus = eventCode === 'equal' || eventCode === 'numpadadd' || eventKey === '+';
    if (!isPhysicalPlus) return false;
    // Numpad Add has no shift concept — just check modifiers normally.
    if (eventCode === 'numpadadd') return needsShift === e.shiftKey;
    // When the binding requires Alt (e.g. cmd+alt+plus) and Alt is held, the OS may
    // produce a special character (UK "≠") and may clear shiftKey even when Shift is
    // physically pressed. Skip the strict shift check in that case to keep UK layouts
    // working for bindings like cmd+alt+plus / cmd+alt+equal.
    if (needsAlt && e.altKey) return true;
    // Standard path: Shift must match what the binding requires.
    return needsShift === e.shiftKey;
  }

  if (needsShift !== e.shiftKey) return false;

  if (eventKey === key) return true;
  // macOS: Option+digit produces special chars (e.g. Option+0 → °), so match by physical key (code)
  if (key.length === 1 && key >= '0' && key <= '9' && eventCode === `digit${key}`) return true;
  if (key === '?' && eventKey === '?') return true;
  if (key === '/' && (eventKey === '/' || eventCode === 'slash')) return true;
  if (key === '\\' && (eventKey === '\\' || eventCode === 'backslash')) return true;
  if (key === ',' && (eventKey === ',' || eventCode === 'comma')) return true;
  if (key === ';' && (eventKey === ';' || eventCode === 'semicolon')) return true;
  // Bracket keys: Shift+[ produces '{' and Shift+] produces '}' on macOS
  if (key === ']' && (eventKey === ']' || eventKey === '}' || eventCode === 'bracketright'))
    return true;
  if (key === '[' && (eventKey === '[' || eventKey === '{' || eventCode === 'bracketleft'))
    return true;
  // Minus: - key (and numpad minus). Must enforce needsShift so that cmd+shift+minus
  // does not accidentally match cmd+minus (Electron menu's Zoom Out).
  if (key === 'minus') {
    const isPhysicalMinus =
      eventKey === '-' || eventCode === 'minus' || eventCode === 'numpadsubtract';
    if (!isPhysicalMinus) return false;
    if (eventCode === 'numpadsubtract') return needsShift === e.shiftKey;
    if (needsAlt && e.altKey) return true;
    return needsShift === e.shiftKey;
  }
  if (key.length === 1 && eventCode === `key${key}`) return true;

  return false;
}
