/* eslint-disable max-lines, max-lines-per-function */
import type {
  CustomHotkeysConfig,
  ShortcutAction,
  ShortcutActionId,
  ShortcutCategory,
  ShortcutConflict,
} from './types';

const TRAILING_PLUS_RE = /\w\+\+$/;

/**
 * Master registry of all configurable shortcut actions
 * This is the single source of truth for default shortcuts
 */
export const ALL_SHORTCUT_ACTIONS: ShortcutAction[] = [
  // ============================================
  // GENERAL
  // ============================================
  {
    id: 'show-shortcuts',
    label: 'Show shortcuts',
    category: 'general',
    defaultKeys: ['?'],
  },
  {
    id: 'open-settings',
    label: 'Settings',
    category: 'general',
    defaultKeys: ['cmd', ','],
  },
  {
    id: 'close-settings',
    label: 'Close settings page',
    category: 'general',
    defaultKeys: ['Escape'],
    contextOnly: true,
    nonRebindable: true,
  },
  {
    id: 'close-flows',
    label: 'Close flows page',
    category: 'general',
    defaultKeys: ['Escape'],
    contextOnly: true,
    nonRebindable: true,
  },
  {
    id: 'flow-editor-back-to-list',
    label: 'Back to flows list',
    category: 'general',
    defaultKeys: ['Escape'],
    contextOnly: true,
    nonRebindable: true,
  },
  {
    id: 'toggle-sidebar',
    label: 'Toggle sidebar',
    category: 'general',
    defaultKeys: ['cmd', 'B'],
  },
  {
    id: 'undo-archive',
    label: 'Undo archive',
    category: 'general',
    defaultKeys: ['cmd', 'Z'],
  },
  {
    id: 'collapse-all-sidebar',
    label: 'Collapse all sidebar folders',
    category: 'general',
    defaultKeys: ['cmd', 'shift', 'E'],
  },
  {
    id: 'focus-sidebar',
    label: 'Focus sidebar',
    category: 'general',
    defaultKeys: ['cmd', ';'],
  },
  {
    id: 'toggle-archived',
    label: 'Toggle archived chats',
    category: 'general',
    defaultKeys: ['cmd', 'shift', 'A'],
  },

  // ============================================
  // WORKSPACES
  // ============================================
  {
    id: 'new-workspace',
    label: 'New workspace',
    category: 'workspaces',
    defaultKeys: ['cmd', 'N'],
  },
  {
    id: 'search-workspaces',
    label: 'Search workspaces',
    category: 'workspaces',
    defaultKeys: ['cmd', 'K'],
  },
  {
    id: 'archive-workspace',
    label: 'Archive current workspace',
    category: 'workspaces',
    defaultKeys: ['cmd', 'E'],
  },

  // ============================================
  // AGENTS
  // ============================================
  {
    id: 'new-agent',
    label: 'Create new agent',
    category: 'agents',
    defaultKeys: ['cmd', 'T'],
  },
  {
    id: 'new-agent-split',
    label: 'New agent in split view',
    category: 'agents',
    defaultKeys: ['cmd', 'shift', 'T'],
  },
  {
    id: 'close-split',
    label: 'Close active pane',
    category: 'agents',
    defaultKeys: ['cmd', 'shift', 'W'],
  },
  {
    id: 'search-in-chat',
    label: 'Search text in current chat',
    category: 'agents',
    defaultKeys: ['cmd', 'F'],
  },
  {
    id: 'archive-agent',
    label: 'Archive current agent',
    category: 'agents',
    defaultKeys: ['cmd', 'shift', 'D'],
  },
  {
    id: 'focus-input',
    label: 'Focus input',
    category: 'agents',
    defaultKeys: ['Enter'],
  },
  {
    id: 'toggle-focus',
    label: 'Toggle focus',
    category: 'agents',
    defaultKeys: ['cmd', 'Esc'],
  },
  {
    id: 'stop-generation',
    label: 'Stop generation',
    category: 'agents',
    defaultKeys: ['Esc'],
    altKeys: ['ctrl', 'C'],
  },
  {
    id: 'switch-model',
    label: 'Switch model',
    category: 'agents',
    defaultKeys: ['cmd', '/'],
  },
  {
    id: 'toggle-terminal',
    label: 'Toggle terminal',
    category: 'agents',
    defaultKeys: ['cmd', 'J'],
    nonRebindable: true,
  },
  {
    id: 'toggle-terminal-mode',
    label: 'Toggle terminal position',
    category: 'agents',
    defaultKeys: ['cmd', 'shift', 'J'],
    nonRebindable: true,
  },
  {
    id: 'open-diff',
    label: 'Open diff',
    category: 'agents',
    defaultKeys: ['cmd', 'D'],
  },
  {
    id: 'create-pr',
    label: 'Create PR',
    category: 'agents',
    defaultKeys: ['cmd', 'P'],
  },
  {
    id: 'file-search',
    label: 'Search files',
    category: 'agents',
    defaultKeys: ['cmd', 'shift', 'P'],
  },
  {
    id: 'find-in-files',
    label: 'Find in files (Search tab)',
    category: 'agents',
    defaultKeys: ['cmd', 'shift', 'G'],
  },
  {
    id: 'open-file-in-editor',
    label: 'Open file in editor',
    category: 'agents',
    defaultKeys: ['cmd', 'shift', 'O'],
  },
  {
    id: 'open-branch-picker',
    label: 'Open branch picker',
    category: 'agents',
    defaultKeys: ['cmd', 'shift', 'B'],
  },
  {
    id: 'open-branch-delete-picker',
    label: 'Delete branch picker',
    category: 'agents',
    defaultKeys: ['cmd', 'shift', 'Backspace'],
  },
  {
    id: 'toggle-files',
    label: 'Browse files',
    category: 'agents',
    defaultKeys: ['cmd', 'shift', 'F'],
  },
  {
    id: 'close-all-editor-files',
    label: 'Close all editor files',
    category: 'agents',
    defaultKeys: ['cmd', 'shift', 'X'],
  },
  {
    id: 'toggle-editor-layout',
    label: 'Cycle editor layout',
    category: 'agents',
    defaultKeys: ['cmd', 'shift', 'V'],
  },
  {
    id: 'next-pane-group',
    label: 'Next editor tab',
    category: 'agents',
    defaultKeys: ['cmd', 'shift', ']'],
  },
  {
    id: 'prev-pane-group',
    label: 'Previous editor tab',
    category: 'agents',
    defaultKeys: ['cmd', 'shift', '['],
  },
  {
    id: 'next-pane',
    label: 'Focus next pane',
    category: 'agents',
    defaultKeys: ['cmd', ']'],
  },
  {
    id: 'prev-pane',
    label: 'Focus previous pane',
    category: 'agents',
    defaultKeys: ['cmd', '['],
  },
  {
    id: 'edit-slash-command',
    label: 'Edit slash command',
    category: 'agents',
    defaultKeys: ['cmd', 'E'],
    contextOnly: true,
    nonRebindable: true,
  },
  {
    id: 'approve-plan',
    label: 'Approve plan',
    category: 'agents',
    defaultKeys: ['cmd', 'Enter'],
    contextOnly: true,
    nonRebindable: true,
  },
  {
    id: 'force-submit',
    label: 'Force submit (bypass queue)',
    category: 'agents',
    defaultKeys: ['opt', 'Enter'],
    contextOnly: true,
    nonRebindable: true,
  },
  {
    id: 'scroll-to-bottom',
    label: 'Scroll to bottom',
    category: 'agents',
    defaultKeys: ['cmd', 'ArrowDown'],
    contextOnly: true,
    nonRebindable: true,
  },
  {
    id: 'search-next',
    label: 'Next search result',
    category: 'agents',
    defaultKeys: ['cmd', 'G'],
    contextOnly: true,
    nonRebindable: true,
  },
  {
    id: 'search-prev',
    label: 'Previous search result',
    category: 'agents',
    defaultKeys: ['cmd', 'shift', 'G'],
    contextOnly: true,
    nonRebindable: true,
  },
  {
    id: 'cycle-pane-layout',
    label: 'Cycle pane layout',
    category: 'agents',
    defaultKeys: ['cmd', 'shift', 'L'],
  },
  {
    id: 'reorder-pane-left',
    label: 'Reorder pane left/up',
    category: 'agents',
    defaultKeys: ['cmd', 'shift', 'ArrowLeft'],
    contextOnly: true,
    nonRebindable: true,
  },
  {
    id: 'reorder-pane-right',
    label: 'Reorder pane right/down',
    category: 'agents',
    defaultKeys: ['cmd', 'shift', 'ArrowRight'],
    contextOnly: true,
    nonRebindable: true,
  },
  {
    id: 'grow-pane',
    label: 'Grow active pane',
    category: 'agents',
    defaultKeys: ['cmd', 'alt', 'ArrowRight'],
  },
  {
    id: 'shrink-pane',
    label: 'Shrink active pane',
    category: 'agents',
    defaultKeys: ['cmd', 'alt', 'ArrowLeft'],
  },
  {
    id: 'reset-pane-sizes',
    label: 'Reset pane sizes',
    category: 'agents',
    defaultKeys: ['cmd', 'alt', 'R'],
  },
  {
    id: 'reset-pane-zoom',
    label: 'Reset pane zoom',
    category: 'agents',
    defaultKeys: ['cmd', 'alt', '0'],
  },
  {
    id: 'page-zoom-in',
    label: 'Page zoom in',
    category: 'agents',
    defaultKeys: ['cmd', 'plus'],
  },
  {
    id: 'page-zoom-out',
    label: 'Page zoom out',
    category: 'agents',
    defaultKeys: ['cmd', 'minus'],
  },
  {
    id: 'zoom-in-grow-pane',
    label: 'Zoom in current pane and grow',
    category: 'agents',
    defaultKeys: ['cmd', 'shift', 'plus'],
  },
  {
    id: 'zoom-out-shrink-pane',
    label: 'Zoom out current pane and shrink',
    category: 'agents',
    defaultKeys: ['cmd', 'shift', 'minus'],
  },
  {
    id: 'zoom-pane-in',
    label: 'Zoom in current pane',
    category: 'agents',
    defaultKeys: ['cmd', 'alt', 'plus'],
  },
  {
    id: 'zoom-pane-out',
    label: 'Zoom out current pane',
    category: 'agents',
    defaultKeys: ['cmd', 'alt', 'minus'],
  },

  // ============================================
  // EDITOR — context-only, non-rebindable
  // Handled locally in CodeEditorPanel.tsx, listed here for discoverability.
  // ============================================
  {
    id: 'editor-save',
    label: 'Save file',
    category: 'agents',
    defaultKeys: ['cmd', 'S'],
    contextOnly: true,
    nonRebindable: true,
  },
  {
    id: 'editor-close-tab',
    label: 'Close editor tab',
    category: 'agents',
    defaultKeys: ['cmd', 'W'],
    contextOnly: true,
    nonRebindable: true,
  },
  {
    id: 'editor-toggle-maximize',
    label: 'Toggle editor maximize',
    category: 'agents',
    defaultKeys: ['cmd', 'shift', 'M'],
    contextOnly: true,
    nonRebindable: true,
  },
  {
    id: 'editor-toggle-inline-diff',
    label: 'Toggle inline diff',
    category: 'agents',
    defaultKeys: ['cmd', 'shift', 'I'],
    contextOnly: true,
    nonRebindable: true,
  },
  {
    id: 'editor-toggle-markdown-preview',
    label: 'Toggle Markdown preview',
    category: 'agents',
    defaultKeys: ['cmd', 'alt', 'V'],
    contextOnly: true,
    nonRebindable: true,
  },
  {
    id: 'editor-close-panel',
    label: 'Close editor panel',
    category: 'agents',
    defaultKeys: ['Esc'],
    contextOnly: true,
    nonRebindable: true,
  },

  // ============================================
  // FILES — global shortcuts (work when file sidebar is visible)
  // ============================================
  {
    id: 'file-delete',
    label: 'Delete file/folder',
    category: 'files',
    defaultKeys: ['cmd', 'Backspace'],
  },
  {
    id: 'file-new-file',
    label: 'New file',
    category: 'files',
    defaultKeys: ['cmd', 'shift', 'N'],
  },
  {
    id: 'file-new-folder',
    label: 'New folder',
    category: 'files',
    defaultKeys: ['cmd', 'shift', 'opt', 'N'],
  },

  // ============================================
  // FILES — context-only shortcuts (need file tree focused)
  // ============================================
  {
    id: 'file-rename',
    label: 'Rename',
    category: 'files',
    defaultKeys: ['Enter'],
    altKeys: ['F2'],
    contextOnly: true,
  },
  {
    id: 'file-duplicate',
    label: 'Duplicate',
    category: 'files',
    defaultKeys: ['cmd', 'D'],
    contextOnly: true,
  },
  {
    id: 'file-copy',
    label: 'Copy file',
    category: 'files',
    defaultKeys: ['cmd', 'C'],
    contextOnly: true,
  },
  {
    id: 'file-paste',
    label: 'Paste file',
    category: 'files',
    defaultKeys: ['cmd', 'V'],
    contextOnly: true,
  },

  // ============================================
  // FILES — multi-select shortcuts (need file tree focused)
  // ============================================
  {
    id: 'file-select-all',
    label: 'Select all files',
    category: 'files',
    defaultKeys: ['cmd', 'A'],
    contextOnly: true,
  },
  {
    id: 'file-extend-selection-down',
    label: 'Extend selection down',
    category: 'files',
    defaultKeys: ['shift', 'ArrowDown'],
    contextOnly: true,
  },
  {
    id: 'file-extend-selection-up',
    label: 'Extend selection up',
    category: 'files',
    defaultKeys: ['shift', 'ArrowUp'],
    contextOnly: true,
  },
  {
    id: 'file-toggle-select',
    label: 'Toggle item selection',
    category: 'files',
    defaultKeys: ['cmd', 'Click'],
    contextOnly: true,
    nonRebindable: true,
  },
  {
    id: 'file-range-select',
    label: 'Range select',
    category: 'files',
    defaultKeys: ['shift', 'Click'],
    contextOnly: true,
    nonRebindable: true,
  },
  {
    id: 'file-clear-selection',
    label: 'Clear selection',
    category: 'files',
    defaultKeys: ['Escape'],
    contextOnly: true,
  },

  // ============================================
  // FILES — tree navigation (standard WAI-ARIA tree pattern)
  //
  // These entries are documentation-only for the Settings > Keyboard panel.
  // Actual key handling lives in use-file-tree-navigation.ts which reads
  // e.key directly, independent of the registry. They are marked
  // nonRebindable so users cannot reassign them.
  // ============================================
  {
    id: 'file-nav-up',
    label: 'Navigate up',
    category: 'files',
    defaultKeys: ['ArrowUp'],
    contextOnly: true,
    nonRebindable: true,
  },
  {
    id: 'file-nav-down',
    label: 'Navigate down',
    category: 'files',
    defaultKeys: ['ArrowDown'],
    contextOnly: true,
    nonRebindable: true,
  },
  {
    id: 'file-collapse',
    label: 'Collapse folder',
    category: 'files',
    defaultKeys: ['ArrowLeft'],
    contextOnly: true,
    nonRebindable: true,
  },
  {
    id: 'file-expand',
    label: 'Expand folder',
    category: 'files',
    defaultKeys: ['ArrowRight'],
    contextOnly: true,
    nonRebindable: true,
  },
];

