/* eslint-disable max-lines */
import { atom } from 'jotai';
import { atomFamily, atomWithStorage, selectAtom } from 'jotai/utils';
import { lastActiveTabPerPaneAtom, openFilesAtom } from '@/lib/code-editor/state';
import type { ChatMode } from '../../../../shared/types/chat-mode';
import type { ApprovedPlanContext } from '../../../../shared/types/plan';
import {
  createMainBackedAtomFamily,
  createPersistedAtomFamily,
  createRuntimeAtomFamily,
} from '../../../lib/atoms/atom-family-factory';
import { atomWithWindowStorage } from '../../../lib/window-storage';
import { splitPaneFileTreesAtom, UNSEEDED_SPLIT_PANE_FILE_TREES } from '../../files-sidebar/atoms';

export { selectedAgentChatIdAtom } from '../../../lib/atoms/agent-navigation-atoms';

// Previous agent chat ID - used to navigate back after archiving current chat
// Not persisted - only tracks within current session
export const previousAgentChatIdAtom = atom<string | null>(null);

// Show new chat form explicitly - set to true when "New Workspace" is clicked.
// Cleared when a workspace is selected or a draft is selected.
export const showNewChatFormAtom = atom<boolean>(false);

// Per-chat preview path (persisted)
export const previewPathAtomFamily = createPersistedAtomFamily('agents:previewPaths', '/');

// Per-chat viewport mode (persisted)
export const viewportModeAtomFamily = createPersistedAtomFamily<'desktop' | 'mobile'>(
  'agents:viewportModes',
  'desktop',
);

// Per-chat preview scale (persisted)
export const previewScaleAtomFamily = createPersistedAtomFamily('agents:previewScales', 100);

// Mobile device dimensions storage - stores device settings per chatId
type MobileDeviceSettings = {
  width: number;
  height: number;
  preset: string;
};

// Per-chat mobile device settings (persisted)
export const mobileDeviceAtomFamily = createPersistedAtomFamily<MobileDeviceSettings>(
  'agents:mobileDevices',
  { width: 393, height: 852, preset: 'iPhone 16' },
);

// Loading sub-chats: Map<subChatId, parentChatId>
// Used to show loading indicators on tabs and sidebar
// Set when generation starts, cleared when onFinish fires
export const loadingSubChatsAtom = atom<Map<string, string>>(new Map());

// Helper to set loading state
export const setLoading = (
  setter: (fn: (prev: Map<string, string>) => Map<string, string>) => void,
  subChatId: string,
  parentChatId: string,
) => {
  setter((prev) => {
    // Only create new Map if value actually changed
    // This prevents unnecessary re-renders
    if (prev.get(subChatId) === parentChatId) return prev;
    const next = new Map(prev);
    next.set(subChatId, parentChatId);
    return next;
  });
};

// Helper to clear loading state
export const clearLoading = (
  setter: (fn: (prev: Map<string, string>) => Map<string, string>) => void,
  subChatId: string,
) => {
  setter((prev) => {
    // Only create new Map if subChatId was actually in loading state
    // This prevents unnecessary re-renders when switching between non-loading sub-chats
    if (!prev.has(subChatId)) return prev;
    const next = new Map(prev);
    next.delete(subChatId);
    return next;
  });
};

// Selected local project (persisted)
export type SelectedProject = {
  id: string;
  name: string;
  path: string;
  gitRemoteUrl?: string | null;
  gitProvider?: 'github' | 'gitlab' | 'bitbucket' | null;
  gitOwner?: string | null;
  gitRepo?: string | null;
} | null;

// Selected local project - uses window-scoped storage so each window can work with different projects
export const selectedProjectAtom = atomWithWindowStorage<SelectedProject>(
  'agents:selectedProject',
  null,
  { getOnInit: true },
);

// Worktree path selected in the new-chat form. Shared as an atom so the layout-level
// FilesSidebar can display the correct file tree before a chat is created.
export const newChatWorktreePathAtom = atom<string | null>(null);

// Per-pane project for new-chat panes in split view (keyed by pane index). When in split view,
// each new-chat pane reads/writes its own entry; single-pane new chat uses selectedProjectAtom only.
export const newChatPaneProjectMapAtom = atomWithWindowStorage<Record<number, SelectedProject>>(
  'agents:newChatPaneProjects',
  {},
  { getOnInit: true },
);

// Per-pane work mode for new-chat panes in split view (keyed by pane index). Falls back to
// lastSelectedWorkModeAtom when no explicit per-pane value is set.
export const newChatPaneWorkModeMapAtom = atomWithWindowStorage<Record<number, WorkMode>>(
  'agents:newChatPaneWorkModes',
  {},
  { getOnInit: true },
);

// Per-pane chat mode for new-chat panes in split view (keyed by pane index). Falls back to
// chatModeAtom when no explicit per-pane value is set.
export const newChatPaneChatModeMapAtom = atomWithWindowStorage<Record<number, ChatMode>>(
  'agents:newChatPaneChatModes',
  {},
  { getOnInit: true },
);

// Per-pane last-selected model id for new-chat panes in split view (keyed by pane index). Falls back to
// lastSelectedModelIdAtom when no explicit per-pane value is set.
export const newChatPaneModelMapAtom = atomWithWindowStorage<Record<number, string>>(
  'agents:newChatPaneModels',
  {},
  { getOnInit: true },
);

