/* eslint-disable max-lines, max-lines-per-function */
/**
 * Centralized action system for Agents
 * Actions can be triggered via hotkeys or UI buttons
 */

import type { SettingsTab } from '../../../lib/atoms';
import { focusChatInput } from '../../../lib/focus-chat-input';

// ============================================================================
// TYPES
// ============================================================================

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

// ============================================================================
// ACTION HANDLERS
// ============================================================================

const openShortcutsAction: AgentActionDefinition = {
  id: 'open-shortcuts',
  label: 'Keyboard shortcuts',
  description: 'Show all keyboard shortcuts',
  category: 'general',
  hotkey: '?',
  handler: async (context) => {
    // Open settings dialog on Keyboard tab instead of separate shortcuts dialog
    context.setSettingsActiveTab?.('keyboard');
    context.setSettingsDialogOpen?.(true);
    return { success: true };
  },
};

const createNewAgentAction: AgentActionDefinition = {
  id: 'create-new-agent',
  label: 'New workspace',
  description: 'Create a new workspace',
  category: 'general',
  hotkey: 'cmd+n',
  handler: async (context) => {
    if (context.isSplitActive) {
      // In split view: replace the active pane with a new chat
      const idx = context.activePaneIndex ?? 0;
      context.newChatAtPane?.(idx);
    } else {
      // Single view: show new chat form and clear selected draft.
      context.setSelectedChatId?.(null);
      context.setShowNewChatForm?.(true);
    }
    return { success: true };
  },
};

const openSettingsAction: AgentActionDefinition = {
  id: 'open-settings',
  label: 'Settings',
  description: 'Open settings dialog',
  category: 'general',
  hotkey: ['cmd+,', 'ctrl+,'],
  handler: async (context) => {
    context.setSettingsActiveTab?.('preferences');
    context.setSettingsDialogOpen?.(true);
    return { success: true };
  },
};

const toggleSidebarAction: AgentActionDefinition = {
  id: 'toggle-sidebar',
  label: 'Toggle sidebar',
  description: 'Show/hide left sidebar',
  category: 'view',
  hotkey: ['cmd+b', 'ctrl+b'],
  isAvailable: (context) => context.canToggleUnifiedSidebar ?? false,
  handler: async (context) => {
    context.setSidebarOpen?.((prev) => !prev);
    return { success: true };
  },
};

const toggleChatSearchAction: AgentActionDefinition = {
  id: 'toggle-chat-search',
  label: 'Search messages',
  description: 'Search through chat history',
  category: 'view',
  hotkey: ['cmd+f', 'ctrl+f'],
  handler: async (context) => {
    context.toggleChatSearch?.();
    return { success: true };
  },
};

const toggleFilesAction: AgentActionDefinition = {
  id: 'toggle-files',
  label: 'Browse files',
  description: 'Toggle the Browse files sidebar (when a local project is selected)',
  category: 'view',
  hotkey: ['cmd+shift+f', 'ctrl+shift+f'],
  handler: async (context) => {
    // In split view, toggle the active pane's file tree
    if (context.isSplitActive && context.toggleActivePaneFileTree) {
      context.toggleActivePaneFileTree();
      return { success: true };
    }

    if (!context.canShowFilesSidebar) return { success: true };

    if (context.isFilesSidebarOpen) {
      context.setFilesSidebarOpen?.(false);
    } else {
      context.setFilesSidebarOpen?.(true);
      // Focus the tree after it opens so keyboard navigation works immediately
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('file-tree:focus'));
      });
    }
    return { success: true };
  },
};

const fileSearchAction: AgentActionDefinition = {
  id: 'file-search',
  label: 'Search files',
  description: 'Open file search dialog',
  category: 'view',
  hotkey: ['cmd+shift+p', 'ctrl+shift+p'],
  handler: async (context) => {
    if (!context.canShowFilesSidebar) return { success: true };
    context.setFileSearchDialogOpen?.(true);
    return { success: true };
  },
};