/**
 * Get shortcuts grouped by category
 */
export function getShortcutsByCategory(): Record<ShortcutCategory, ShortcutAction[]> {
  return {
    general: ALL_SHORTCUT_ACTIONS.filter((a) => a.category === 'general'),
    workspaces: ALL_SHORTCUT_ACTIONS.filter((a) => a.category === 'workspaces'),
    agents: ALL_SHORTCUT_ACTIONS.filter((a) => a.category === 'agents'),
    files: ALL_SHORTCUT_ACTIONS.filter((a) => a.category === 'files'),
  };
}

/**
 * Get a shortcut action by ID
 */
export function getShortcutAction(id: ShortcutActionId): ShortcutAction | undefined {
  return ALL_SHORTCUT_ACTIONS.find((a) => a.id === id);
}

/**
 * Convert keys array to hotkey string
 * e.g., ["cmd", "shift", "N"] -> "cmd+shift+n"
 */
export function keysToHotkeyString(keys: string[]): string {
  return keys.map((k) => k.toLowerCase()).join('+');
}

/**
 * Convert hotkey string to keys array
 * e.g., "cmd+shift+n" -> ["cmd", "shift", "N"]
 */
export function hotkeyStringToKeys(hotkey: string): string[] {
  return hotkey.split('+').map((part) => {
    const lower = part.toLowerCase();
    // Capitalize non-modifier keys
    if (!['cmd', 'ctrl', 'opt', 'alt', 'shift', 'meta'].includes(lower)) {
      return part.toUpperCase();
    }
    return lower;
  });
}

