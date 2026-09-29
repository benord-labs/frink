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

/** Confirmation state for archive/delete flows that may strand running tasks. */
export type TaskAwareActionDialogState = {
  open: boolean;
  mode: 'single' | 'batch';
  operation: 'archive' | 'archive_batch' | 'delete' | 'delete_batch';
  chatIds: string[];
  taskIds: string[];
  totalChats: number;
};
