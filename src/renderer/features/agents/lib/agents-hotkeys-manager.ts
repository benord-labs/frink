/* eslint-disable max-lines, max-lines-per-function */
/**
 * Hotkeys manager for Agents
 * Centralized keyboard shortcut handling
 */

import * as React from 'react';
import { useCallback, useMemo } from 'react';
import type { CustomHotkeysConfig, SettingsTab } from '../../../lib/atoms';
import {
  ALL_SHORTCUT_ACTIONS,
  getResolvedHotkey,
  matchesHotkey,
  type ShortcutActionId,
} from '../../../lib/hotkeys';
import {
  AGENT_ACTIONS,
  type AgentActionContext,
  executeAgentAction,
  getAvailableAgentActions,
} from './agents-actions';

// ============================================================================
// ACTION ID MAPPING
// ============================================================================

/**
 * Shortcut IDs whose agent action carries a different name. Every other shortcut
 * ID doubles as its action ID, so the reverse map below fills in the 1:1 pairs.
 *
 * Order matters: when two shortcuts share one action ID the last one registered
 * wins, so `create-new-agent` resolves back to `new-agent`, not `new-workspace`.
 */
const SHORTCUT_ACTION_OVERRIDES: Partial<Record<ShortcutActionId, string>> = {
  'show-shortcuts': 'open-shortcuts',
  'new-workspace': 'create-new-agent',
  'new-agent': 'create-new-agent',
  'search-in-chat': 'toggle-chat-search',
};

// Reverse mapping: action ID -> shortcut ID
const ACTION_TO_SHORTCUT_MAP: Record<string, ShortcutActionId> = Object.fromEntries(
  ALL_SHORTCUT_ACTIONS.map((a) => [SHORTCUT_ACTION_OVERRIDES[a.id] ?? a.id, a.id]),
);

export { matchesHotkey };

// ============================================================================
// TYPES
// ============================================================================

type AgentsHotkeysManagerConfig = {
  /** Prepare a destination before its action mutates chat/files/split state. */
  onBeforeAction?: (actionId: string) => boolean | Promise<boolean>;
  setSelectedChatId?: (id: string | null) => void;
  setShowNewChatForm?: (show: boolean) => void;
  setSidebarOpen?: (open: boolean | ((prev: boolean) => boolean)) => void;
  setFilesSidebarOpen?: (open: boolean | ((prev: boolean) => boolean)) => void;
  setSettingsDialogOpen?: (open: boolean) => void;
  setSettingsActiveTab?: (tab: SettingsTab) => void;
  setFileSearchDialogOpen?: (open: boolean) => void;
  activateFilesSidebarSearch?: () => void;
  activateActivePaneFileSearch?: () => void;
  toggleChatSearch?: () => void;
  /** True when a local project is selected and Browse files is available */
  canShowFilesSidebar?: boolean;
  /** Whether the files sidebar is currently open */
  isFilesSidebarOpen?: boolean;
  /** Toggle the active pane's file tree in split view */
  toggleActivePaneFileTree?: () => void;
  /** Close all open text files in the code editor */
  closeAllEditorFiles?: () => void;
  /** Cycle code editor layout (top -> left -> right) when editor is open */
  toggleEditorLayout?: () => void;
  /** Focus the sidebar tree container for keyboard navigation */
  focusSidebar?: () => void;
  customHotkeysConfig?: CustomHotkeysConfig;
  /** Split view callbacks */
  addEmptyPane?: () => void;
  newChatAtPane?: (index: number) => void;
  activePaneIndex?: number;
  setActivePaneIndex?: (index: number) => void;
  isSplitActive?: boolean;
  paneCount?: number;
  /** Cycle through valid pane layouts */
  cycleLayout?: () => void;
  /** Grow active pane (Cmd+Alt+Right/Down) */
  growPane?: () => void;
  /** Shrink active pane (Cmd+Alt+Left/Up) */
  shrinkPane?: () => void;
  /** Reset pane sizes to equal (Cmd+Alt+R) */
  resetPaneSizes?: () => void;
  /** Reset all pane zoom to 1x (Cmd+Alt+0) */
  resetPaneZoom?: () => void;
  /** Window zoom in (for Cmd+Shift+Plus combo) */
  zoomIn?: () => void | Promise<void>;
  /** Window zoom out (for Cmd+Shift+Minus combo) */
  zoomOut?: () => void | Promise<void>;
  /** Zoom in current pane only */
  zoomPaneIn?: () => void;
  /** Zoom out current pane only */
  zoomPaneOut?: () => void;
  /** Whether the visible destination can show the unified sidebar */
  canToggleUnifiedSidebar?: boolean;
};

type UseAgentsHotkeysOptions = {
  enabled?: boolean;
  preventDefault?: boolean;
};