/**
 * Get the resolved hotkey for an action considering custom overrides
 */
export function getResolvedHotkey(
  actionId: ShortcutActionId,
  config: CustomHotkeysConfig,
): string | null {
  const customHotkey = config.bindings[actionId];

  // If explicitly set (including to a custom value), use it
  if (customHotkey !== undefined) {
    return customHotkey;
  }

  // Otherwise use default
  const action = getShortcutAction(actionId);
  if (!action) return null;

  return keysToHotkeyString(action.defaultKeys);
}

/**
 * Get the resolved keys array for an action
 */
export function getResolvedKeys(
  actionId: ShortcutActionId,
  config: CustomHotkeysConfig,
): string[] | null {
  const hotkey = getResolvedHotkey(actionId, config);
  if (!hotkey) return null;
  return hotkeyStringToKeys(hotkey);
}

/**
 * Check if an action has a custom (non-default) hotkey
 */
export function isCustomHotkey(actionId: ShortcutActionId, config: CustomHotkeysConfig): boolean {
  return config.bindings[actionId] !== undefined;
}

/** Canonical modifier order; `alt`/`meta` collapse onto `opt`/`cmd` when normalized. */
const MODIFIER_ORDER = ['cmd', 'meta', 'ctrl', 'opt', 'alt', 'shift'];
const canonicalModifier = (m: string) => (m === 'alt' ? 'opt' : m === 'meta' ? 'cmd' : m);

