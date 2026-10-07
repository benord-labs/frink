import type { Chat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import type { ComponentType, ReactNode } from 'react';
import type { TextShimmerVariant } from '../../../../components/ui/text-shimmer';
import type { SubChatFileChange } from '../../atoms';
import type { UploadedFile, UploadedImage } from '../../hooks/use-agents-file-upload';
import type { SelectedTextContext } from '../../lib/queue-utils';
import type { AgentsMentionsEditorHandle } from '../../mentions';
import type { MessageTokenData } from '../../ui/agent-context-indicator';
import type { IsolatedChatToolRegistry } from '../../ui/agent-tool-registry';

/**
 * Props that active-chat passes unchanged through every isolated-chat layer, shared so the
 * message section and the message group cannot drift apart.
 *
 * UserBubbleComponent is deliberately absent: the group's variant also accepts
 * answeredQuestions, so each layer declares its own and compares it in its own memo comparator.
 */
export type IsolatedChatSharedProps = {
  subChatId: string;
  chatId: string;
  taskId: string | null;
  isMobile: boolean;
  sandboxSetupStatus: 'cloning' | 'ready' | 'error';
  stickyTopClass: string;
  sandboxSetupError?: string;
  onRetrySetup?: () => void;
  // Components passed from parent - must be stable references
  // biome-ignore lint/style/useNamingConvention: Renders as a component
  ToolCallComponent: ComponentType<{
    icon: ComponentType<{ className?: string }>;
    title: string;
    isPending: boolean;
    isError: boolean;
    titleShimmerVariant?: TextShimmerVariant;
  }>;
  // biome-ignore lint/style/useNamingConvention: Renders as a component
  MessageGroupWrapper: ComponentType<{ children: ReactNode; isLastGroup?: boolean }>;
  toolRegistry: IsolatedChatToolRegistry;
  showChatRetryControl: boolean;
  retryInFlight: boolean;
  onRetryChat: () => void;
  /** Continues a failed turn; null with no session to resume, so the row reads Retry. */
  onCarryOnChat: (() => void) | null;
  chatRetryTooltipText: string | null;
};

/**
 * Props for ChatViewInner component
 */
export type ChatViewInnerProps = {
  chat: Chat<UIMessage>;
  subChatId: string;
  /** Server-derived fallback title for this sub-chat (used when store is stale in split view). */
  initialSubChatName?: string | null;
  parentChatId: string;
  isFirstSubChat: boolean;
  hasExistingSession: boolean;
  refreshDiff?: () => void;
  teamId?: string;
  repository?: string;
  streamId?: string | null;
  isMobile?: boolean;
  sandboxSetupStatus?: 'cloning' | 'ready' | 'error';
  sandboxSetupError?: string;
  onRetrySetup?: () => void;
  sandboxId?: string;
  projectPath?: string;
  /** UUID of the project this chat is associated with (used for @briefing mentions) */
  projectId?: string | null;
  /** Current git branch when chat has a workspace (for subtle context bar under input) */
  currentBranch?: string | null;
  /** Folder name for display when chat has a workspace (e.g. "owners-web") */
  workspaceFolderName?: string | null;
  /** Whether this chat is running in an isolated git worktree */
  isWorktree?: boolean;
  isArchived?: boolean;
  onRestoreWorkspace?: () => void;
  isActive?: boolean;
  taskId?: string | null; // Link to work queue task (null for regular chats)
  /** When in split view, the 0-based index of this pane. undefined = not in split view. */
  splitPaneIndex?: number;
  /** True when this pane has focus (single view) or is the focused pane (split view). Used for pane-scoped shortcuts (e.g. Cmd+Down). */
  isPaneActive?: boolean;
  /** Load next page of older messages (paginated history). No-op when streaming. */
  loadOlderMessages?: () => Promise<void>;
  /** Whether there are older messages to load. */
  hasOlderMessages?: boolean;
  /** True while a "load older" request is in flight. */
  isLoadingOlderMessages?: boolean;
  /** Error from load older (if any). Show retry when set. */
  loadOlderError?: Error | null;
  /** True after `getResolvedAccount` succeeded for this chat (not loading, not error). Gates sends that depend on execution account type. */
  isResolvedExecutionAccountReady: boolean;
  /** True while `getResolvedAccount` is loading — suppresses NoAccountsEmptyState flash before first result. */
  isLoadingResolvedAccount?: boolean;
  /** True when `getResolvedAccount` failed — show retry instead of "no account" empty state. */
  isErrorResolvedAccount?: boolean;
  /** Refetch execution account after error (passed to composer retry control). */
  onRetryResolvedAccount?: () => void;
  /** When account exists but is not authenticated, surfaces the reconnect CTA. Null when no account is configured. */
  unauthAccount?: { label: string; type: 'claude-code' | 'codex' } | null;
};

/**
 * Props for ChatView component
 */
export type ChatViewProps = {
  chatId: string;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  selectedTeamName?: string;
  selectedTeamImageUrl?: string;
  isMobileFullscreen?: boolean;
  onBackToChats?: () => void;
  onOpenPreview?: () => void;
  onOpenDiff?: () => void;
  onOpenTerminal?: () => void;
  /** When in split view, the 0-based index of this pane. undefined = not in split view. */
  splitPaneIndex?: number;
};

/**
 * The composer contract ChatInputSection forwards verbatim to ChatInputArea.
 *
 * Only props identical in name, type AND optionality live here; where the two disagree on
 * optionality they stay declared locally, so neither component's contract changes.
 */
export type ComposerForwardedProps = {
  editorRef: React.RefObject<AgentsMentionsEditorHandle | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onSend: () => void;
  onForceSend: () => void;
  onStop: () => Promise<void>;
  onCompact: () => void;
  isStreaming: boolean;
  isCompacting: boolean;
  images: UploadedImage[];
  files: UploadedFile[];
  onAddAttachments: (files: File[]) => void;
  onRemoveImage: (id: string) => void;
  onRemoveFile: (id: string) => void;
  isUploading: boolean;
  textContexts: SelectedTextContext[];
  onRemoveTextContext: (id: string) => void;
  messageTokenData: MessageTokenData;
  subChatId: string;
  parentChatId: string;
  teamId?: string;
  repository?: string;
  sandboxId?: string;
  projectPath?: string;
  /** UUID of the project this chat is associated with (used for @briefing mentions) */
  projectId?: string | null;
  changedFiles: SubChatFileChange[];
  firstQueueItemId?: string;
};