// Per-chat model selection. Main owns it (shared with the phone); this is the window's cache.
export const lastSelectedModelIdAtomFamily = createMainBackedAtomFamily(
  'agents:lastSelectedModelId:perChat',
  'sonnet',
  'modelId',
);

// Global fallback for contexts without a chatId (e.g. NewChatForm)
export const lastSelectedModelIdAtom = atomWithStorage<string>(
  'agents:lastSelectedModelId',
  'sonnet',
  undefined,
  { getOnInit: true },
);

export const chatModeAtomFamily = createPersistedAtomFamily<ChatMode>(
  'agents:chatMode:perChat',
  'agent',
);

/**
 * Per-chat Auto state, persisted and defaulting on. A Flow seeds it on dispatch, so this single
 * value governs every turn in the chat — and, since it is keyed by parent chat id, every sub-chat.
 */
export const autoModePerChatAtomFamily = createMainBackedAtomFamily(
  'agents:autoModeToolApproval:perChat',
  true,
  'autoMode',
);

export const chatModeAtom = atomWithStorage<ChatMode>('agents:chatMode', 'agent', undefined, {
  getOnInit: true,
});

// Sidebar state - window-scoped so each window has independent sidebar visibility
export const agentsSidebarOpenAtom = atomWithWindowStorage<boolean>('agents-sidebar-open', true, {
  getOnInit: true,
});

// Sidebar width with localStorage persistence
export const agentsSidebarWidthAtom = atomWithStorage<number>(
  'agents-sidebar-width',
  224,
  undefined,
  { getOnInit: true },
);

// Preview sidebar (right) width and open state
export const agentsPreviewSidebarWidthAtom = atomWithStorage<number>(
  'agents-preview-sidebar-width',
  500,
  undefined,
  { getOnInit: true },
);

// Preview sidebar open state - window-scoped
export const agentsPreviewSidebarOpenAtom = atomWithWindowStorage<boolean>(
  'agents-preview-sidebar-open',
  true,
  { getOnInit: true },
);

// Diff sidebar (right) width (global - same width for all chats)
export const agentsDiffSidebarWidthAtom = atomWithStorage<number>(
  'agents-diff-sidebar-width',
  800,
  undefined,
  { getOnInit: true },
);

// Diff panel layout: unified (one column) or split (old and new side by side)
export const diffPanelLayoutAtom = atomWithStorage<'unified' | 'split'>(
  'agents-diff:view-mode',
  'unified',
  undefined,
  { getOnInit: true },
);

// Diff panel open state per chatId (persisted, window-scoped)
const diffSidebarOpenStorageAtom = atomWithWindowStorage<Record<string, boolean>>(
  'agents:diffSidebarOpen',
  {},
  { getOnInit: true },
);

export const diffSidebarOpenAtomFamily = atomFamily((chatId: string) =>
  atom(
    (get) => get(diffSidebarOpenStorageAtom)[chatId] ?? false,
    (get, set, isOpen: boolean) => {
      set(diffSidebarOpenStorageAtom, { ...get(diffSidebarOpenStorageAtom), [chatId]: isOpen });
    },
  ),
);

// File the chat's diff panel should scroll to. Set by the Edit tool card and the sub-chat status
// card, consumed by that chat's diff panel only.
export const focusedDiffFileAtomFamily = atomFamily((_chatId: string) => atom<string | null>(null));

// Track chats with unseen changes (finished streaming but user hasn't opened them)
// Updated by onFinish callback in Chat instances
export const agentsUnseenChangesAtom = atom<Set<string>>(new Set<string>());

// Current todos state per sub-chat
// Syncs the first (creation) todo tool with subsequent updates
// Map structure: { [subChatId]: TodoState }
type TodoItem = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
};

type TodoState = {
  todos: TodoItem[];
  creationToolCallId: string | null; // ID of the tool call that created the todos
};

// Per-subchat todos (runtime only)
export const currentTodosAtomFamily = createRuntimeAtomFamily<TodoState>({
  todos: [],
  creationToolCallId: null,
});

// Current task tools state per sub-chat (from TaskCreate/TaskUpdate/TaskList/TaskGet)
// Synced from AgentTaskToolsGroup component snapshot cache
type TaskToolItem = {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
};

type TaskToolState = {
  tasks: TaskToolItem[];
};

const allTaskToolsStorageAtom = atom<Record<string, TaskToolState>>({});

// atomFamily to get/set task tool state per subChatId
export const currentTaskToolsAtomFamily = atomFamily((subChatId: string) =>
  atom(
    (get) => get(allTaskToolsStorageAtom)[subChatId] ?? { tasks: [] },
    (get, set, newState: TaskToolState) => {
      const current = get(allTaskToolsStorageAtom);
      set(allTaskToolsStorageAtom, { ...current, [subChatId]: newState });
    },
  ),
);

// Global recent files list for Cmd+P quick-open. Stores absolute file paths.
export const recentlyOpenedFilesAtom = atom<string[]>([]);

// Global toggle state for Cmd+P file search dialog.
export const fileSearchDialogOpenAtom = atom<boolean>(false);

// Track sub-chats with unseen changes (finished streaming but user hasn't viewed them)
// Updated by onFinish callback in Chat instances
export const agentsSubChatUnseenChangesAtom = atom<Set<string>>(new Set<string>());