/** Normalize a hotkey string for comparison (modifier order, case, alt/meta aliases). */
export function normalizeHotkey(hotkey: string): string {
  const parts = hotkey.toLowerCase().split('+');
  const modifiers = parts.filter((p) => MODIFIER_ORDER.includes(p));
  const key = parts.find((p) => !MODIFIER_ORDER.includes(p));
  modifiers.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  return [...modifiers.map(canonicalModifier), key].join('+');
}

/**
 * Detect conflicts in hotkey configuration.
 *
 * Shortcuts marked `contextOnly` (e.g. Enter for rename, Cmd+D for duplicate)
 * only fire when their container is focused, so they can't conflict with global
 * shortcuts. They are scoped separately and only conflict with other contextOnly
 * shortcuts that share the same hotkey.
 */
export function detectConflicts(
  config: CustomHotkeysConfig,
): Map<ShortcutActionId, ShortcutConflict> {
  const conflicts = new Map<ShortcutActionId, ShortcutConflict>();

  // Separate scope: "global" vs "contextOnly"
  const scopedHotkeyToActions = new Map<string, ShortcutActionId[]>();

  const addMapping = (scope: string, normalizedHotkey: string, actionId: ShortcutActionId) => {
    const key = `${scope}::${normalizedHotkey}`;
    const existing = scopedHotkeyToActions.get(key) || [];
    existing.push(actionId);
    scopedHotkeyToActions.set(key, existing);
  };

  for (const action of ALL_SHORTCUT_ACTIONS) {
    const hotkey = getResolvedHotkey(action.id, config);
    if (!hotkey) continue;

    const scope = action.contextOnly ? 'contextOnly' : 'global';
    addMapping(scope, normalizeHotkey(hotkey), action.id);

    if (action.altKeys && !isCustomHotkey(action.id, config)) {
      const altNormalized = normalizeHotkey(keysToHotkeyString(action.altKeys));
      addMapping(scope, altNormalized, action.id);
    }
  }

  // Find conflicts (hotkeys with multiple actions within the same scope)
  for (const [key, actionIds] of scopedHotkeyToActions) {
    if (actionIds.length > 1) {
      const hotkey = key.split('::')[1];
      for (const actionId of actionIds) {
        conflicts.set(actionId, {
          actionId,
          conflictingActionIds: actionIds.filter((id) => id !== actionId),
          hotkey,
        });
      }
    }
  }

  return conflicts;
}

