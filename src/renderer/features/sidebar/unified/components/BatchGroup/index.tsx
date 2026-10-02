/**
 * BatchGroup - Collapsible batch sub-folder within a codebase folder.
 *
 * Displays a batch flow run group header with progress badge and failed-run indicator.
 * When expanded, fetches all chats for this batch_id via chats.listByBatch.
 * DnD is disabled for batched chats (batch is flow-managed; manual reordering N/A).
 */

import { Button } from '@benord-labs/frink-primitives';
import { GripVertical, Layers, MoreHorizontal, Trash2 } from 'lucide-react';
import { memo, useState } from 'react';
import type { SidebarBatchGroup } from '../../../../../../shared/types/flows/sidebar-batch-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../../../components/ui/dropdown-menu';
import { trpc } from '../../../../../lib/trpc';
import { cn } from '../../../../../lib/utils';
import type { SidebarTaskStatus } from '../../constants';
import type { ChatItem } from '../../types';
import type { ChatReason, SidebarChatListItem } from '../../utils';
import { areChatRowMemoEqual } from '../../utils/chat-equality';
import { ChatListItem } from '../ChatListItem';
import { useChatRowSelection } from '../ChatSelection';
import { TreeItem } from '../TreeItem';

type BatchGroupProps = {
  summary: SidebarBatchGroup;
  /** Chats from the parent that already belong to this batch (may be incomplete — we refetch on expand) */
  localChats: ChatItem[];
  /** project id → registered project path; matches useGroupedProjects worktree detection */
  projectPathById?: Map<string, string>;
  selectedChatId: string | null;
  onChatSelect: (chatId: string) => void;
  onChatRename?: (chat: ChatItem) => void;
  onChatArchive?: (chatId: string) => void;
  onChatFork?: (chatId: string) => void;
  onChatDelete?: (chatId: string, chatName?: string | null) => void;
  onChatOpenInNewPane?: (chatId: string) => void;
  canOpenInNewPane?: boolean;
  onDeleteBatch?: (batchId: string, summary: SidebarBatchGroup) => void;
  chatPaneMap?: Map<string, number>;
  chatTaskStatusByChatId?: Map<string, SidebarTaskStatus>;
  chatReasonByChatId?: Map<string, ChatReason>;
  /** Chat ids with a live held question (see buildPendingQuestionChatIds) — server-fetched rows
   *  would otherwise lose the flag their local siblings carry via useGroupedProjects. */
  pendingQuestionIds?: Set<string>;
};

