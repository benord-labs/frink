// Constants for FilesSidebar component
export const SEARCH_DEBOUNCE_MS = 300;
export const FILES_FETCH_LIMIT = 5000; // Increased to support larger codebases
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 400;

/** Split-pane file tree: narrower limits so sidebar cannot dominate a 200px-min pane */
export const SPLIT_FILE_TREE_MIN_WIDTH = 160;
export const SPLIT_FILE_TREE_MAX_WIDTH = 280;

/** Split-pane file tree mounted and ready for `pane-file-tree:activate-search`. */
export const PANE_FILE_TREE_READY_EVENT = 'pane-file-tree:ready' as const;

/** aria-keyshortcuts value for the file tree (shared by FilesSidebar and PaneFileTree) */
export const FILE_TREE_KEY_SHORTCUTS =
  'ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Meta+A Control+A Meta+C Control+C Meta+D Control+D Meta+V Control+V Escape Backspace';

/** Indent width per level in pixels (used by TreeNode and InlineInput) */
export const TREE_INDENT_WIDTH = 12;
/** Base padding for the first level (used by TreeNode and InlineInput) */
export const TREE_BASE_PADDING = 6;

/** Width of chevron slot only (h-3.5 w-3.5 = 14px); gap-1.5 applies after spacer so file icon aligns with folder icon */
export const TREE_CHEVRON_SPACER_PX = 14;