/** Display mapping for special keys (Mac — symbols). The Windows/Linux and screen-reader tables
 * spread from it, so keys that read the same everywhere (Esc, Tab, arrows) are defined once. */
const KEY_DISPLAY_MAP: Record<string, string> = {
  cmd: '⌘',
  meta: '⌘',
  ctrl: '⌃',
  opt: '⌥',
  alt: '⌥',
  shift: '⇧',
  enter: '↵',
  backspace: '⌫',
  delete: '⌦',
  escape: 'Esc',
  esc: 'Esc',
  tab: 'Tab',
  space: 'Space',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  click: 'Click',
  plus: '+',
  minus: '−',
};

/**
 * Display mapping for special keys (Windows / Linux — text labels).
 * Overrides only the keys that differ from the Mac glyphs; the spread is intentional.
 */
const KEY_DISPLAY_MAP_NON_MAC: Record<string, string> = {
  ...KEY_DISPLAY_MAP,
  // Only the keys that differ from the Mac glyphs; Esc/Tab/Space/arrows/Click/+ are shared.
  cmd: 'Ctrl',
  meta: 'Ctrl',
  ctrl: 'Ctrl',
  opt: 'Alt',
  alt: 'Alt',
  shift: 'Shift',
  enter: 'Enter',
  backspace: 'Backspace',
  delete: 'Delete',
  minus: '-',
};