const findInFilesAction: AgentActionDefinition = {
  id: 'find-in-files',
  label: 'Find in files (Search tab)',
  description: 'Search inside file contents',
  category: 'view',
  hotkey: ['cmd+shift+g', 'ctrl+shift+g'],
  handler: async (context) => {
    if (context.isSplitActive && context.activateActivePaneFileSearch) {
      context.activateActivePaneFileSearch();
      return { success: true };
    }
    if (!context.canShowFilesSidebar) return { success: true };
    context.activateFilesSidebarSearch?.();
    return { success: true };
  },
};

type EventActionInput = Omit<AgentActionDefinition, 'category' | 'handler'>;
/** View action whose only effect is announcing an event its owning feature listens for. */
const createEventAction = (event: string, action: EventActionInput): AgentActionDefinition => ({
  ...action,
  category: 'view',
  handler: async () => {
    window.dispatchEvent(new CustomEvent(event));
    return { success: true };
  },
});

const EVENT_ACTIONS: AgentActionDefinition[] = [
  createEventAction('file-viewer:open-in-editor', {
    id: 'open-file-in-editor',
    label: 'Open file in editor',
    description: 'Open the currently previewed file in external editor',
    hotkey: ['cmd+shift+o', 'ctrl+shift+o'],
  }),
  createEventAction('branches:open-picker', {
    id: 'open-branch-picker',
    label: 'Open branch picker',
    description: 'Open the current chat branch picker',
    hotkey: ['cmd+shift+b', 'ctrl+shift+b'],
  }),
  createEventAction('branches:open-delete-picker', {
    id: 'open-branch-delete-picker',
    label: 'Delete branch picker',
    description: 'Open the branch delete picker for the current chat',
    hotkey: ['cmd+shift+backspace', 'ctrl+shift+backspace'],
  }),
  createEventAction('sidebar:collapse-all', {
    id: 'collapse-all-sidebar',
    label: 'Collapse all sidebar folders',
    description: 'Collapse all expanded folders in the sidebar',
    hotkey: ['cmd+shift+e', 'ctrl+shift+e'],
  }),
  createEventAction('sidebar:toggle-archived', {
    id: 'toggle-archived',
    label: 'Toggle archived chats',
    description: 'Show or hide the sidebar archived chats list',
    hotkey: ['cmd+shift+a', 'ctrl+shift+a'],
  }),
  createEventAction('sidebar:archive-focused-chat', {
    id: 'archive-agent',
    label: 'Archive current agent',
    description: 'Archive the focused chat',
    hotkey: ['cmd+w', 'ctrl+w'],
  }),
];

const closeAllEditorFilesAction: AgentActionDefinition = {
  id: 'close-all-editor-files',
  label: 'Close all editor files',
  description: 'Close all open text files in the code editor',
  category: 'view',
  hotkey: ['cmd+shift+x', 'ctrl+shift+x'],
  handler: async (context) => {
    context.closeAllEditorFiles?.();
    return { success: true };
  },
};

const toggleEditorLayoutAction: AgentActionDefinition = {
  id: 'toggle-editor-layout',
  label: 'Cycle editor layout',
  description: 'Cycle code editor position: top, left, right (when editor is open)',
  category: 'view',
  hotkey: ['cmd+shift+v', 'ctrl+shift+v'],
  handler: async (context) => {
    context.toggleEditorLayout?.();
    return { success: true };
  },
};

/** Factory for pane group cycling actions (next/prev share the same shape) */
function createPaneGroupAction(
  direction: 1 | -1,
  id: string,
  label: string,
  hotkey: string[],
): AgentActionDefinition {
  return {
    id,
    label,
    description: `Switch to the ${direction === 1 ? 'next' : 'previous'} editor tab`,
    category: 'view',
    hotkey,
    handler: async () => {
      window.dispatchEvent(new CustomEvent('editor:cycle-pane-group', { detail: direction }));
      return { success: true };
    },
  };
}