// Hotkeys that work even when focus is inside an input/textarea/contenteditable.
// Modifier-based shortcuts (Cmd/Ctrl+…) don't conflict with typing, so we allow
// them globally. Pane/layout, sidebar, and app-level actions are included so
// users don't have to blur the chat input to use shortcuts.
const GLOBAL_HOTKEYS = new Set([
  'open-shortcuts',
  'toggle-sidebar',
  'open-settings',
  'toggle-chat-search',
  'undo-archive',
  'collapse-all-sidebar',
  'toggle-archived',
  'close-all-editor-files',
  'toggle-editor-layout',
  'focus-sidebar',
  'new-agent-split',
  'close-split',
  'archive-workspace',
  'archive-agent',
  'toggle-files',
  'file-search',
  'find-in-files',
  'open-file-in-editor',
  'open-branch-picker',
  'open-branch-delete-picker',
  'focus-input',
  'toggle-focus',
  'stop-generation',
  'switch-model',
  'toggle-terminal',
  'toggle-terminal-mode',
  'open-diff',
  'create-pr',
  'next-pane-group',
  'prev-pane-group',
  'next-pane',
  'prev-pane',
  'cycle-pane-layout',
  'grow-pane',
  'shrink-pane',
  'reset-pane-sizes',
  'reset-pane-zoom',
  'page-zoom-in',
  'page-zoom-out',
  'zoom-in-grow-pane',
  'zoom-out-shrink-pane',
  'zoom-pane-in',
  'zoom-pane-out',
  'reorder-pane-left',
  'reorder-pane-right',
]);

// Early-capture hotkeys (handled before general loop so they work from code editor / inputs)
const EARLY_HOTKEY_BINDINGS: Array<{ shortcutId: ShortcutActionId; actionId: string }> = [
  { shortcutId: 'toggle-sidebar', actionId: 'toggle-sidebar' },
  { shortcutId: 'show-shortcuts', actionId: 'open-shortcuts' },
  { shortcutId: 'open-settings', actionId: 'open-settings' },
  { shortcutId: 'search-in-chat', actionId: 'toggle-chat-search' },
  { shortcutId: 'next-pane-group', actionId: 'next-pane-group' },
  { shortcutId: 'prev-pane-group', actionId: 'prev-pane-group' },
];

function isEventInsideCodeEditorPanel(target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return false;
  const panel = document.querySelector('[data-code-editor-panel="true"]');
  return panel instanceof Element && panel.contains(target);
}

// ============================================================================
// HOTKEYS MANAGER HOOK
// ============================================================================

