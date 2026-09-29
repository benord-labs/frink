// Types

// Matching
export { type HotkeyEventLike, matchesHotkey } from './match-hotkey';

// Registry
export {
  ALL_SHORTCUT_ACTIONS,
  CATEGORY_LABELS,
  detectConflicts,
  getResolvedHotkey,
  getResolvedKeys,
  getShortcutAction,
  getShortcutsByCategory,
  hotkeyMatchesQuery,
  hotkeyStringToKeys,
  hotkeyToDisplay,
  isCustomHotkey,
  keysToAriaLabel,
  keysToDisplayPlatform,
  keysToHotkeyString,
  keyToDisplay,
} from './shortcut-registry';
export type {
  CustomHotkeysConfig,
  ShortcutAction,
  ShortcutActionId,
  ShortcutCategory,
} from './types';
