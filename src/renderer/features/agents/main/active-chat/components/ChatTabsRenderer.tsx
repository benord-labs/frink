import type { Chat } from '@ai-sdk/react';
import { Button } from '@benord-labs/frink-primitives';
import type { UIMessage } from 'ai';
import { useAtomValue } from 'jotai';
import { type ComponentType, memo, type ReactElement, useEffect, useMemo } from 'react';
import { perfMark } from '../../../../../lib/perf/marks';
import { heldSubChatsAtom } from '../../../../../lib/stores/active-transport-registry';
import { agentChatStore } from '../../../stores/agent-chat-store';
import type { SubChatMeta } from '../../../stores/sub-chat-store';
import type { UseSubChatMessagesResult } from '../hooks/useSubChatMessages';
import type { ChatViewInnerProps } from '../types';
import { getFirstSubChatId } from '../utils';

type Props = {
  /** The chat's one sub-chat, already checked to belong to `chatId` by the caller. */
  subChatId: string;
  agentSubChats: SubChatMeta[];
  allSubChats: SubChatMeta[];
  getOrCreateChat: (subChatId: string, isWakeHeld: boolean) => Chat<UIMessage> | null;
  /** Paginated messages for the active sub-chat (loadOlder, hasMore, isLoading). */
  subChatMessages: UseSubChatMessagesResult;
  chatId: string;
  selectedTeamId: string | null;
  repository?: string;
  isMobileFullscreen: boolean;
  sandboxId?: string | null;
  projectPath?: string | null;
  /** UUID for @briefing mentions — prefer local equivalent when set (matches flow rows + execution routing) */
  projectId?: string | null;
  /** Current git branch (from getBranches) for context bar under input */
  currentBranch?: string | null;
  /** Folder name for context bar (e.g. last segment of worktree path) */
  workspaceFolderName?: string | null;
  /** Whether this chat is running in an isolated git worktree */
  isWorktree?: boolean;
  isArchived: boolean;
  taskId?: string | null; // Link to work queue task
  splitPaneIndex?: number;
  /** True when this pane is focused (single view or active pane in split view). */
  isPaneActive?: boolean;
  /** After getResolvedAccount succeeds for this chat — gates execution sends in ChatViewInner. */
  isResolvedExecutionAccountReady: boolean;
  /** While getResolvedAccount is loading — avoids composer empty-state flash. */
  isLoadingResolvedAccount?: boolean;
  /** When getResolvedAccount errors — retry surface instead of no-account empty state. */
  isErrorResolvedAccount?: boolean;
  onRetryResolvedAccount?: () => void;
  /** When account exists but is not authenticated, surfaces the reconnect CTA in the composer area. */
  unauthAccount?: { label: string; type: 'claude-code' | 'codex' } | null;
  handleRestoreWorkspace: () => void;
  // biome-ignore lint/style/useNamingConvention: Renders as a component
  ChatViewInnerComponent: ComponentType<ChatViewInnerProps>;
};

/** Renders the chat's conversation, or a loading / retry state while its messages load. */
export const ChatTabsRenderer = memo(function ChatTabsRenderer({
  subChatId,
  agentSubChats,
  allSubChats,
  getOrCreateChat,
  subChatMessages,
  chatId,
  selectedTeamId,
  repository,
  isMobileFullscreen,
  sandboxId,
  projectPath,
  projectId,
  currentBranch,
  workspaceFolderName,
  isWorktree,
  isArchived,
  taskId,
  splitPaneIndex,
  isPaneActive = true,
  isResolvedExecutionAccountReady,
  isLoadingResolvedAccount = false,
  isErrorResolvedAccount = false,
  onRetryResolvedAccount,
  unauthAccount,
  handleRestoreWorkspace,
  ChatViewInnerComponent,
}: Props): ReactElement {
  // Every way a chat opens (sidebar, split fill, new chat, fork) mounts or re-keys this renderer.
  useEffect(() => {
    perfMark('chat:open', { chatId, pane: splitPaneIndex ?? 0 });
  }, [chatId, splitPaneIndex]);

  const subChatNameById = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const subChat of allSubChats) {
      map.set(subChat.id, subChat.name ?? null);
    }
    for (const subChat of agentSubChats) {
      map.set(subChat.id, subChat.name ?? null);
    }
    return map;
  }, [allSubChats, agentSubChats]);

  // Subscribed here, not read inside getOrCreateChat: the hold ending must re-run its page check.
  const isWakeHeld = useAtomValue(heldSubChatsAtom).has(subChatId);
  const chat = getOrCreateChat(subChatId, isWakeHeld);
  const subChatData = agentSubChats.find((sc) => sc.id === subChatId);

  if (!chat) {
    if (subChatMessages.isLoading) {
      return (
        <div className="relative flex-1 min-h-0">
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
            Loading messages…
          </div>
        </div>
      );
    }
    if (subChatMessages.error) {
      return (
        <div className="relative flex-1 min-h-0">
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground text-sm"
            role="alert"
            aria-live="assertive"
          >
            <span>Failed to load messages.</span>
            <Button
              variant="link"
              size="sm"
              onClick={() => subChatMessages.refetch()}
              className="h-auto p-0 text-primary hover:underline"
            >
              Retry
            </Button>
          </div>
        </div>
      );
    }
    return <div className="relative flex-1 min-h-0" />;
  }

  return (
    <div className="relative flex-1 min-h-0">
      {/* Own GPU layer and containment box; also the containing block for fixed-position overlays.
          Never `opacity` here: it makes this a backdrop root, so the composer's and pinned
          messages' backdrop blur stops seeing the transcript. */}
      <div
        className="absolute inset-0 flex flex-col"
        style={{
          transform: 'translateZ(0)',
          willChange: 'transform',
          contain: 'layout style paint',
        }}
      >
        <ChatViewInnerComponent
          chat={chat}
          subChatId={subChatId}
          initialSubChatName={subChatNameById.get(subChatId) ?? null}
          parentChatId={chatId}
          isFirstSubChat={getFirstSubChatId(agentSubChats) === subChatId}
          hasExistingSession={!!subChatData?.sessionId}
          teamId={selectedTeamId || undefined}
          repository={repository}
          streamId={agentChatStore.getStreamId(subChatId)}
          isMobile={isMobileFullscreen}
          sandboxId={sandboxId || undefined}
          projectPath={projectPath || undefined}
          projectId={projectId}
          currentBranch={currentBranch}
          workspaceFolderName={workspaceFolderName}
          isWorktree={isWorktree}
          isArchived={isArchived}
          onRestoreWorkspace={handleRestoreWorkspace}
          taskId={taskId}
          splitPaneIndex={splitPaneIndex}
          isPaneActive={isPaneActive}
          isResolvedExecutionAccountReady={isResolvedExecutionAccountReady}
          isLoadingResolvedAccount={isLoadingResolvedAccount}
          isErrorResolvedAccount={isErrorResolvedAccount}
          onRetryResolvedAccount={onRetryResolvedAccount}
          unauthAccount={unauthAccount}
          loadOlderMessages={subChatMessages.loadOlder}
          hasOlderMessages={subChatMessages.hasMore}
          isLoadingOlderMessages={subChatMessages.isLoadingOlder}
          loadOlderError={subChatMessages.loadOlderError}
        />
      </div>
    </div>
  );
});