// Mobile view mode - chat (default, shows NewChatForm), chats list, preview, diff, or terminal
export type AgentsMobileViewMode = 'chats' | 'chat' | 'preview' | 'diff' | 'terminal';
export const agentsMobileViewModeAtom = atom<AgentsMobileViewMode>('chat');

// Changed files per sub-chat for tracking edits/writes
// Map<subChatId, FileChange[]>
export type SubChatFileChange = {
  filePath: string;
  displayPath: string;
  additions: number;
  deletions: number;
};

export const subChatFilesAtom = atom<Map<string, SubChatFileChange[]>>(new Map());

// Mapping from subChatId to chatId (workspace ID) for aggregating stats
// Map<subChatId, chatId>
export const subChatToChatMapAtom = atom<Map<string, string>>(new Map());

// Files the chat's diff panel is narrowed to (null = show all files)
export const filteredDiffFilesAtomFamily = atomFamily((_chatId: string) =>
  atom<string[] | null>(null),
);

// Per chat: set while Create PR prepares its message, cleared by that chat's view once it is sent
export const isCreatingPrAtomFamily = atomFamily((_chatId: string) => atom<boolean>(false));

// Sub-chat whose files the chat's diff panel is narrowed to (null = show all); set by Review
export const filteredSubChatIdAtomFamily = atomFamily((_chatId: string) =>
  atom<string | null>(null),
);

/** Opens the chat's diff panel on one file, clearing any filter that would hide it. */
export const openDiffAtFileAtom = atom(
  null,
  (_get, set, { chatId, path }: { chatId: string; path: string }) => {
    set(filteredDiffFilesAtomFamily(chatId), null);
    set(filteredSubChatIdAtomFamily(chatId), null);
    set(diffSidebarOpenAtomFamily(chatId), true);
    set(focusedDiffFileAtomFamily(chatId), path);
  },
);

// Git requests queued for the agent, per chat so only that chat's view sends them.
// Set by ChatView's PR, commit, merge and review actions; consumed by ChatViewInner.
export const pendingPrMessageAtomFamily = atomFamily((_chatId: string) =>
  atom<string | null>(null),
);
export const pendingReviewMessageAtomFamily = atomFamily((_chatId: string) =>
  atom<string | null>(null),
);
export const pendingConflictResolutionMessageAtomFamily = atomFamily((_chatId: string) =>
  atom<string | null>(null),
);

// Text of a new chat message currently being created (API in flight from NewChatForm).
// Allows null panes in split view to show the pending message instead of a blank placeholder.
export const pendingNewChatTextAtom = atom<string | null>(null);

// Pending move-chat continuation prompt.
// Set by agent:move-chat-approved IPC, consumed by usePendingMessageHandlers
// to auto-send a continuation message after the execution restarts with
// the new project's CWD.
export type PendingMoveChatContinuation = {
  chatId: string;
  subChatId: string;
  projectName: string;
  projectPath: string;
};
export const pendingMoveChatContinuationAtom = atom<PendingMoveChatContinuation | null>(null);

export { pendingModeIntentAtomFamily } from '../../../lib/stores/mode-intent';
export type PendingChatRetry = {
  chatId: string;
  subChatId: string;
  projectId: string;
  trigger: 'submit-message' | 'regenerate-message';
  messageId?: string;
  errorCategory: string;
  errorText: string;
  createdAt: number;
};

export type TaskExecutionErrorSignal = {
  error: string;
  category: string;
  timestamp: number;
};

/**
 * Pending retry payload per sub-chat.
 * Sub-chat scoped so inactive tabs cannot consume each other's retries.
 */
export const pendingChatRetryAtomFamily = atomFamily((_subChatId: string) =>
  atomWithStorage<PendingChatRetry | null>(
    `agents:pendingChatRetry:${_subChatId}`,
    null,
    undefined,
    {
      getOnInit: true,
    },
  ),
);

/**
 * Per-sub-chat retry guard to prevent duplicate retry sends.
 */
export const retryInFlightAtomFamily = atomFamily((_subChatId: string) => atom<boolean>(false));

/**
 * Latest execution error signal per sub-chat.
 * Transport/realtime layers write this, task-aware hooks consume it.
 */
export const taskExecutionErrorAtomFamily = atomFamily((_subChatId: string) =>
  atom<TaskExecutionErrorSignal | null>(null),
);

// Work mode preference (local = work in project dir, worktree = create isolated worktree)
export type WorkMode = 'local' | 'worktree';
export const lastSelectedWorkModeAtom = atomWithStorage<WorkMode>(
  'agents:lastSelectedWorkMode',
  'local',
  undefined,
  { getOnInit: true },
);

// Last selected branch per project (persisted)
// Maps projectId -> { name: string, type: "local" | "remote" }
// Custom storage with migration from old string format
const lastSelectedBranchesStorage = {
  getItem: (
    key: string,
    initialValue: Record<string, { name: string; type: 'local' | 'remote' }>,
  ) => {
    const storedValue = localStorage.getItem(key);
    if (!storedValue) return initialValue;

    try {
      const parsed = JSON.parse(storedValue);

      // Migrate old format: Record<string, string> -> Record<string, { name, type }>
      const migrated: Record<string, { name: string; type: 'local' | 'remote' }> = {};
      for (const [projectId, value] of Object.entries(parsed)) {
        if (typeof value === 'string') {
          // Old format: string branch name -> assume "local" type
          migrated[projectId] = { name: value, type: 'local' };
        } else if (value && typeof value === 'object' && 'name' in value && 'type' in value) {
          // New format: already migrated
          migrated[projectId] = value as { name: string; type: 'local' | 'remote' };
        }
      }

      // Save migrated data back to localStorage
      if (Object.keys(migrated).length > 0) {
        localStorage.setItem(key, JSON.stringify(migrated));
      }

      return migrated;
    } catch {
      return initialValue;
    }
  },
  setItem: (key: string, value: Record<string, { name: string; type: 'local' | 'remote' }>) => {
    localStorage.setItem(key, JSON.stringify(value));
  },
  removeItem: (key: string) => {
    localStorage.removeItem(key);
  },
};