/** Screen-reader labels on macOS: VoiceOver reads only the aria-label, so it must name the Mac key
 * and keep ⌘ (Command) distinct from ⌃ (Control). Other keys reuse the Windows/Linux words. */
const KEY_ARIA_MAP_MAC: Record<string, string> = {
  ...KEY_DISPLAY_MAP_NON_MAC,
  cmd: 'Command',
  meta: 'Command',
  ctrl: 'Control',
  opt: 'Option',
  alt: 'Option',
};

/**
 * Reverse display map: symbol -> internal key name (first-match-wins)
 * e.g., "⌘" -> "cmd", "⇧" -> "shift"
 * Built from the Mac glyphs only: shortcut search accepts typed or pasted glyphs ("⌘⇧N"),
 * while Windows/Linux words ("ctrl+shift+n") already parse as internal names.
 */
const DISPLAY_TO_KEY_MAP: Record<string, string> = {};
for (const [key, display] of Object.entries(KEY_DISPLAY_MAP)) {
  if (!(display in DISPLAY_TO_KEY_MAP)) {
    DISPLAY_TO_KEY_MAP[display] = key;
  }
}

/**
 * Check if a hotkey string matches a search query.
 * Supports multiple input formats:
 * - Symbols: "⌘;" or "⌘⇧N"
 * - Text names: "cmd+;", "cmd+shift+n"
 * - Partial matches: "cmd" matches all Cmd-based shortcuts
 */
