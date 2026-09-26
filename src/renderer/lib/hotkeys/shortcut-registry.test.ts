// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { CustomHotkeysConfig } from './types';

vi.mock('../atoms', () => ({
  customHotkeysAtom: { init: { version: 1, bindings: {} } },
}));

const {
  ALL_SHORTCUT_ACTIONS,
  detectConflicts,
  getResolvedHotkey,
  getShortcutAction,
  getShortcutsByCategory,
  hotkeyMatchesQuery,
  hotkeyStringToKeys,
  hotkeyToDisplay,
  keysToDisplayPlatform,
  keysToHotkeyString,
  normalizeHotkey,
} = await import('./shortcut-registry');

const emptyConfig: CustomHotkeysConfig = { version: 1, bindings: {} };

describe('shortcut-registry', () => {
  describe('new shortcut entries', () => {
    it('registers toggle-archived with correct defaults', () => {
      const action = getShortcutAction('toggle-archived');
      expect(action).toBeDefined();
      if (!action) throw new Error('Expected toggle-archived action to exist');
      expect(action.label).toBe('Toggle archived chats');
      expect(action.category).toBe('general');
      expect(action.defaultKeys).toEqual(['cmd', 'shift', 'A']);
    });

    it('registers file-search with correct defaults', () => {
      const action = getShortcutAction('file-search');
      expect(action).toBeDefined();
      if (!action) throw new Error('Expected file-search action to exist');
      expect(action.label).toBe('Search files');
      expect(action.category).toBe('agents');
      expect(action.defaultKeys).toEqual(['cmd', 'shift', 'P']);
    });

    it('registers find-in-files with correct defaults', () => {
      const action = getShortcutAction('find-in-files');
      expect(action).toBeDefined();
      if (!action) throw new Error('Expected find-in-files action to exist');
      expect(action.label).toBe('Find in files (Search tab)');
      expect(action.category).toBe('agents');
      expect(action.defaultKeys).toEqual(['cmd', 'shift', 'G']);
    });

    it('registers page zoom shortcuts distinct from shift-pane zoom', () => {
      const pageIn = getShortcutAction('page-zoom-in');
      const pageOut = getShortcutAction('page-zoom-out');
      const grow = getShortcutAction('zoom-in-grow-pane');
      expect(pageIn?.defaultKeys).toEqual(['cmd', 'plus']);
      expect(pageOut?.defaultKeys).toEqual(['cmd', 'minus']);
      expect(grow?.defaultKeys).toEqual(['cmd', 'shift', 'plus']);
    });

    it('registers open-file-in-editor with correct defaults', () => {
      const action = getShortcutAction('open-file-in-editor');
      expect(action).toBeDefined();
      if (!action) throw new Error('Expected open-file-in-editor action to exist');
      expect(action.label).toBe('Open file in editor');
      expect(action.category).toBe('agents');
      expect(action.defaultKeys).toEqual(['cmd', 'shift', 'O']);
    });

    it('registers close-flows and flow-editor-back-to-list with Escape', () => {
      const closeFlows = getShortcutAction('close-flows');
      const backToList = getShortcutAction('flow-editor-back-to-list');
      expect(closeFlows?.defaultKeys).toEqual(['Escape']);
      expect(closeFlows?.contextOnly).toBe(true);
      expect(backToList?.defaultKeys).toEqual(['Escape']);
      expect(backToList?.contextOnly).toBe(true);
    });

    it('registers branch picker shortcuts with conflict-free defaults', () => {
      const openBranch = getShortcutAction('open-branch-picker');
      const deleteBranch = getShortcutAction('open-branch-delete-picker');
      expect(openBranch?.defaultKeys).toEqual(['cmd', 'shift', 'B']);
      expect(deleteBranch?.defaultKeys).toEqual(['cmd', 'shift', 'Backspace']);
    });

    it('registers editor-toggle-markdown-preview as context-only', () => {
      const action = getShortcutAction('editor-toggle-markdown-preview');
      expect(action).toBeDefined();
      if (!action) throw new Error('Expected editor-toggle-markdown-preview');
      expect(action.defaultKeys).toEqual(['cmd', 'alt', 'V']);
      expect(action.contextOnly).toBe(true);
      expect(action.nonRebindable).toBe(true);
    });

    it('includes new actions in agents category', () => {
      const categories = getShortcutsByCategory();
      const agentIds = categories.agents.map((a) => a.id);
      expect(agentIds).toContain('file-search');
      expect(agentIds).toContain('find-in-files');
      expect(agentIds).toContain('open-file-in-editor');
      expect(agentIds).toContain('open-branch-picker');
      expect(agentIds).toContain('open-branch-delete-picker');
    });
  });

  describe('ALL_SHORTCUT_ACTIONS integrity', () => {
    it('has no duplicate IDs', () => {
      const ids = ALL_SHORTCUT_ACTIONS.map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('every action has a non-empty label and at least one default key', () => {
      for (const action of ALL_SHORTCUT_ACTIONS) {
        expect(action.label.length).toBeGreaterThan(0);
        expect(action.defaultKeys.length).toBeGreaterThan(0);
      }
    });
  });

  describe('keysToHotkeyString', () => {
    it('joins and lowercases keys', () => {
      expect(keysToHotkeyString(['cmd', 'shift', 'P'])).toBe('cmd+shift+p');
    });

    it('handles single key', () => {
      expect(keysToHotkeyString(['?'])).toBe('?');
    });
  });

  describe('hotkeyStringToKeys', () => {
    it('splits and capitalizes non-modifier keys', () => {
      expect(hotkeyStringToKeys('cmd+shift+p')).toEqual(['cmd', 'shift', 'P']);
    });

    it('preserves modifier casing', () => {
      expect(hotkeyStringToKeys('ctrl+a')).toEqual(['ctrl', 'A']);
    });
  });

  describe('getResolvedHotkey', () => {
    it('returns default when no custom binding', () => {
      expect(getResolvedHotkey('file-search', emptyConfig)).toBe('cmd+shift+p');
    });

    it('returns custom binding when set', () => {
      const config: CustomHotkeysConfig = {
        version: 1,
        bindings: { 'file-search': 'cmd+alt+p' },
      };
      expect(getResolvedHotkey('file-search', config)).toBe('cmd+alt+p');
    });

    it('returns null for unknown action', () => {
      expect(getResolvedHotkey('nonexistent-action' as never, emptyConfig)).toBeNull();
    });
  });

  describe('normalizeHotkey', () => {
    it('normalizes alt to opt', () => {
      expect(normalizeHotkey('alt+shift+n')).toBe('opt+shift+n');
    });

    it('normalizes meta to cmd', () => {
      expect(normalizeHotkey('meta+k')).toBe('cmd+k');
    });

    it('sorts modifiers in canonical order', () => {
      expect(normalizeHotkey('shift+cmd+n')).toBe('cmd+shift+n');
    });
  });

  describe('detectConflicts', () => {
    it('returns no global conflicts for default config', () => {
      const conflicts = detectConflicts(emptyConfig);
      const globalConflicts = [...conflicts.values()].filter((c) => {
        const action = getShortcutAction(c.actionId);
        return !action?.contextOnly;
      });
      expect(globalConflicts.length).toBe(0);
    });

    it('detects conflict when two global actions share the same hotkey', () => {
      const config: CustomHotkeysConfig = {
        version: 1,
        bindings: { 'file-search': 'cmd+n' },
      };
      const conflicts = detectConflicts(config);
      expect(conflicts.has('file-search')).toBe(true);
      expect(conflicts.has('new-workspace')).toBe(true);
    });
  });

  describe('hotkeyMatchesQuery', () => {
    it('matches partial query', () => {
      expect(hotkeyMatchesQuery('cmd+shift+p', 'cmd')).toBe(true);
    });

    it('rejects non-matching query', () => {
      expect(hotkeyMatchesQuery('cmd+shift+p', 'ctrl+a')).toBe(false);
    });

    it('returns false for empty query', () => {
      expect(hotkeyMatchesQuery('cmd+k', '')).toBe(false);
    });
  });

  describe('hotkeyToDisplay', () => {
    it('converts keys to Mac symbols', () => {
      expect(hotkeyToDisplay('cmd+shift+p')).toBe('⌘⇧P');
    });

    it('handles single key', () => {
      expect(hotkeyToDisplay('?')).toBe('?');
    });
  });

  // The Windows/Linux table is derived from the Mac one by spreading and overriding only
  // the keys that differ, so these lock both halves: the overrides and the inherited keys.
  describe('keysToDisplayPlatform', () => {
    it('renders modifier glyphs on Mac and joined words elsewhere', () => {
      expect(keysToDisplayPlatform(['cmd', 'shift', 'A'], true)).toBe('⌘⇧A');
      expect(keysToDisplayPlatform(['cmd', 'shift', 'A'], false)).toBe('Ctrl+Shift+A');
    });

    it('maps every modifier that differs between platforms', () => {
      expect(keysToDisplayPlatform(['meta', 'opt', 'enter'], true)).toBe('⌘⌥↵');
      expect(keysToDisplayPlatform(['meta', 'opt', 'enter'], false)).toBe('Ctrl+Alt+Enter');
      expect(keysToDisplayPlatform(['ctrl', 'backspace'], false)).toBe('Ctrl+Backspace');
      expect(keysToDisplayPlatform(['alt', 'delete'], false)).toBe('Alt+Delete');
    });

    // Minus is the one key whose two entries differ by a single invisible character:
    // Mac uses U+2212 MINUS SIGN, Windows/Linux the ASCII hyphen.
    it('keeps the typographic minus on Mac and the ASCII hyphen elsewhere', () => {
      expect(keysToDisplayPlatform(['cmd', 'minus'], true)).toBe('⌘−');
      expect(keysToDisplayPlatform(['cmd', 'minus'], false)).toBe('Ctrl+-');
    });

    it('shares the keys that are identical on both platforms', () => {
      for (const key of ['escape', 'tab', 'space', 'arrowup', 'arrowright', 'click', 'plus']) {
        expect(keysToDisplayPlatform([key], false)).toBe(keysToDisplayPlatform([key], true));
      }
    });

    it('falls back to an upper-cased label for unmapped keys', () => {
      expect(keysToDisplayPlatform(['cmd', 'k'], false)).toBe('Ctrl+K');
    });
  });
});