export const lastSelectedBranchesAtom = atomWithStorage<
  Record<string, { name: string; type: 'local' | 'remote' }>
>('agents:lastSelectedBranches', {}, lastSelectedBranchesStorage, { getOnInit: true });

// Compacting status per sub-chat
// Set<subChatId> - subChats currently being compacted
export const compactingSubChatsAtom = atom<Set<string>>(new Set<string>());

/** Only the pane for this subChatId re-renders when compacting toggles (avoids full-Set subscription). */
export const compactingForSubChatAtomFamily = atomFamily((subChatId: string) =>
  atom((get) => get(compactingSubChatsAtom).has(subChatId)),
);

// Track IDs of chats/subchats created in this browser session (NOT persisted - resets on reload)
// Used to determine whether to show placeholder + typewriter effect
export const justCreatedIdsAtom = atom<Set<string>>(new Set<string>());

// Pending user questions from AskUserQuestion tool
// Set when Claude requests user input, cleared when answered or skipped
export const QUESTIONS_SKIPPED_MESSAGE = 'User skipped questions - proceed with defaults';

export type PendingUserQuestion = {
  subChatId: string;
  parentChatId: string;
  toolUseId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
};
// Map<toolUseId, PendingUserQuestion> - exact queue supports parallel questions in one sub-chat
export const pendingUserQuestionsAtom = atom<Map<string, PendingUserQuestion>>(new Map());

// Legacy type alias for backwards compatibility
export type PendingUserQuestions = PendingUserQuestion;

// Expired user questions - timed out questions that should still be answerable as normal messages
// Map<toolUseId, PendingUserQuestion> - preserves parallel timeouts in one sub-chat
export const expiredUserQuestionsAtom = atom<Map<string, PendingUserQuestion>>(new Map());

// Show raw JSON for each message in chat (dev/debug use)
export const showMessageJsonAtom = atomWithStorage<boolean>(
  'agents:showMessageJson',
  false,
  undefined,
  { getOnInit: true },
);

// Chat-bubble markdown rendering preference. Tri-state so user (default raw) and assistant
// (default rendered) keep their natural look until the user picks: null = per-role default,
// then 'raw' | 'rendered' applies to ALL bubbles. Persisted across reloads.
export type ChatMarkdownMode = 'raw' | 'rendered' | null;
export const chatMarkdownModeAtom = atomWithStorage<ChatMarkdownMode>(
  'preferences:chat-markdown-mode',
  null,
  undefined,
  { getOnInit: true },
);

// Enable Claude task management tools (TaskCreate, TaskUpdate, etc.). Passed to socket executor and local subscription.
export const enableTasksAtom = atomWithStorage<boolean>('agents:enableTasks', true, undefined, {
  getOnInit: true,
});

// Track sub-chats with pending plan approval (plan ready but not yet implemented)
// Map<subChatId, parentChatId> - allows filtering by workspace
export const pendingPlanApprovalsAtom = atom<Map<string, string>>(new Map());

// Pending "Build plan" trigger - set by ChatView sidebar, consumed by ChatViewInner
// Contains subChatId to approve, null when no pending approval
export const pendingBuildPlanSubChatIdAtom = atom<string | null>(null);

// Approved plan context per sub-chat — set at plan approval time, consumed by transport
// on the next "Build plan" execution turn, then cleared.
// Keyed by subChatId. The transport reads and clears this to inject approved plan context
// into the execution turn even when provider session memory is stale.
export const approvedPlanContextAtomFamily = atomFamily((_subChatId: string) =>
  atom<ApprovedPlanContext | null>(null),
);

/**
 * Append-only set of planIds that have ever been approved in this sub-chat. Unlike
 * {@link approvedPlanContextAtomFamily} (one-shot, cleared by the transport after the execution
 * turn fires), this atom persists for the lifetime of the sub-chat so the plan card UI can
 * permanently hide Approve & Run on every plan inside a closed approval epoch.
 */
export const approvedPlanIdsAtomFamily = atomFamily((_subChatId: string) =>
  atom<Set<string>>(new Set<string>()),
);

/** Dynamic-chat navigation session continuity per sub-chat after approved switches. */
export const navigationSessionIdAtomFamily = atomFamily((_subChatId: string) =>
  atom<string | null>(null),
);

// Store AskUserQuestion results by toolUseId for real-time updates
// Map<toolUseId, result>
export const askUserQuestionResultsAtom = atom<Map<string, unknown>>(new Map());