const nextPaneGroupAction = createPaneGroupAction(1, 'next-pane-group', 'Next editor tab', [
  'cmd+shift+]',
  'ctrl+shift+]',
]);

const prevPaneGroupAction = createPaneGroupAction(-1, 'prev-pane-group', 'Previous editor tab', [
  'cmd+shift+[',
  'ctrl+shift+[',
]);

const newAgentSplitAction: AgentActionDefinition = {
  id: 'new-agent-split',
  label: 'Add split pane',
  description: 'Add an empty pane to split view alongside the current chat',
  category: 'chat',
  hotkey: ['cmd+shift+t', 'ctrl+shift+t'],
  handler: async (context) => {
    // addEmptyPane (from useSplitView) handles all cases:
    // - Single view → split: uses selectedChatId or NEW_CHAT_PANE as fallback
    // - Already split → adds another pane (up to max)
    context.addEmptyPane?.();
    return { success: true };
  },
};

/** Factory for pane focus cycling actions (next/prev share the same shape) */
function createPaneFocusAction(
  direction: 1 | -1,
  id: string,
  label: string,
  hotkey: string[],
): AgentActionDefinition {
  return {
    id,
    label,
    description: `Focus the ${direction === 1 ? 'next' : 'previous'} pane in split view`,
    category: 'view',
    hotkey,
    handler: async (context) => {
      if (!context.isSplitActive || !context.setActivePaneIndex || context.paneCount == null) {
        return { success: true };
      }
      const current = context.activePaneIndex ?? 0;
      const next = (current + direction + context.paneCount) % context.paneCount;
      context.setActivePaneIndex(next);

      // Auto-focus the input in the target pane so the user can type immediately
      requestAnimationFrame(() => {
        const paneEl = document.querySelector(`[data-pane-index="${next}"]`);
        focusChatInput(paneEl);
      });

      return { success: true };
    },
  };
}

const nextPaneAction = createPaneFocusAction(1, 'next-pane', 'Focus next pane', [
  'cmd+]',
  'ctrl+]',
]);

const prevPaneAction = createPaneFocusAction(-1, 'prev-pane', 'Focus previous pane', [
  'cmd+[',
  'ctrl+[',
]);

const focusSidebarAction: AgentActionDefinition = {
  id: 'focus-sidebar',
  label: 'Focus sidebar',
  description: 'Focus the sidebar tree for keyboard navigation',
  category: 'view',
  hotkey: ['cmd+;', 'ctrl+;'],
  isAvailable: (context) => context.canToggleUnifiedSidebar ?? false,
  handler: async (context) => {
    // Open sidebar if closed, then focus the tree container
    context.setSidebarOpen?.(true);
    // Small delay to let sidebar render if it was closed
    requestAnimationFrame(() => {
      context.focusSidebar?.();
    });
    return { success: true };
  },
};

const cyclePaneLayoutAction: AgentActionDefinition = {
  id: 'cycle-pane-layout',
  label: 'Cycle pane layout',
  description: 'Cycle through available pane layouts (side-by-side, stacked, grid)',
  category: 'view',
  hotkey: ['cmd+shift+l', 'ctrl+shift+l'],
  handler: async (context) => {
    context.cycleLayout?.();
    return { success: true };
  },
};

const growPaneAction: AgentActionDefinition = {
  id: 'grow-pane',
  label: 'Grow active pane',
  description: 'Give more space to the active pane (take from neighbors)',
  category: 'view',
  hotkey: ['cmd+alt+right', 'cmd+alt+down', 'ctrl+alt+right', 'ctrl+alt+down'],
  isAvailable: (context) => (context.isSplitActive ?? false) && (context.paneCount ?? 0) >= 2,
  handler: async (context) => {
    context.growPane?.();
    return { success: true };
  },
};

