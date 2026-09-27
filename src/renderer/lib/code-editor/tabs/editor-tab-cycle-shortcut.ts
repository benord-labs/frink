import {
  type CustomHotkeysConfig,
  getResolvedHotkey,
  type HotkeyEventLike,
  matchesHotkey,
  type ShortcutActionId,
} from '@/lib/hotkeys';

const CYCLE_BINDINGS: ReadonlyArray<readonly [ShortcutActionId, 1 | -1]> = [
  ['next-pane-group', 1],
  ['prev-pane-group', -1],
];

/** Registry bindings use `cmd`; on Windows/Linux the equivalent modifier is Ctrl. */
function toPlatformHotkey(hotkey: string, isMac: boolean): string {
  if (isMac) return hotkey;
  return hotkey
    .toLowerCase()
    .split('+')
    .map((part) => (part === 'cmd' || part === 'meta' ? 'ctrl' : part))
    .join('+');
}

/**
 * Resolve a keydown inside the code editor panel to a Next (1) / Previous (-1)
 * editor tab cycle, honouring custom keybinds. Returns null when it doesn't match
 * or the action is unbound. Modifier-less bindings are ignored because focus is in
 * Monaco's textarea, mirroring the global manager's in-input rule.
 */
export function getEditorTabCycleDirection(
  e: HotkeyEventLike,
  config: CustomHotkeysConfig,
  isMac: boolean,
): 1 | -1 | null {
  for (const [actionId, direction] of CYCLE_BINDINGS) {
    const hotkey = getResolvedHotkey(actionId, config);
    if (!hotkey || !hotkey.includes('+')) continue;
    if (matchesHotkey(e, toPlatformHotkey(hotkey, isMac))) return direction;
  }
  return null;
}