// ============================================================================
// Top-Level Split View State
// ============================================================================
//
// Pane-index-dependent atoms inventory (update swapAllPaneStateAtom when adding new ones):
// - splitViewAtom (chatIds, ratios, activePaneIndex, gridRatios)
// - splitPaneFileTreesAtom (Set<number>) — files-sidebar/atoms.ts
// - lastActiveTabPerPaneAtom (Record<number, string>) — code-editor/atoms.ts
// - openFilesAtom (sourcePaneIndex on each OpenFile) — code-editor/atoms.ts
// - newChatPaneProjectMapAtom (Record<number, SelectedProject>) — per-pane project for new-chat panes
// - newChatPaneWorkModeMapAtom (Record<number, WorkMode>) — per-pane work mode for new-chat panes
// - newChatPaneChatModeMapAtom (Record<number, ChatMode>) — per-pane chat mode for new-chat panes
// - newChatPaneModelMapAtom (Record<number, string>) — per-pane model id for new-chat panes
// - new-chat composer drafts: NOT remapped on purpose. NewChatForm is keyed by pane index so a swap
//   never remounts it and its text lives in the editor's DOM, not storage — swapping the stored
//   slots moves nothing visible and the still-mounted composer's next flush overwrites it. Moving
//   text needs the draft KEY to change (pane->slot indirection). See composer-draft-persistence.
// - editorActivePaneIndexAtom — derived mirror of activePaneIndex, auto-syncs via useEffect in agents-content.tsx, no remap needed
// - codeEditorActiveChatIdAtom — which chat receives code selection; derived from active pane/selected chat, synced in agents-content.tsx, no remap needed (keyed by chatId)
// - tagOpenFilesWithPaneContextAtom — uses projectPath, only on split activation, no remap needed
//

/**
 * Layout mode for split panes. Valid layouts depend on pane count:
 * - 2 panes: 'horizontal' (side-by-side) or 'vertical' (stacked)
 * - 3 panes: 'three-bottom' / 'three-right' (2×1 tile grid), or uniform 'horizontal' / 'vertical'
 * - 4 panes: 'grid' (2×2), 'horizontal' (four columns), or 'vertical' (four stacked rows)
 */
export type SplitLayout = 'horizontal' | 'vertical' | 'three-bottom' | 'three-right' | 'grid';

/** Sentinel value for a pane showing NewChatForm (not yet backed by a real chat ID).
 *  Distinct from `null` which means an unfilled empty placeholder. */
export const NEW_CHAT_PANE = '__new__' as const;

/** Whether a pane slot is fillable (empty placeholder or new-chat sentinel). */
export const isFillablePane = (id: string | null): boolean => id === null || id === NEW_CHAT_PANE;

/** Default grid row/column ratios (each axis sums to 1). Used for 3/4-pane resizable grid. */
export function getDefaultGridRatios(): { rows: number[]; cols: number[] } {
  return { rows: [0.5, 0.5], cols: [0.5, 0.5] };
}

/** Split view state: which top-level chats are shown in split layout */
export type SplitViewState = {
  chatIds: (string | null)[]; // ordered chat IDs in split (null = empty placeholder, NEW_CHAT_PANE = new chat form, empty array = no split)
  ratios: number[]; // per-pane size ratios summing to 1.0 (linear horizontal/vertical, including N-pane rows/columns)
  activePaneIndex: number; // which pane is "focused" and receives sidebar clicks
  layout: SplitLayout; // layout mode
  /** Row/column size ratios for 3/4-pane grid (each array length 2, sums to 1). Undefined → equal split. */
  gridRatios?: { rows: number[]; cols: number[] };
  /** Per-pane zoom factor (1 = 100%). Applied via CSS zoom (layout-aware scaling). Undefined → all 1. */
  paneZoomFactors?: number[];
};

/** Returns the valid layout options for a given pane count */
export function getValidLayouts(paneCount: number): SplitLayout[] {
  switch (paneCount) {
    case 2:
      return ['horizontal', 'vertical'];
    case 3:
      return ['three-bottom', 'three-right', 'horizontal', 'vertical'];
    case 4:
      return ['grid', 'horizontal', 'vertical'];
    default:
      return [];
  }
}

/** Returns the default layout for a given pane count */
export function getDefaultLayout(paneCount: number): SplitLayout {
  switch (paneCount) {
    case 2:
      return 'horizontal';
    case 3:
      return 'three-bottom';
    case 4:
      return 'grid';
    default:
      return 'horizontal';
  }
}

// ============================================================================
// Split View Ratio Helpers
// ============================================================================

/** Returns equal ratios for n panes (each 1/n) */
export function getDefaultRatios(n: number): number[] {
  if (n <= 0) return [];
  return Array(n).fill(1 / n) as number[];
}

/** Adds a new pane, scaling existing ratios down proportionally */
export function addPaneRatio(ratios: number[]): number[] {
  const n = ratios.length + 1;
  const scale = (n - 1) / n;
  return [...ratios.map((r) => r * scale), 1 / n];
}

/** Removes a pane at removeIdx, redistributing its width proportionally */
export function removePaneRatio(ratios: number[], removeIdx: number): number[] {
  if (removeIdx < 0 || removeIdx >= ratios.length) return getDefaultRatios(ratios.length);
  const removed = ratios[removeIdx] ?? 0;
  const rest = ratios.filter((_, i) => i !== removeIdx);
  if (rest.length === 0) return [];
  const sum = rest.reduce((a, b) => a + b, 0);
  if (sum === 0) return getDefaultRatios(rest.length);
  const result = rest.map((r) => r + (r / sum) * removed);
  // Normalize to prevent floating-point drift
  const total = result.reduce((a, b) => a + b, 0);
  return total > 0 ? result.map((r) => r / total) : getDefaultRatios(rest.length);
}