const shrinkPaneAction: AgentActionDefinition = {
  id: 'shrink-pane',
  label: 'Shrink active pane',
  description: 'Give less space to the active pane (give to neighbors)',
  category: 'view',
  hotkey: ['cmd+alt+left', 'cmd+alt+up', 'ctrl+alt+left', 'ctrl+alt+up'],
  isAvailable: (context) => (context.isSplitActive ?? false) && (context.paneCount ?? 0) >= 2,
  handler: async (context) => {
    context.shrinkPane?.();
    return { success: true };
  },
};

const resetPaneSizesAction: AgentActionDefinition = {
  id: 'reset-pane-sizes',
  label: 'Reset pane sizes',
  description: 'Reset all pane sizes to equal (snap to grid)',
  category: 'view',
  hotkey: ['cmd+alt+r', 'ctrl+alt+r'],
  isAvailable: (context) => (context.isSplitActive ?? false) && (context.paneCount ?? 0) >= 2,
  handler: async (context) => {
    context.resetPaneSizes?.();
    return { success: true };
  },
};

const resetPaneZoomAction: AgentActionDefinition = {
  id: 'reset-pane-zoom',
  label: 'Reset pane zoom',
  description: 'Reset all pane zoom levels to 100%',
  category: 'view',
  hotkey: ['cmd+alt+0', 'ctrl+alt+0'],
  isAvailable: (context) => (context.isSplitActive ?? false) && (context.paneCount ?? 0) >= 2,
  handler: async (context) => {
    context.resetPaneZoom?.();
    return { success: true };
  },
};

const zoomInGrowPaneAction: AgentActionDefinition = {
  id: 'zoom-in-grow-pane',
  label: 'Zoom in current pane and grow',
  description: 'In split: zoom active pane and grow it. Otherwise: window zoom in (Cmd+Shift+Plus)',
  category: 'view',
  hotkey: ['cmd+shift+plus', 'ctrl+shift+plus'],
  handler: async (context) => {
    if ((context.isSplitActive ?? false) && (context.paneCount ?? 0) >= 2) {
      context.zoomPaneIn?.();
      context.growPane?.();
    } else {
      await context.zoomIn?.();
    }
    return { success: true };
  },
};

const zoomOutShrinkPaneAction: AgentActionDefinition = {
  id: 'zoom-out-shrink-pane',
  label: 'Zoom out current pane and shrink',
  description:
    'In split: zoom out active pane and shrink it. Otherwise: window zoom out (Cmd+Shift+Minus)',
  category: 'view',
  hotkey: ['cmd+shift+minus', 'ctrl+shift+minus'],
  handler: async (context) => {
    if ((context.isSplitActive ?? false) && (context.paneCount ?? 0) >= 2) {
      context.zoomPaneOut?.();
      context.shrinkPane?.();
    } else {
      await context.zoomOut?.();
    }
    return { success: true };
  },
};

const pageZoomInAction: AgentActionDefinition = {
  id: 'page-zoom-in',
  label: 'Page zoom in',
  description: 'Zoom the entire window in (Cmd+Plus without Shift)',
  category: 'view',
  hotkey: ['cmd+plus', 'ctrl+plus'],
  handler: async (context) => {
    await context.zoomIn?.();
    return { success: true };
  },
};

const pageZoomOutAction: AgentActionDefinition = {
  id: 'page-zoom-out',
  label: 'Page zoom out',
  description: 'Zoom the entire window out (Cmd+Minus without Shift)',
  category: 'view',
  hotkey: ['cmd+minus', 'ctrl+minus'],
  handler: async (context) => {
    await context.zoomOut?.();
    return { success: true };
  },
};