function formatBatchDate(isoString: string | null): string {
  if (!isoString) return '';
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Matches `DraggableChat` grip column; batch chats are not draggable (flow-managed). */
const BATCH_CHAT_GRIP_TRACK_CLASS =
  'ml-1 flex h-full items-center px-1 shrink-0 text-muted-foreground/30';

/** Same as `DraggableChat` → `ChatListItem` wrapper (`flex-1 min-w-0 -ml-1`). */
const BATCH_CHAT_LIST_WRAPPER_CLASS = 'flex-1 min-w-0 -ml-1';

function BatchGripSpacer() {
  return (
    <div aria-hidden data-sidebar-batch-grip="" className={BATCH_CHAT_GRIP_TRACK_CLASS}>
      <GripVertical className="invisible h-3.5 w-3.5" />
    </div>
  );
}

type BatchChatRowProps = {
  chat: ChatItem;
  isSelected: boolean;
  onChatSelect: (chatId: string) => void;
  onChatRename?: (chat: ChatItem) => void;
  onChatArchive?: (chatId: string) => void;
  onChatFork?: (chatId: string) => void;
  onChatDelete?: (chatId: string, chatName?: string | null) => void;
  onChatOpenInNewPane?: (chatId: string) => void;
  canOpenInNewPane?: boolean;
  splitPaneIndex?: number;
  taskStatus?: SidebarTaskStatus;
  reason?: ChatReason;
};

// Props compared by reference identity — any change busts the memo. The `reason` object and the chat
// itself need the field/structural checks below.
const BATCH_CHAT_ROW_REF_KEYS = [
  'isSelected',
  'splitPaneIndex',
  'taskStatus',
  'onChatSelect',
  'onChatRename',
  'onChatArchive',
  'onChatFork',
  'onChatDelete',
  'onChatOpenInNewPane',
  // Capability flips as panes fill/empty — must bust the memo so the disabled state re-renders.
  'canOpenInNewPane',
] as const satisfies readonly (keyof BatchChatRowProps)[];

function areBatchChatRowPropsEqual(
  prev: Readonly<BatchChatRowProps>,
  next: Readonly<BatchChatRowProps>,
): boolean {
  return areChatRowMemoEqual(prev, next, BATCH_CHAT_ROW_REF_KEYS);
}

const BatchChatRow = memo(function BatchChatRow({
  chat,
  isSelected,
  onChatSelect,
  onChatRename,
  onChatArchive,
  onChatFork,
  onChatDelete,
  onChatOpenInNewPane,
  canOpenInNewPane,
  splitPaneIndex,
  taskStatus,
  reason,
}: BatchChatRowProps) {
  const { isMultiSelected, onClick } = useChatRowSelection(chat.id, onChatSelect);

  return (
    <div className="relative flex items-center">
      <BatchGripSpacer />
      <div className={BATCH_CHAT_LIST_WRAPPER_CLASS}>
        <ChatListItem
          chat={chat}
          taskStatus={taskStatus}
          reason={reason}
          isSelected={isSelected}
          isMultiSelected={isMultiSelected}
          onClick={onClick}
          onRename={onChatRename}
          onArchive={onChatArchive}
          onFork={onChatFork}
          onDelete={onChatDelete}
          onOpenInNewPane={onChatOpenInNewPane}
          canOpenInNewPane={canOpenInNewPane}
          isPinned={!!chat.pinnedAt}
          splitPaneIndex={splitPaneIndex}
          depth={0}
        />
      </div>
    </div>
  );
}, areBatchChatRowPropsEqual);

function BatchEmptyOrLoading({ loading }: { loading: boolean }) {
  return (
    <div className="flex items-center py-1">
      <BatchGripSpacer />
      <div
        className={cn(
          BATCH_CHAT_LIST_WRAPPER_CLASS,
          'px-2 py-1 text-xs',
          loading ? 'text-muted-foreground/60' : 'italic text-muted-foreground/50',
        )}
      >
        {loading ? 'Loading…' : 'No chats in this batch'}
      </div>
    </div>
  );
}

function BatchListFetchError({
  onRetry,
  retryDisabled,
}: {
  onRetry: () => void;
  retryDisabled?: boolean;
}) {
  return (
    <div className="flex items-center py-1">
      <BatchGripSpacer />
      <div
        className={cn(
          BATCH_CHAT_LIST_WRAPPER_CLASS,
          'flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1 text-xs text-destructive',
        )}
      >
        <span>Couldn&apos;t load chats.</span>
        <Button
          variant="link"
          size="sm"
          disabled={retryDisabled}
          className="h-auto p-0 text-destructive underline underline-offset-2 hover:text-destructive/90 hover:no-underline"
          onClick={(e) => {
            e.stopPropagation();
            onRetry();
          }}
        >
          Retry
        </Button>
      </div>
    </div>
  );
}

type BatchChatItemContext = {
  batchId: string;
  projectPathById?: Map<string, string>;
  /** Live flags do not survive the server round-trip, so the parent supplies them per chat id. */
  pendingQuestionIds?: Set<string>;
};

/**
 * Server chat record → sidebar `ChatItem`. The fetched list carries persisted columns only, so the
 * live flags are filled from the parent: everything the server cannot know is false by default and
 * `hasPendingQuestion` comes from the held-question set.
 */
function toBatchChatItem(chat: SidebarChatListItem, context: BatchChatItemContext): ChatItem {
  const projectPath = chat.projectId ? context.projectPathById?.get(chat.projectId) : undefined;
  return {
    id: chat.id,
    name: chat.name,
    branch: chat.branch ?? null,
    updatedAt: chat.updatedAt ?? null,
    projectId: chat.projectId ?? null,
    hasUnseenChanges: false,
    isLoading: false,
    hasPendingPlan: false,
    hasPendingQuestion: context.pendingQuestionIds?.has(chat.id) ?? false,
    isWorktree: !!chat.worktreePath && chat.worktreePath !== projectPath,
    taskId: chat.taskId ?? null,
    batchId: context.batchId,
    pinnedAt: chat.pinnedAt ?? null,
  };
}

export const BatchGroup = memo(function BatchGroup({
  summary,
  localChats,
  projectPathById,
  selectedChatId,
  onChatSelect,
  onChatRename,
  onChatArchive,
  onChatFork,
  onChatDelete,
  onChatOpenInNewPane,
  canOpenInNewPane,
  onDeleteBatch,
  chatPaneMap,
  chatTaskStatusByChatId,
  chatReasonByChatId,
  pendingQuestionIds,
}: BatchGroupProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const {
    data: fetchedChats,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = trpc.chats.listByBatch.useQuery(
    { batchId: summary.batch_id },
    {
      enabled: isExpanded,
      staleTime: 30_000,
    },
  );

  const { completed_count, run_count, failed_count, running_count, flow_name, last_activity_at } =
    summary;

  const isActive = running_count > 0;
  const dateLabel = formatBatchDate(last_activity_at);

  const listFetchFailed = isExpanded && isError;

  // When expanded, prefer server-fetched chats (complete list) over local subset
  const displayChats: ChatItem[] =
    isExpanded && fetchedChats
      ? fetchedChats.map((chat) =>
          toBatchChatItem(chat, {
            batchId: summary.batch_id,
            projectPathById,
            pendingQuestionIds,
          }),
        )
      : localChats;

  return (
    <TreeItem
      label={
        <span className="flex min-w-0 items-center gap-1.5 pl-2.5">
          <Layers className="h-3 w-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />
          <span className="truncate text-sm font-medium">{flow_name}</span>
          {dateLabel && (
            <span className="text-[11px] text-muted-foreground/50 shrink-0">{dateLabel}</span>
          )}
        </span>
      }
      rightContent={
        <span className="flex items-center gap-1 shrink-0">
          {/* Failed count badge */}
          {failed_count > 0 && (
            <span
              className="inline-flex items-center px-1 rounded text-[10px] font-semibold bg-destructive/15 text-destructive"
              title={`${failed_count} failed runs`}
            >
              <span aria-hidden="true">{failed_count}✕</span>
              <span className="sr-only">{failed_count} failed runs</span>
            </span>
          )}
          {/* Progress badge: "28/35 runs" */}
          <span
            className={cn(
              'text-[10px] font-medium px-1 rounded',
              isActive ? 'bg-primary/15 text-[hsl(var(--primary))]' : 'text-muted-foreground/60',
            )}
            title={`${completed_count} of ${run_count} runs completed`}
          >
            <span aria-hidden="true">
              {completed_count}/{run_count}
            </span>
            <span className="sr-only">
              {completed_count} of {run_count} runs completed
            </span>
          </span>
          {/* Batch actions menu */}
          {onDeleteBatch && (
            <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    'rounded',
                    'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100',
                    'focus-visible:opacity-100',
                    isMenuOpen && 'opacity-100',
                  )}
                  aria-label="Batch actions"
                >
                  <MoreHorizontal className="h-3.5 w-3.5 shrink-0" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteBatch(summary.batch_id, summary);
                  }}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete batch
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </span>
      }
      isExpanded={isExpanded}
      onToggle={() => setIsExpanded((v) => !v)}
      depth={1}
      chevronInGripColumn
      className={cn('sidebar-batch-tree-header', 'py-1')}
    >
      <div className="relative">
        {/* Tree connector line — aligns with batch header chevron center */}
        <div
          className="absolute top-0 bottom-2 w-[1.5px] bg-border/60"
          style={{ left: '1rem' }}
          aria-hidden="true"
        />
        {listFetchFailed ? (
          <BatchListFetchError
            onRetry={() => {
              void refetch();
            }}
            retryDisabled={isFetching}
          />
        ) : displayChats.length === 0 ? (
          <BatchEmptyOrLoading loading={isLoading} />
        ) : (
          <fieldset aria-label={`${flow_name} batch chats`} className="contents">
            {displayChats.map((chat) => (
              <BatchChatRow
                key={chat.id}
                chat={chat}
                isSelected={selectedChatId === chat.id}
                onChatSelect={onChatSelect}
                onChatRename={onChatRename}
                onChatArchive={onChatArchive}
                onChatFork={onChatFork}
                onChatDelete={onChatDelete}
                onChatOpenInNewPane={onChatOpenInNewPane}
                canOpenInNewPane={canOpenInNewPane}
                splitPaneIndex={chatPaneMap?.get(chat.id)}
                taskStatus={chatTaskStatusByChatId?.get(chat.id)}
                reason={chatReasonByChatId?.get(chat.id)}
              />
            ))}
          </fieldset>
        )}
        <div className="mx-4 mt-1 mb-0.5 border-t border-border/30" aria-hidden="true" />
      </div>
    </TreeItem>
  );
});