/**
 * Clamp split view read from storage so layout matches pane count (e.g. invalid enum for N panes → default).
 * Applied on read/write of `splitViewAtom`.
 */
function splitViewNumberArraysNearlyEqual(a: number[], b: number[], eps = 1e-5): boolean {
  return a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= eps);
}

/** True when two normalized states are visually/behaviorally the same (ignores object identity). */
function splitViewStatesSemanticallyEqual(a: SplitViewState, b: SplitViewState): boolean {
  if (
    a.activePaneIndex !== b.activePaneIndex ||
    a.layout !== b.layout ||
    a.chatIds.length !== b.chatIds.length ||
    !a.chatIds.every((id, i) => id === b.chatIds[i])
  ) {
    return false;
  }
  const n = a.chatIds.length;
  const ar = a.ratios.length === n ? a.ratios : getDefaultRatios(n);
  const br = b.ratios.length === n ? b.ratios : getDefaultRatios(n);
  if (!splitViewNumberArraysNearlyEqual(ar, br)) return false;

  const zoomOrOnes = (z: number[] | undefined) =>
    z && z.length === n ? z : Array.from({ length: n }, () => 1);
  if (
    !splitViewNumberArraysNearlyEqual(zoomOrOnes(a.paneZoomFactors), zoomOrOnes(b.paneZoomFactors))
  ) {
    return false;
  }

  const isGridLayout =
    a.layout === 'three-bottom' || a.layout === 'three-right' || a.layout === 'grid';
  if (isGridLayout) {
    const ag = a.gridRatios ?? getDefaultGridRatios();
    const bg = b.gridRatios ?? getDefaultGridRatios();
    if (
      !splitViewNumberArraysNearlyEqual(ag.rows, bg.rows) ||
      !splitViewNumberArraysNearlyEqual(ag.cols, bg.cols)
    ) {
      return false;
    }
  }
  return true;
}

export function normalizeSplitViewState(prev: SplitViewState): SplitViewState {
  const n = prev.chatIds.length;
  if (n === 0) {
    return { chatIds: [], ratios: [], activePaneIndex: 0, layout: prev.layout };
  }
  const validLayouts = getValidLayouts(n);
  let layout = prev.layout;
  if (!validLayouts.includes(layout)) {
    layout = getDefaultLayout(n);
  }
  let ratios = prev.ratios.length === n ? [...prev.ratios] : getDefaultRatios(n);
  const sum = ratios.reduce((a, b) => a + b, 0);
  if (sum <= 0 || Math.abs(sum - 1) > 1e-3) {
    ratios = getDefaultRatios(n);
  } else {
    ratios = ratios.map((r) => r / sum);
  }
  const activePaneIndex = Math.min(Math.max(0, prev.activePaneIndex), n - 1);
  const isGridLayout = layout === 'three-bottom' || layout === 'three-right' || layout === 'grid';
  let gridRatios = prev.gridRatios;
  if (isGridLayout && n >= 3) {
    const def = getDefaultGridRatios();
    if (gridRatios?.rows.length !== 2 || gridRatios.cols.length !== 2) {
      gridRatios = def;
    } else {
      const rs = (gridRatios.rows[0] ?? 0) + (gridRatios.rows[1] ?? 0);
      const cs = (gridRatios.cols[0] ?? 0) + (gridRatios.cols[1] ?? 0);
      if (Math.abs(rs - 1) > 1e-3 || Math.abs(cs - 1) > 1e-3) {
        gridRatios = def;
      }
    }
  }
  let paneZoomFactors = prev.paneZoomFactors;
  if (paneZoomFactors && paneZoomFactors.length !== n) {
    paneZoomFactors = undefined;
  }
  return {
    ...prev,
    layout,
    ratios,
    activePaneIndex,
    gridRatios: isGridLayout ? (gridRatios ?? getDefaultGridRatios()) : prev.gridRatios,
    paneZoomFactors,
  };
}

/** Next layout when cycling forward for this pane count (used by Quick Actions icon preview). */
export function getNextLayout(layout: SplitLayout, paneCount: number): SplitLayout {
  const valid = getValidLayouts(paneCount);
  if (valid.length <= 1) return layout;
  const i = valid.indexOf(layout);
  const idx = i === -1 ? 0 : (i + 1) % valid.length;
  return valid[idx] ?? layout;
}

/**
 * Accessible name / tooltip for the layout we switch to when cycling (destination layout).
 * Pane-count disambiguates e.g. three columns vs four columns.
 */
export function getLayoutCycleDescription(
  destinationLayout: SplitLayout,
  paneCount: number,
): string {
  if (paneCount === 4) {
    if (destinationLayout === 'horizontal') return 'Switch to four columns (side by side)';
    if (destinationLayout === 'vertical') return 'Switch to four stacked rows';
    if (destinationLayout === 'grid') return 'Switch to 2×2 grid';
  }
  if (paneCount === 3) {
    if (destinationLayout === 'three-bottom') return 'Switch to bottom panel (2×1 grid)';
    if (destinationLayout === 'three-right') return 'Switch to right panel (2×1 grid)';
    if (destinationLayout === 'horizontal') return 'Switch to three columns (side by side)';
    if (destinationLayout === 'vertical') return 'Switch to three stacked rows';
  }
  if (paneCount === 2) {
    if (destinationLayout === 'horizontal') return 'Switch to side-by-side';
    if (destinationLayout === 'vertical') return 'Switch to stacked';
  }
  switch (destinationLayout) {
    case 'horizontal':
      return 'Switch to side-by-side';
    case 'vertical':
      return 'Switch to stacked';
    case 'three-bottom':
      return 'Switch to bottom panel';
    case 'three-right':
      return 'Switch to right panel';
    case 'grid':
      return 'Switch to grid layout';
    default:
      return 'Cycle layout';
  }
}

