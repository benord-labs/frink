/* eslint-disable max-lines, max-lines-per-function */
/**
 * ChatListItem - Individual chat/workspace item
 * Shows hover actions for rename/archive/delete
 */

import { Button } from '@benord-labs/frink-primitives';
import {
  Archive,
  Check,
  Columns2,
  GitFork,
  MapIcon,
  ListTodo,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  Trash2,
} from 'lucide-react';
import { type MouseEvent, useState } from 'react';
import { CompactPaneDigitBadge } from '@/features/agents/ui/split-view-container/pane-number-badge';
import { useMarkTaskComplete } from '@/hooks/use-mark-task-complete';
import { getPaneColor } from '@/lib/pane-colors';
import { formatShortTimeAgo } from '@/lib/utils/format-time';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../../components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../components/ui/tooltip';
import { cn } from '../../../../lib/utils';
import { SIDEBAR_ROW_ACTIVE_CLASS } from '../../components/SidebarNavRow';
import {
  CHAT_STATE_PRESENTATION,
  getChatActiveState,
  isChatRunning,
  SIDEBAR_TASK_PRESENTATION,
  type SidebarTaskStatus,
  TIMING,
} from '../constants';
import type { ChatItem } from '../types';
import type { ChatReason } from '../utils';

/**
 * Everything a chat row's wrapper forwards down verbatim. Shared so the draggable wrapper and the
 * row itself cannot describe the same handlers differently.
 */
export type ChatRowActions = {
  onRename?: (chat: ChatItem) => void;
  onArchive?: (chatId: string) => void;
  onFork?: (chatId: string) => void;
  onDelete?: (chatId: string) => void;
  onPin?: (chatId: string) => void;
  /** Opens this chat in a new split pane. Omitted where the action shouldn't appear. */
  onOpenInNewPane?: (chatId: string) => void;
  /** Whether a new pane can still be opened (false = panes full → the action is shown disabled). */
  canOpenInNewPane?: boolean;
  /** 1-indexed pane number if this chat is displayed in a split pane (undefined = not in split) */
  splitPaneIndex?: number;
  taskStatus?: SidebarTaskStatus;
  /** The agent park reason for the winning task — shown in the status pill tooltip when present. */
  reason?: ChatReason;
};

type ChatListItemProps = ChatRowActions & {
  chat: ChatItem;
  isSelected: boolean;
  /** Part of a Cmd/Shift-click multi-selection. */
  isMultiSelected?: boolean;
  onClick: (event: MouseEvent<HTMLElement>) => void;
  isPinned?: boolean;
  depth?: number;
};