export function useAgentsHotkeys(
  config: AgentsHotkeysManagerConfig,
  options: UseAgentsHotkeysOptions = {},
) {
  const { enabled = true, preventDefault = true } = options;

  const createActionContext = useCallback(
    (): AgentActionContext => ({
      setSelectedChatId: config.setSelectedChatId,
      setShowNewChatForm: config.setShowNewChatForm,
      setSidebarOpen: config.setSidebarOpen,
      setFilesSidebarOpen: config.setFilesSidebarOpen,
      setSettingsDialogOpen: config.setSettingsDialogOpen,
      setSettingsActiveTab: config.setSettingsActiveTab,
      setFileSearchDialogOpen: config.setFileSearchDialogOpen,
      activateFilesSidebarSearch: config.activateFilesSidebarSearch,
      activateActivePaneFileSearch: config.activateActivePaneFileSearch,
      toggleChatSearch: config.toggleChatSearch,
      canShowFilesSidebar: config.canShowFilesSidebar,
      isFilesSidebarOpen: config.isFilesSidebarOpen,
      closeAllEditorFiles: config.closeAllEditorFiles,
      toggleEditorLayout: config.toggleEditorLayout,
      addEmptyPane: config.addEmptyPane,
      newChatAtPane: config.newChatAtPane,
      activePaneIndex: config.activePaneIndex,
      setActivePaneIndex: config.setActivePaneIndex,
      isSplitActive: config.isSplitActive,
      paneCount: config.paneCount,
      toggleActivePaneFileTree: config.toggleActivePaneFileTree,
      focusSidebar: config.focusSidebar,
      cycleLayout: config.cycleLayout,
      growPane: config.growPane,
      shrinkPane: config.shrinkPane,
      resetPaneSizes: config.resetPaneSizes,
      resetPaneZoom: config.resetPaneZoom,
      zoomIn: config.zoomIn,
      zoomOut: config.zoomOut,
      zoomPaneIn: config.zoomPaneIn,
      zoomPaneOut: config.zoomPaneOut,
      canToggleUnifiedSidebar: config.canToggleUnifiedSidebar,
    }),
    [
      config.setSelectedChatId,
      config.setShowNewChatForm,
      config.setSidebarOpen,
      config.setFilesSidebarOpen,
      config.setSettingsDialogOpen,
      config.setSettingsActiveTab,
      config.setFileSearchDialogOpen,
      config.activateFilesSidebarSearch,
      config.activateActivePaneFileSearch,
      config.toggleChatSearch,
      config.canShowFilesSidebar,
      config.isFilesSidebarOpen,
      config.closeAllEditorFiles,
      config.toggleEditorLayout,
      config.addEmptyPane,
      config.newChatAtPane,
      config.activePaneIndex,
      config.setActivePaneIndex,
      config.isSplitActive,
      config.paneCount,
      config.toggleActivePaneFileTree,
      config.focusSidebar,
      config.cycleLayout,
      config.growPane,
      config.shrinkPane,
      config.resetPaneSizes,
      config.resetPaneZoom,
      config.zoomIn,
      config.zoomOut,
      config.zoomPaneIn,
      config.zoomPaneOut,
      config.canToggleUnifiedSidebar,
    ],
  );

  const handleHotkeyAction = useCallback(
    async (actionId: string) => {
      const initialContext = createActionContext();
      const initialAction = getAvailableAgentActions(initialContext).find((a) => a.id === actionId);

      if (!initialAction) return;

      const preparation = config.onBeforeAction?.(actionId);
      if (preparation === false || (preparation instanceof Promise && !(await preparation))) return;

      const context = createActionContext();
      const action = getAvailableAgentActions(context).find(
        (candidate) => candidate.id === actionId,
      );
      if (!action) return;
      await executeAgentAction(actionId, context, 'hotkey');
    },
    [config.onBeforeAction, createActionContext],
  );

  // Listen for Cmd+N via IPC from main process (menu accelerator)
  React.useEffect(() => {
    if (!enabled) return;
    if (!window.desktopApi?.onShortcutNewAgent) return;

    const cleanup = window.desktopApi.onShortcutNewAgent(() => {
      handleHotkeyAction('create-new-agent');
    });

    return cleanup;
  }, [enabled, handleHotkeyAction]);

  // Get the resolved hotkey for a shortcut, respecting custom bindings
  const getHotkeyForAction = useCallback(
    (shortcutId: ShortcutActionId): string | null => {
      const customConfig = config.customHotkeysConfig || { version: 1, bindings: {} };
      return getResolvedHotkey(shortcutId, customConfig);
    },
    [config.customHotkeysConfig],
  );

  // Unified hotkey listener that respects custom configurations (early-capture actions)
  React.useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      for (const { shortcutId, actionId } of EARLY_HOTKEY_BINDINGS) {
        const hotkey = getHotkeyForAction(shortcutId);
        if (!hotkey || !matchesHotkey(e, hotkey)) continue;

        // Don't trigger unmodified single-key shortcuts when focus is in an input (e.g. "?" for shortcuts)
        if (isInInput && hotkey && !hotkey.includes('+')) continue;

        e.preventDefault();
        e.stopPropagation();
        if (shortcutId === 'search-in-chat' && isEventInsideCodeEditorPanel(e.target)) {
          window.dispatchEvent(new CustomEvent('editor:find'));
          return;
        }
        handleHotkeyAction(actionId);
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [enabled, handleHotkeyAction, getHotkeyForAction]);

  // General hotkey handler for remaining actions (editor tab cycle handled in early block above)
  const actionsWithHotkeys = useMemo(
    () =>
      Object.values(AGENT_ACTIONS).filter(
        (action) =>
          action.hotkey !== undefined &&
          action.id !== 'create-new-agent' &&
          action.id !== 'toggle-sidebar' &&
          action.id !== 'open-shortcuts' &&
          action.id !== 'open-settings' &&
          action.id !== 'toggle-chat-search' &&
          action.id !== 'next-pane-group' &&
          action.id !== 'prev-pane-group',
      ),
    [],
  );

  const hotkeyMappings = useMemo(() => {
    const mappings: Array<{
      actionId: string;
      hotkeys: string[];
      isGlobal: boolean;
    }> = [];
    const customConfig = config.customHotkeysConfig ?? { version: 1, bindings: {} };

    for (const action of actionsWithHotkeys) {
      const shortcutId = ACTION_TO_SHORTCUT_MAP[action.id];
      const resolved = shortcutId != null ? getResolvedHotkey(shortcutId, customConfig) : null;
      const hotkeys = resolved
        ? [resolved]
        : Array.isArray(action.hotkey)
          ? action.hotkey
          : [action.hotkey];
      if (hotkeys.length === 0 || !hotkeys[0]) continue;
      const isGlobal = GLOBAL_HOTKEYS.has(action.id);
      mappings.push({
        actionId: action.id,
        hotkeys: hotkeys.filter(Boolean) as string[],
        isGlobal,
      });
    }

    return mappings;
  }, [actionsWithHotkeys, config.customHotkeysConfig]);

  React.useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      for (const mapping of hotkeyMappings) {
        if (isInInput && !mapping.isGlobal) continue;

        for (const hotkey of mapping.hotkeys) {
          if (matchesHotkey(e, hotkey)) {
            if (preventDefault) {
              e.preventDefault();
              e.stopPropagation();
            }
            handleHotkeyAction(mapping.actionId);
            return;
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [enabled, preventDefault, hotkeyMappings, handleHotkeyAction]);

  return {
    executeAction: handleHotkeyAction,
    getAvailableActions: () => getAvailableAgentActions(createActionContext()),
    createActionContext,
  };
}