const splitViewStorageAtom = atomWithWindowStorage<SplitViewState>(
  'agents:splitView:v5', // v5: added gridRatios for resizable 3/4-pane grid
  { chatIds: [], ratios: [], activePaneIndex: 0, layout: 'horizontal' },
  { getOnInit: true },
);

/** Persisted split view; reads/writes are normalized (layout vs pane count, ratio length). */
export const splitViewAtom = atom(
  (get) => normalizeSplitViewState(get(splitViewStorageAtom)),
  (get, set, update: SplitViewState | ((prev: SplitViewState) => SplitViewState)) => {
    set(splitViewStorageAtom, (prev) => {
      const current = normalizeSplitViewState(prev);
      const next = typeof update === 'function' ? update(current) : update;
      // Updater returned the same reference (e.g. cycleLayout no-op) — skip normalize + write.
      // Otherwise normalize() always allocates new ratios/object and would churn subscribers/FPS.
      if (next === current) {
        return prev;
      }
      const normalized = normalizeSplitViewState(next);
      if (splitViewStatesSemanticallyEqual(current, normalized)) {
        return prev;
      }
      return normalized;
    });
    // Per-pane file trees live for one split session; ending it here (even while Settings hides the
    // split view) lets the next split seed afresh.
    if (get(splitViewAtom).chatIds.length < 2) {
      set(splitPaneFileTreesAtom, UNSEEDED_SPLIT_PANE_FILE_TREES);
    }
  },
);

/** Derived atom that only updates when chatIds actually change (structural equality). */
export const splitViewChatIdsAtom = selectAtom(
  splitViewAtom,
  (sv) => sv.chatIds,
  (a, b) => a.length === b.length && a.every((id, i) => id === b[i]),
);

/** Derived atom for active pane index only. Use in memoized ChatView so it re-renders when focus changes. */
export const splitViewActivePaneIndexAtom = selectAtom(splitViewAtom, (sv) => sv.activePaneIndex);

/** Layout mode only — subscribers update on cycleLayout, not on ratio-only drags (when layout unchanged). */
export const splitViewLayoutAtom = selectAtom(splitViewAtom, (sv) => sv.layout);

function numberArraysEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Pane width/height ratios — updates on resize and layout cycle, not on unrelated split fields. */
export const splitViewRatiosAtom = selectAtom(splitViewAtom, (sv) => sv.ratios, numberArraysEqual);

/** Grid row/col weights for grid / three-* layouts. */
export const splitViewGridRatiosAtom = selectAtom(
  splitViewAtom,
  (sv) => sv.gridRatios ?? getDefaultGridRatios(),
  (a, b) => numberArraysEqual(a.rows, b.rows) && numberArraysEqual(a.cols, b.cols),
);

/** Per-pane zoom factors; undefined treated as stable “no custom zoom” for equality. */
export const splitViewPaneZoomFactorsAtom = selectAtom(
  splitViewAtom,
  (sv) => sv.paneZoomFactors,
  (a, b) => {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    return numberArraysEqual(a, b);
  },
);

/** True when linear/grid pane sizing differs from equal split (for QuickActions reset button). */
export function splitViewHasNonDefaultPaneSizing(sv: SplitViewState): boolean {
  const n = sv.chatIds.length;
  if (n < 2) return false;
  const isGridLayout =
    sv.layout === 'three-bottom' || sv.layout === 'three-right' || sv.layout === 'grid';
  if (isGridLayout) {
    const def = getDefaultGridRatios();
    const current = sv.gridRatios ?? def;
    return (
      !splitViewNumberArraysNearlyEqual(current.rows, def.rows) ||
      !splitViewNumberArraysNearlyEqual(current.cols, def.cols)
    );
  }
  const defaultRatios = getDefaultRatios(n);
  const currentRatios = sv.ratios.length === n ? sv.ratios : getDefaultRatios(n);
  return !splitViewNumberArraysNearlyEqual(currentRatios, defaultRatios);
}

export function splitViewHasNonDefaultPaneZoom(sv: SplitViewState): boolean {
  const z = sv.paneZoomFactors;
  return (z?.length ?? 0) > 0 && (z ?? []).some((factor) => factor !== 1);
}

/** QuickActions-only: layout + reset affordances; avoids waking full sidebar on unrelated split updates. */
export const splitViewQuickActionsChromeAtom = selectAtom(
  splitViewAtom,
  (sv) => ({
    layout: sv.layout,
    hasNonDefaultPaneSizes: splitViewHasNonDefaultPaneSizing(sv),
    hasNonDefaultPaneZoom: splitViewHasNonDefaultPaneZoom(sv),
  }),
  (a, b) =>
    a.layout === b.layout &&
    a.hasNonDefaultPaneSizes === b.hasNonDefaultPaneSizes &&
    a.hasNonDefaultPaneZoom === b.hasNonDefaultPaneZoom,
);