export function ChatListItem({
  chat,
  isSelected,
  isMultiSelected,
  onClick,
  onRename,
  onArchive,
  onFork,
  onDelete,
  onPin,
  onOpenInNewPane,
  canOpenInNewPane,
  splitPaneIndex,
  taskStatus,
  reason,
  isPinned,
  depth = 2,
}: ChatListItemProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const markTaskComplete = useMarkTaskComplete();
  const isGeneratingName = !chat.name;
  const displayName = chat.name || 'Generating title…';
  const hasActions = onRename || onArchive || onFork || onDelete || onPin || onOpenInNewPane;
  const taskPresentation = taskStatus ? SIDEBAR_TASK_PRESENTATION[taskStatus] : null;
  // A flow chat is task-driven the moment its task is linked. `taskStatus` (from the polled tasks
  // query) surfaces that ~5s before the un-polled chats query refreshes `chat.taskId`, so OR them:
  // taskStatus is only ever set for DB-linked task chats, and chat.taskId keeps it correct durably
  // once the task leaves the tracked set / across reloads.
  const isTask = Boolean(chat.taskId) || Boolean(taskStatus);

  // Derive active state for icon coloring + status pill
  const chatState = getChatActiveState(chat);
  const chatStatePresentation = chatState ? CHAT_STATE_PRESENTATION[chatState] : null;
  const isPlanAwaitingApproval =
    taskStatus === 'plan_ready' || (!taskStatus && chatState === 'pendingPlan');

  // A live held question outranks an ACTIVE task status: during the hold window the task truthfully
  // stays `running` in the DB (nothing persists until the park — see
  // docs/decisions/agent-user-question-mechanism.md), so the amber "Waiting" state is the only
  // signal the agent needs the user. Terminal/parked statuses keep winning, which lets a stale
  // in-memory question entry self-heal once the durable status lands.
  const isWaitingOnQuestion =
    chatState === 'pendingQuestion' && (taskStatus === 'running' || taskStatus === 'pending');
  const effectiveTaskPresentation = isWaitingOnQuestion ? null : taskPresentation;

  // Live running signal, independent of the right pill: a follow-up message re-runs the left icons
  // even while the task pill rests on a terminal status like "Review" (done).
  const isRunning = isChatRunning(chatState, taskStatus);

  // Icon color reflects agent state, not row selection: an approval-ready Plan is static and wins
  // over running; otherwise live running pulses primary, followed by task/chat status.
  const iconClassName = isPlanAwaitingApproval
    ? CHAT_STATE_PRESENTATION.pendingPlan.iconClassName
    : isRunning
      ? SIDEBAR_TASK_PRESENTATION.running.iconClassName
      : (effectiveTaskPresentation?.iconClassName ??
        chatStatePresentation?.iconClassName ??
        (isTask ? 'text-muted-foreground/90' : ''));

  // The Plan icon is the complete approval affordance, so it intentionally has no duplicate pill.
  const statusPill = isPlanAwaitingApproval
    ? null
    : effectiveTaskPresentation
      ? {
          label: effectiveTaskPresentation.shortLabel,
          tooltip: effectiveTaskPresentation.label,
          ariaLabel: effectiveTaskPresentation.ariaLabel,
          text: effectiveTaskPresentation.textClassName,
          dot: effectiveTaskPresentation.dotClassName,
        }
      : chatStatePresentation?.showPill
        ? {
            label: chatStatePresentation.label,
            tooltip: chatStatePresentation.ariaLabel,
            ariaLabel: chatStatePresentation.ariaLabel,
            text: chatStatePresentation.textClassName,
            dot: chatStatePresentation.dotClassName,
          }
        : null;

  // Corner dot follows the live running signal — shows even when the right pill rests on a terminal
  // status (e.g. a "Review"/done task that got a follow-up message).
  const showIconActivityDot = isRunning && !isPlanAwaitingApproval;
  const iconActivityDotAriaLabel =
    taskStatus === 'running'
      ? SIDEBAR_TASK_PRESENTATION.running.ariaLabel
      : CHAT_STATE_PRESENTATION.loading.ariaLabel;

  // Get pane color tokens for sidebar tinting (0-indexed internally)
  const paneColor = splitPaneIndex !== undefined ? getPaneColor(splitPaneIndex - 1) : undefined;

  return (
    <div
      id={`sidebar-item-${chat.id}`}
      role="treeitem"
      tabIndex={-1}
      data-sidebar-item=""
      data-item-type="chat"
      data-item-id={chat.id}
      className={cn(
        'group w-full flex items-center gap-1 rounded-md outline-hidden min-w-0',
        'transition-colors duration-100 ease-out',
        // Split pane tinted background takes priority over default selection
        isMultiSelected
          ? 'bg-primary/10 text-foreground ring-1 ring-inset ring-primary/40'
          : paneColor
            ? cn(paneColor.sidebarBg, 'text-foreground')
            : isSelected
              ? SIDEBAR_ROW_ACTIVE_CLASS
              : isPinned
                ? 'text-foreground/90 bg-primary/5 hover:bg-primary/10'
                : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5',
      )}
      style={depth > 0 ? { paddingLeft: `${12 + depth * 12 + 16}px` } : undefined}
    >
      <Button
        variant="ghost"
        size="sm"
        onClick={onClick}
        className={cn(
          'flex-1 justify-start gap-2 py-1 px-2 min-w-0 bg-transparent hover:bg-transparent text-inherit',
        )}
      >
        {/* Chat icon + optional activity dot + optional worktree indicator */}
        <span className="shrink-0 flex items-center gap-1">
          <span className="relative">
            {isPlanAwaitingApproval ? (
              <Tooltip delayDuration={TIMING.TOOLTIP_DELAY_MS}>
                <TooltipTrigger asChild>
                  <span
                    className="inline-flex"
                    role="status"
                    aria-label={CHAT_STATE_PRESENTATION.pendingPlan.ariaLabel}
                  >
                    <MapIcon className={cn('h-3.5 w-3.5', iconClassName)} />
                    <span className="sr-only">{CHAT_STATE_PRESENTATION.pendingPlan.ariaLabel}</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" className="text-xs">
                  {CHAT_STATE_PRESENTATION.pendingPlan.ariaLabel}
                </TooltipContent>
              </Tooltip>
            ) : isTask ? (
              <>
                <ListTodo className={cn('h-3.5 w-3.5', iconClassName)} aria-hidden="true" />
                <span className="sr-only">(automated task)</span>
              </>
            ) : (
              <MessageSquare className={cn('h-3.5 w-3.5', iconClassName)} aria-hidden="true" />
            )}
            {showIconActivityDot && (
              <span
                className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-[hsl(var(--primary))] ring-2 ring-background motion-safe:animate-pulse"
                role="status"
                aria-label={iconActivityDotAriaLabel}
              />
            )}
          </span>
          {chat.isWorktree && (
            <>
              <GitFork
                className={cn('h-2.5 w-2.5 shrink-0', iconClassName || 'text-muted-foreground')}
                aria-hidden="true"
              />
              <span className="sr-only">(worktree)</span>
            </>
          )}
        </span>

        {/* Chat name */}
        <Tooltip delayDuration={TIMING.TOOLTIP_DELAY_MS}>
          <TooltipTrigger asChild>
            <span
              className={cn(
                'flex-1 truncate text-left text-sm',
                isGeneratingName && 'italic text-muted-foreground/80 motion-safe:animate-pulse',
              )}
            >
              {displayName}
            </span>
          </TooltipTrigger>
          <TooltipContent side="right" className="text-xs max-w-72 break-all">
            {displayName}
          </TooltipContent>
        </Tooltip>

        {/* Relative time — hidden at rest, revealed on hover/focus (the ladder's "power on engage"). */}
        {chat.updatedAt && (
          <span className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground group-hover:inline group-focus-within:inline">
            {formatShortTimeAgo(chat.updatedAt)}
          </span>
        )}

        {statusPill && (
          <Tooltip delayDuration={TIMING.TOOLTIP_DELAY_MS}>
            <TooltipTrigger asChild>
              {/* Friendly ladder: a bare colored dot at rest (a calm, learnable signal); the word-label
                  reveals on hover/focus or when the row is selected, restoring the full pill for a pro.
                  While running, the corner activity dot is the single live region — the pill drops its
                  `status` role so a re-running "done"/Review chat doesn't announce two contradictory
                  live states ("Agent is running" vs "Ready for review") at once. */}
              <span
                className="shrink-0 inline-flex items-center gap-1 leading-tight"
                role={isRunning ? undefined : 'status'}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', statusPill.dot)} />
                <span
                  className={cn(
                    'text-[10px] font-medium tabular-nums',
                    statusPill.text,
                    isSelected ? 'inline' : 'hidden group-hover:inline group-focus-within:inline',
                  )}
                >
                  {statusPill.label}
                </span>
                <span className="sr-only">{statusPill.ariaLabel}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-72 text-xs">
              {/* Concise hint only: the agent's `summary`, clamped. The full `details` dump lives in
                  the chat itself — rendering it here produced a wall-of-text tooltip. */}
              <span className="line-clamp-3">{reason?.summary?.trim() || statusPill.tooltip}</span>
            </TooltipContent>
          </Tooltip>
        )}
      </Button>

      {splitPaneIndex !== undefined && paneColor && (
        <CompactPaneDigitBadge paneIndex={splitPaneIndex - 1} paneNumber={splitPaneIndex} />
      )}

      {/* Actions menu - visible on hover or when open */}
      {hasActions && (
        <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => e.stopPropagation()}
              aria-label="Chat actions"
              className={cn(
                'shrink-0 p-1 mr-1 rounded',
                'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100',
                isMenuOpen && 'opacity-100',
              )}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            {/* Hidden when this chat is already shown — in a split pane (splitPaneIndex set) or as
                the single-view selection (isSelected, the implicit pane-0 occupant) — since opening
                it again is a no-op. Shown disabled when all panes are full so the limit reads as
                feedback, not a dead/absent affordance. */}
            {onOpenInNewPane && splitPaneIndex === undefined && !isSelected && (
              <>
                <DropdownMenuItem
                  onClick={() => onOpenInNewPane(chat.id)}
                  disabled={!canOpenInNewPane}
                  // When disabled, name the reason — a greyed item alone tells SR/keyboard users
                  // the state but not why (all 4 panes in use).
                  aria-label={canOpenInNewPane ? undefined : 'Open in New Pane (all panes in use)'}
                >
                  <Columns2 className="h-4 w-4 mr-2" />
                  Open in New Pane
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {taskStatus === 'done' && chat.taskId && (
              <>
                <DropdownMenuItem
                  onClick={() => markTaskComplete(chat.taskId as string)}
                  className="text-[hsl(var(--status-online-text))] focus:text-[hsl(var(--status-online-text))]"
                >
                  <Check className="h-4 w-4 mr-2" />
                  Mark complete
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {onPin && (
              <>
                <DropdownMenuItem onClick={() => onPin(chat.id)}>
                  <Pin className="h-4 w-4 mr-2" />
                  {isPinned ? 'Unpin chat' : 'Pin chat'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {onRename && (
              <DropdownMenuItem onClick={() => onRename(chat)}>
                <Pencil className="h-4 w-4 mr-2" />
                Rename
              </DropdownMenuItem>
            )}
            {(onArchive || onDelete) && onRename && <DropdownMenuSeparator />}
            {onArchive && (
              <DropdownMenuItem onClick={() => onArchive(chat.id)}>
                <Archive className="h-4 w-4 mr-2" />
                Archive chat
              </DropdownMenuItem>
            )}
            {onFork && (
              <DropdownMenuItem onClick={() => onFork(chat.id)}>
                <GitFork className="h-4 w-4 mr-2" />
                Fork chat
              </DropdownMenuItem>
            )}
            {onDelete && (
              <DropdownMenuItem
                onClick={() => onDelete(chat.id)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete chat permanently
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
