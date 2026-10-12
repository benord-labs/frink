/**
 * Unique identifier for each configurable shortcut action
 */
export type ShortcutActionId =
  // General
  | 'show-shortcuts'
  | 'open-settings'
  | 'close-settings'
  | 'close-flows'
  | 'flow-editor-back-to-list'
  | 'toggle-sidebar'
  | 'undo-archive'
  | 'collapse-all-sidebar'
  | 'focus-sidebar'
  | 'toggle-archived'
  // Workspaces
  | 'new-workspace'
  | 'search-workspaces'
  | 'archive-workspace'
  // Agents
  | 'new-agent'
  | 'new-agent-split'
  | 'close-split'
  | 'search-in-chat'
  | 'archive-agent'
  | 'focus-input'
  | 'toggle-focus'
  | 'stop-generation'
  | 'switch-model'
  | 'toggle-terminal'
  | 'toggle-terminal-mode'
  | 'open-diff'
  | 'create-pr'
  | 'file-search'
  | 'find-in-files'
  | 'open-file-in-editor'
  | 'open-branch-picker'
  | 'open-branch-delete-picker'
  | 'toggle-files'
  | 'close-all-editor-files'
  | 'toggle-editor-layout'
  | 'next-pane-group'
  | 'prev-pane-group'
  | 'next-pane'
  | 'prev-pane'
  | 'edit-slash-command'
  | 'approve-plan'
  | 'force-submit'
  | 'scroll-to-bottom'
  | 'search-next'
  | 'search-prev'
  | 'reorder-pane-left'
  | 'reorder-pane-right'
  | 'cycle-pane-layout'
  | 'grow-pane'
  | 'shrink-pane'
  | 'reset-pane-sizes'
  | 'reset-pane-zoom'
  | 'page-zoom-in'
  | 'page-zoom-out'
  | 'zoom-in-grow-pane'
  | 'zoom-out-shrink-pane'
  | 'zoom-pane-in'
  | 'zoom-pane-out'
  // Editor (context-only, non-rebindable — handled locally in CodeEditorPanel)
  | 'editor-save'
  | 'editor-close-tab'
  | 'editor-toggle-maximize'
  | 'editor-toggle-inline-diff'
  | 'editor-toggle-markdown-preview'
  | 'editor-close-panel'
  // Files (context-dependent, handled locally by file tree)
  | 'file-delete'
  | 'file-rename'
  | 'file-new-file'
  | 'file-new-folder'
  | 'file-duplicate'
  | 'file-copy'
  | 'file-paste'
  | 'file-select-all'
  | 'file-extend-selection-down'
  | 'file-extend-selection-up'
  | 'file-toggle-select'
  | 'file-range-select'
  | 'file-clear-selection'
  // Tree navigation (context-only, non-rebindable)
  | 'file-nav-up'
  | 'file-nav-down'
  | 'file-collapse'
  | 'file-expand';

/**
 * Category for organizing shortcuts in the UI
 */
export type ShortcutCategory = 'general' | 'workspaces' | 'agents' | 'files';

/**
 * Definition of a configurable shortcut action
 */
export type ShortcutAction = {
  id: ShortcutActionId;
  label: string;
  category: ShortcutCategory;
  /** Default key combination, e.g., ["cmd", "N"] or ["?"] */
  defaultKeys: string[];
  /** Alternative key combination shown with "or", e.g., ["cmd", "]"] */
  altKeys?: string[];
  /**
   * If true, this shortcut only fires when its container is focused.
   * Context-only shortcuts don't conflict with global/agent shortcuts
   * because they operate in a different scope (e.g. file tree must be focused).
   */
  contextOnly?: boolean;
  /**
   * If true, this shortcut cannot be rebound by the user.
   * Used for mouse-based shortcuts (Cmd+Click, Shift+Click) and
   * any other actions where custom keybindings don't make sense.
   */
  nonRebindable?: boolean;
};

/**
 * Storage structure for custom hotkey overrides
 * Stored in localStorage
 */
export type CustomHotkeysConfig = {
  version: 1;
  /** Map of actionId to a custom hotkey string (e.g., "cmd+shift+n"), or null for unbound. An
   *  absent key means the default. */
  bindings: Record<string, string | null>;
};

/**
 * Conflict information for a shortcut
 */
export type ShortcutConflict = {
  actionId: ShortcutActionId;
  conflictingActionIds: ShortcutActionId[];
  hotkey: string;
};