/**
 * Coordinating atom for pane swaps. Atomically remaps ALL pane-index-dependent state.
 * See the inventory comment above splitViewAtom for the full list of affected atoms.
 */
export const swapAllPaneStateAtom = atom(
  null,
  (get, set, { from, to }: { from: number; to: number }) => {
    // 1. Swap splitViewAtom (chatIds, ratios, activePaneIndex)
    const prev = get(splitViewAtom);
    if (
      from === to ||
      from < 0 ||
      to < 0 ||
      from >= prev.chatIds.length ||
      to >= prev.chatIds.length
    )
      return;

    const newChatIds = [...prev.chatIds];
    [newChatIds[from], newChatIds[to]] = [newChatIds[to], newChatIds[from]];

    const newRatios = [...prev.ratios];
    if (newRatios.length === prev.chatIds.length) {
      [newRatios[from], newRatios[to]] = [newRatios[to], newRatios[from]];
    }

    const newPaneZoomFactors =
      prev.paneZoomFactors && prev.paneZoomFactors.length === prev.chatIds.length
        ? [...prev.paneZoomFactors]
        : undefined;
    if (newPaneZoomFactors) {
      [newPaneZoomFactors[from], newPaneZoomFactors[to]] = [
        newPaneZoomFactors[to],
        newPaneZoomFactors[from],
      ];
    }

    let newActive = prev.activePaneIndex;
    if (newActive === from) newActive = to;
    else if (newActive === to) newActive = from;

    // Keep existing gridRatios on swap — only the content (which chat is in which slot) changes; sizes stay the same
    const nextGridRatios = prev.gridRatios;

    set(splitViewAtom, {
      ...prev,
      chatIds: newChatIds,
      ratios: newRatios,
      activePaneIndex: newActive,
      gridRatios: nextGridRatios,
      paneZoomFactors: newPaneZoomFactors,
    });

    // 2. Remap file tree open indices
    const trees = get(splitPaneFileTreesAtom);
    const newTrees = new Set<number>();
    for (const idx of trees) {
      if (idx === from) newTrees.add(to);
      else if (idx === to) newTrees.add(from);
      else newTrees.add(idx);
    }
    set(splitPaneFileTreesAtom, newTrees);

    // 3. Remap last active tab per pane
    const tabs = get(lastActiveTabPerPaneAtom);
    const newTabs = { ...tabs };
    const tmp = newTabs[from];
    newTabs[from] = newTabs[to];
    newTabs[to] = tmp;
    set(lastActiveTabPerPaneAtom, newTabs);

    // 4. Remap sourcePaneIndex on open files (undefined values are skipped naturally by === checks)
    const files = get(openFilesAtom);
    set(
      openFilesAtom,
      files.map((f) => {
        if (f.sourcePaneIndex === from) return { ...f, sourcePaneIndex: to };
        if (f.sourcePaneIndex === to) return { ...f, sourcePaneIndex: from };
        return f;
      }),
    );

    // 5. Swap per-pane project map entries for new-chat panes
    const paneProjects = get(newChatPaneProjectMapAtom);
    const nextPaneProjects = { ...paneProjects };
    const fromVal = nextPaneProjects[from];
    const toVal = nextPaneProjects[to];
    if (fromVal !== undefined) nextPaneProjects[to] = fromVal;
    else delete nextPaneProjects[to];
    if (toVal !== undefined) nextPaneProjects[from] = toVal;
    else delete nextPaneProjects[from];
    set(newChatPaneProjectMapAtom, nextPaneProjects);

    // 6. Swap per-pane work mode map entries for new-chat panes
    const paneWorkModes = get(newChatPaneWorkModeMapAtom);
    const nextPaneWorkModes = { ...paneWorkModes };
    const fromWorkMode = nextPaneWorkModes[from];
    const toWorkMode = nextPaneWorkModes[to];
    if (fromWorkMode !== undefined) nextPaneWorkModes[to] = fromWorkMode;
    else delete nextPaneWorkModes[to];
    if (toWorkMode !== undefined) nextPaneWorkModes[from] = toWorkMode;
    else delete nextPaneWorkModes[from];
    set(newChatPaneWorkModeMapAtom, nextPaneWorkModes);

    // 7. Swap per-pane chat mode map entries for new-chat panes
    const paneChatModes = get(newChatPaneChatModeMapAtom);
    const nextPaneChatModes = { ...paneChatModes };
    const fromChatMode = nextPaneChatModes[from];
    const toChatMode = nextPaneChatModes[to];
    if (fromChatMode !== undefined) nextPaneChatModes[to] = fromChatMode;
    else delete nextPaneChatModes[to];
    if (toChatMode !== undefined) nextPaneChatModes[from] = toChatMode;
    else delete nextPaneChatModes[from];
    set(newChatPaneChatModeMapAtom, nextPaneChatModes);

    // 8. Swap per-pane model map entries for new-chat panes
    const paneModels = get(newChatPaneModelMapAtom);
    const nextPaneModels = { ...paneModels };
    const fromModel = nextPaneModels[from];
    const toModel = nextPaneModels[to];
    if (fromModel !== undefined) nextPaneModels[to] = fromModel;
    else delete nextPaneModels[to];
    if (toModel !== undefined) nextPaneModels[from] = toModel;
    else delete nextPaneModels[from];
    set(newChatPaneModelMapAtom, nextPaneModels);
  },
);