export function hotkeyMatchesQuery(hotkey: string, query: string): boolean {
  // Normalize query: replace display symbols with internal key names
  let normalizedQuery = query;
  for (const [display, key] of Object.entries(DISPLAY_TO_KEY_MAP)) {
    normalizedQuery = normalizedQuery.replaceAll(display, `${key}+`);
  }
  // Lowercase, normalize separators, split into parts.
  // The `+` character is both the separator and a valid key. Detect literal `+`
  // by checking for consecutive `++` (modifier+plus) or a standalone `+`.
  const cleaned = normalizedQuery.toLowerCase().replace(/\s+/g, '+');
  const queryParts = cleaned
    .replace(/^\+|\+$/g, '') // trim leading/trailing +
    .split('+')
    .filter(Boolean);

  // If the cleaned query ended with `++` or was just `+`, the literal `+` key
  // was swallowed by the split — re-add it as a search term.
  if (cleaned === '+' || TRAILING_PLUS_RE.test(cleaned)) {
    queryParts.push('+');
  }

  // Empty queryParts matches everything via .every() on [] — bail out early
  if (queryParts.length === 0) return false;

  // Build comparable parts from the hotkey
  const hotkeyParts = hotkey.toLowerCase().split('+').filter(Boolean);

  // Check if every query part matches some part of the hotkey (prefix match)
  return queryParts.every((qp) => hotkeyParts.some((hp) => hp.startsWith(qp)));
}

/**
 * Convert a key to its display format
 */
export function keyToDisplay(key: string): string {
  const lower = key.toLowerCase();
  return KEY_DISPLAY_MAP[lower] || key.toUpperCase();
}

/**
 * Convert a hotkey string to display format
 * e.g., "cmd+shift+n" -> "⌘⇧N"
 * Mac glyphs regardless of OS — use keysToDisplayPlatform for UI rendered on every platform.
 */
export function hotkeyToDisplay(hotkey: string): string {
  return keysToDisplay(hotkey.split('+'));
}

/**
 * Convert keys array to display format
 * e.g., ["cmd", "shift", "N"] -> "⌘⇧N"
 * Mac glyphs regardless of OS — use keysToDisplayPlatform for UI rendered on every platform.
 */
export function keysToDisplay(keys: string[]): string {
  return keys.map((k) => keyToDisplay(k)).join('');
}

/**
 * Platform-aware key display.
 * Mac: cmd → ⌘   Non-Mac: cmd → Ctrl
 */
function keyToDisplayPlatform(key: string, isMac: boolean): string {
  if (isMac) return keyToDisplay(key);
  const lower = key.toLowerCase();
  return KEY_DISPLAY_MAP_NON_MAC[lower] || key.toUpperCase();
}

/**
 * Platform-aware keys-to-display — the intended way to show a shortcut to the user.
 * Mac: ["cmd","shift","F"] → "⌘⇧F"  (no separator)
 * Non-Mac: ["cmd","shift","F"] → "Ctrl+Shift+F"  (+ separator)
 * `Kbd` with a `shortcutId` is the canonical renderer and pairs this with keysToAriaLabel.
 */
export function keysToDisplayPlatform(keys: string[], isMac: boolean): string {
  const parts = keys.map((k) => keyToDisplayPlatform(k, isMac));
  return isMac ? parts.join('') : parts.join('+');
}

/** Screen-reader text for a shortcut, always words: Mac ["cmd","shift","F"] → "Command+Shift+F";
 * elsewhere identical to keysToDisplayPlatform ("Ctrl+Shift+F"). */
export function keysToAriaLabel(keys: string[], isMac: boolean): string {
  if (!isMac) return keysToDisplayPlatform(keys, false);
  return keys.map((k) => KEY_ARIA_MAP_MAC[k.toLowerCase()] || k.toUpperCase()).join('+');
}

/**
 * Category labels for UI
 */
export const CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  general: 'General',
  workspaces: 'Workspaces',
  agents: 'Agents',
  files: 'File Tree',
};