const zoomPaneInAction: AgentActionDefinition = {
  id: 'zoom-pane-in',
  label: 'Zoom in current pane',
  description: 'Zoom in only the active pane content',
  category: 'view',
  hotkey: ['cmd+alt+plus', 'ctrl+alt+plus'],
  isAvailable: (context) => (context.isSplitActive ?? false) && (context.paneCount ?? 0) >= 2,
  handler: async (context) => {
    context.zoomPaneIn?.();
    return { success: true };
  },
};

const zoomPaneOutAction: AgentActionDefinition = {
  id: 'zoom-pane-out',
  label: 'Zoom out current pane',
  description: 'Zoom out only the active pane content',
  category: 'view',
  hotkey: ['cmd+alt+minus', 'ctrl+alt+minus'],
  isAvailable: (context) => (context.isSplitActive ?? false) && (context.paneCount ?? 0) >= 2,
  handler: async (context) => {
    context.zoomPaneOut?.();
    return { success: true };
  },
};

const closeSplitAction: AgentActionDefinition = {
  id: 'close-split',
  label: 'Close active pane',
  description: 'Remove the active pane from split view (exits split when 2→1)',
  category: 'view',
  hotkey: ['cmd+shift+w', 'ctrl+shift+w'],
  handler: async (context) => {
    if (context.isSplitActive) {
      // Dispatch event so agents-content.tsx can handle cleanup (editor tabs, etc.)
      // This converges the hotkey path with the ✕ button path.
      window.dispatchEvent(new CustomEvent('split:remove-active-pane'));
    }
    return { success: true };
  },
};

// ============================================================================
// ACTION REGISTRY
// ============================================================================

export const AGENT_ACTIONS: Record<string, AgentActionDefinition> = {
  'open-shortcuts': openShortcutsAction,
  'create-new-agent': createNewAgentAction,
  'new-agent-split': newAgentSplitAction,
  'close-split': closeSplitAction,
  'open-settings': openSettingsAction,
  'toggle-sidebar': toggleSidebarAction,
  'focus-sidebar': focusSidebarAction,
  'toggle-chat-search': toggleChatSearchAction,
  'toggle-files': toggleFilesAction,
  'file-search': fileSearchAction,
  'find-in-files': findInFilesAction,
  ...Object.fromEntries(EVENT_ACTIONS.map((action) => [action.id, action])),
  'close-all-editor-files': closeAllEditorFilesAction,
  'toggle-editor-layout': toggleEditorLayoutAction,
  'next-pane-group': nextPaneGroupAction,
  'prev-pane-group': prevPaneGroupAction,
  'next-pane': nextPaneAction,
  'prev-pane': prevPaneAction,
  'cycle-pane-layout': cyclePaneLayoutAction,
  'grow-pane': growPaneAction,
  'shrink-pane': shrinkPaneAction,
  'reset-pane-sizes': resetPaneSizesAction,
  'reset-pane-zoom': resetPaneZoomAction,
  'page-zoom-in': pageZoomInAction,
  'page-zoom-out': pageZoomOutAction,
  'zoom-in-grow-pane': zoomInGrowPaneAction,
  'zoom-out-shrink-pane': zoomOutShrinkPaneAction,
  'zoom-pane-in': zoomPaneInAction,
  'zoom-pane-out': zoomPaneOutAction,
};

export function getAvailableAgentActions(context: AgentActionContext): AgentActionDefinition[] {
  return Object.values(AGENT_ACTIONS).filter((action) => {
    if (action.isAvailable) {
      return action.isAvailable(context);
    }
    return true;
  });
}

export async function executeAgentAction(
  actionId: string,
  context: AgentActionContext,
  source: AgentActionSource,
): Promise<AgentActionResult> {
  const action = AGENT_ACTIONS[actionId];

  if (!action) {
    return { success: false, error: `Action ${actionId} not found` };
  }

  if (action.isAvailable && !action.isAvailable(context)) {
    return { success: false, error: `Action ${actionId} not available` };
  }

  try {
    return await action.handler(context, source);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
