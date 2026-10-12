/** Types for the centralized Agents action system (see agents-actions.ts). */

import type { SettingsTab } from '../../../lib/atoms';

export type AgentActionSource = 'hotkey' | 'ui_button' | 'context-menu';

type AgentActionCategory = 'general' | 'navigation' | 'chat' | 'view';

export type AgentActionContext = {
  // Navigation
  setSelectedChatId?: (id: string | null) => void;
  setShowNewChatForm?: (show: boolean) => void;

  // UI states
  setSidebarOpen?: (open: boolean | ((prev: boolean) => boolean)) => void;
  setFilesSidebarOpen?: (open: boolean | ((prev: boolean) => boolean)) => void;
  setSettingsDialogOpen?: (open: boolean) => void;
  setSettingsActiveTab?: (tab: SettingsTab) => void;
  setFileSearchDialogOpen?: (open: boolean) => void;
  activateFilesSidebarSearch?: () => void;
  activateActivePaneFileSearch?: () => void;
  toggleChatSearch?: () => void;

  /** True when a local project is selected and the Browse files sidebar can be shown */
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

  // Split view
  addEmptyPane?: () => void;
  newChatAtPane?: (index: number) => void;
  activePaneIndex?: number;
  setActivePaneIndex?: (index: number) => void;
  isSplitActive?: boolean;
  paneCount?: number;

  /** Cycle through valid pane layouts (horizontal ↔ vertical, etc.) */
  cycleLayout?: () => void;

  /** Grow the active pane (take space from neighbors). Cmd+Alt+Right/Down. */
  growPane?: () => void;
  /** Shrink the active pane (give space to neighbors). Cmd+Alt+Left/Up. */
  shrinkPane?: () => void;
  /** Reset pane sizes to equal (snap to grid). Cmd+Alt+R. */
  resetPaneSizes?: () => void;
  /** Reset all pane zoom factors to 1x. Cmd+Alt+0. */
  resetPaneZoom?: () => void;
  /** Window zoom in (Electron webContents). Used with grow for Cmd+Shift+Plus. */
  zoomIn?: () => void | Promise<void>;
  /** Window zoom out. Used with shrink for Cmd+Shift+Minus. */
  zoomOut?: () => void | Promise<void>;
  /** Zoom in the current pane only (per-pane scale). Cmd+Alt+Plus. */
  zoomPaneIn?: () => void;
  /** Zoom out the current pane only. Cmd+Alt+Minus. */
  zoomPaneOut?: () => void;
  /** Whether the visible destination can show the unified sidebar (see ActiveOverlayViewPolicy). */
  canToggleUnifiedSidebar?: boolean;
  /** Archive the focused chat. Wired only while the chat destination is visible on desktop. */
  archiveFocusedChat?: () => void;
};

export type AgentActionResult = {
  success: boolean;
  error?: string;
};

type AgentActionHandler = (
  context: AgentActionContext,
  source: AgentActionSource,
) => Promise<AgentActionResult> | AgentActionResult;

export type AgentActionDefinition = {
  id: string;
  label: string;
  description?: string;
  category: AgentActionCategory;
  hotkey?: string | string[];
  handler: AgentActionHandler;
  isAvailable?: (context: AgentActionContext) => boolean;
};
