/**
 * Types for Unified Sidebar
 * Single-panel tree structure: Codebases → Chats
 */

export type SidebarProject = {
  id: string;
  name: string;
  path: string;
  gitRemote: string | null;
  gitOwner: string | null;
  gitRepo: string | null;
};

export type ChatItem = {
  id: string;
  name: string | null;
  branch: string | null;
  updatedAt: Date | null;
  pinnedAt: Date | null;
  projectId: string | null;
  hasUnseenChanges: boolean;
  isLoading: boolean;
  hasPendingPlan: boolean;
  hasPendingQuestion: boolean;
  /** True when the chat is running in an isolated git worktree */
  isWorktree: boolean;
  /** Non-null when this chat was created by an automated task (trigger-based) */
  taskId: string | null;
  /** Non-null when this chat belongs to a batch flow run */
  batchId: string | null;
};

/**
 * Grouped structure for sidebar display
 * Groups projects by git_remote (codebase); General Chats has no projects
 */
export type CodebaseGroup = {
  gitRemote: string | null;
  displayName: string; // repo name or folder name
  gitOwner: string | null;
  gitRepo: string | null;
  projects: SidebarProject[];
  chats: ChatItem[];
};

/**
 * Project-level (not chat) action handlers, prop-drilled ProjectsTree -> CodebaseItem.
 * onRenameProject is the project sibling of onChatRename (both open the shared RenameDialog).
 */
export type ProjectActionHandlers = {
  onProjectDelete?: (projectId: string) => void;
  onRenameProject?: (projectId: string, currentName: string) => void;
  onDeleteAllChatsInFolder?: (folderKey: string) => void;
};

export type UnifiedSidebarProps = {
  onToggleSidebar?: () => void;
  isMobileFullscreen?: boolean;
  onChatSelect?: () => void;
};

/** One folder bucket the sidebar paginates chats within. */
export type FolderDescriptor = {
  key: string;
  projectIds: string[] | null;
};

/** Confirmation state for deletes that also stop a linked running task. Archive never asks. */
export type TaskAwareActionDialogState = {
  open: boolean;
  mode: 'single' | 'batch';
  operation: 'delete' | 'delete_batch';
  chatIds: string[];
  taskIds: string[];
  totalChats: number;
};

/** Handle exposed by UnifiedSidebar to the layout. */
export type UnifiedSidebarHandle = {
  /** Focus the tree container for keyboard navigation */
  focus: () => void;
  /** Restore focus to the Work Queue destination trigger after dismissal. */
  focusWorkQueueTrigger: () => void;
  /** Archive the focused chat (the archive shortcut). Stops everything under it, without a dialog. */
  archiveFocusedChat: () => void;
};
