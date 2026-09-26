/**
 * SidebarNav - the sidebar's top navigation: a vertical list of borderless, labeled rows.
 * One list, two clusters — Actions (New Chat, New Folder, Split view) then flag-gated
 * Destinations (Flows, Work Queue) — separated by a divider only when destinations are present.
 * Split-view *tuning* controls (cycle layout / reset sizes / reset zoom) live in SplitViewControls
 * and render contextually beneath this nav, so the default view stays clean.
 *
 * Presentational: split-view state arrives via props (the owning UnifiedSidebar reads the atoms),
 * so this stays free of cross-feature atom imports.
 */

import { Badge } from '@benord-labs/frink-primitives';
import {
  Blocks,
  ChevronDown,
  Columns2,
  FolderPlus,
  ListTodo,
  MessageSquare,
  Plus,
  RefreshCw,
  SquarePlus,
  Workflow,
} from 'lucide-react';
import { memo, type ReactElement, type RefObject } from 'react';
import { LAUNCH_FLAGS } from '../../../../../../shared/launch-flags';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../../../components/ui/dropdown-menu';
import { Kbd } from '../../../../../components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../../components/ui/tooltip';
import { SidebarNavList } from '../../../components/SidebarNavList';
import { SidebarNavRow } from '../../../components/SidebarNavRow';
import { STRINGS, TIMING } from '../../constants';
import { SplitViewControls } from '../QuickActions';
import { getPaneReplaceMenuItemKey } from '../QuickActions/get-pane-replace-menu-item-key';

/* ── Work Queue status indicator ───────────────────────────────────── */
type WorkQueueCounts = {
  inboxTaskCount: number;
  pendingReviewCount: number;
  runningTaskCount: number;
  needsAttentionTaskCount: number;
  failedTaskCount: number;
  activeTasksHasMore: boolean;
};

function workQueueAriaLabel(c: WorkQueueCounts): string {
  const more = c.activeTasksHasMore ? ' - More tracked tasks available' : '';
  return `Work Queue. Inbox ${c.inboxTaskCount} - Needs attention ${c.needsAttentionTaskCount} - Failed ${c.failedTaskCount} - Review ${c.pendingReviewCount} - Running ${c.runningTaskCount}${more}. Click to open.`;
}

function destinationAriaCurrent(isActive: boolean): 'page' | undefined {
  return isActive ? 'page' : undefined;
}

type WorkQueueNotification = {
  count: number;
  level: 'error' | 'review' | 'warning';
};

function getWorkQueueNotification(c: WorkQueueCounts): WorkQueueNotification | null {
  const count =
    c.inboxTaskCount + c.pendingReviewCount + c.needsAttentionTaskCount + c.failedTaskCount;
  if (count === 0) return null;
  if (c.failedTaskCount > 0) return { count, level: 'error' };
  if (c.needsAttentionTaskCount > 0 || c.inboxTaskCount > 0) {
    return { count, level: 'warning' };
  }
  return { count, level: 'review' };
}

/** Actionable total, coloured by its highest-priority state. Running work is activity, not a notice. */
function workQueueIndicator(c: WorkQueueCounts): ReactElement | null {
  const notification = getWorkQueueNotification(c);
  if (!notification) return null;
  const variant = notification.level === 'review' ? 'default' : notification.level;
  const toneClassName =
    notification.level === 'error'
      ? 'bg-danger/10'
      : notification.level === 'warning'
        ? 'bg-warning/10'
        : 'bg-primary/15 text-primary';

  return (
    <Badge
      shape="count"
      variant={variant}
      aria-hidden
      data-testid="work-queue-notification"
      data-level={notification.level}
      className={toneClassName}
    >
      {notification.count}
    </Badge>
  );
}

/* ── New Chat row (plain action, or split dropdown when a split is active) ── */
type NewChatNavRowProps = {
  onNewChat: () => void;
  onViewChats: () => boolean;
  /** Row to restore focus to after returning to chats — the destination the user came from. */
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
  onAddNewChatPane?: () => void;
  onReplacePaneAt?: (index: number) => void;
  /** Chat id per pane (null = empty) — for stable replace-pane keys. */
  paneChatIds: (string | null)[];
  paneLabels: string[];
  activePaneIndex: number;
  isSplitActive: boolean;
  /** A destination standing in front of chat is showing, so this row returns instead of creating. */
  isTransientDestinationActive: boolean;
  canAddSplitPane: boolean;
  hasEmptyPane: boolean;
};

function NewChatNavRow({
  onNewChat,
  onViewChats,
  returnFocusRef,
  onAddNewChatPane,
  onReplacePaneAt,
  paneChatIds,
  paneLabels,
  activePaneIndex,
  isSplitActive,
  isTransientDestinationActive,
  canAddSplitPane,
  hasEmptyPane,
}: NewChatNavRowProps): ReactElement {
  const handleViewChats = () => {
    if (!onViewChats()) return;
    requestAnimationFrame(() => returnFocusRef?.current?.focus());
  };

  if (isTransientDestinationActive) {
    return (
      <Tooltip delayDuration={TIMING.TOOLTIP_DELAY_MS}>
        <TooltipTrigger asChild>
          <SidebarNavRow
            icon={<MessageSquare />}
            label="View chats"
            emphasized
            aria-label="View chats"
            onClick={handleViewChats}
          />
        </TooltipTrigger>
        <TooltipContent side="right">Return to chats</TooltipContent>
      </Tooltip>
    );
  }

  if (!isSplitActive) {
    return (
      <Tooltip delayDuration={TIMING.TOOLTIP_DELAY_MS}>
        <TooltipTrigger asChild>
          <SidebarNavRow
            icon={<Plus />}
            label={STRINGS.NEW_CHAT}
            emphasized
            aria-label={STRINGS.NEW_CHAT}
            onClick={onNewChat}
          />
        </TooltipTrigger>
        <TooltipContent side="right">
          Start a new chat <Kbd shortcutId="new-workspace" />
        </TooltipContent>
      </Tooltip>
    );
  }

  // Split active: the row opens a menu — the trailing chevron + tooltip signal that it isn't a
  // direct "new chat" action.
  return (
    <DropdownMenu>
      <Tooltip delayDuration={TIMING.TOOLTIP_DELAY_MS}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <SidebarNavRow
              icon={<Plus />}
              label={STRINGS.NEW_CHAT}
              emphasized
              aria-label="New chat options"
              trailing={<ChevronDown className="text-muted-foreground/70" />}
            />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">
          New chat options <Kbd shortcutId="new-workspace" />
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="bottom" align="start" className="min-w-[200px] max-w-[280px]">
        <DropdownMenuItem disabled={!canAddSplitPane} onSelect={() => onAddNewChatPane?.()}>
          <Plus className="mr-2 h-3.5 w-3.5" />
          <span className="flex-1">{STRINGS.NEW_PANE}</span>
          {!canAddSplitPane && (
            <span className="ml-2 shrink-0 text-[10px] text-muted-foreground/60">
              {hasEmptyPane ? 'Fill empty pane first' : 'Max panes reached'}
            </span>
          )}
        </DropdownMenuItem>
        {paneLabels.length > 0 && <DropdownMenuSeparator />}
        {paneLabels.map((label, index) => {
          const isActive = index === activePaneIndex;
          const key = getPaneReplaceMenuItemKey(paneChatIds[index], index);
          const item = (
            <DropdownMenuItem
              key={key}
              onSelect={() => onReplacePaneAt?.(index)}
              className="overflow-hidden"
            >
              <RefreshCw className="mr-2 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">
                Replace Pane {index + 1}
                {label ? ` — ${label}` : ''}
              </span>
              {isActive && (
                <span className="ml-auto shrink-0 pl-2 text-[10px] text-muted-foreground">
                  active
                </span>
              )}
            </DropdownMenuItem>
          );
          return isActive ? (
            <Tooltip key={key}>
              <TooltipTrigger asChild>{item}</TooltipTrigger>
              <TooltipContent side="right" className="max-w-none">
                <div className="flex flex-col gap-0.5">
                  <span>Currently focused pane</span>
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    Press <Kbd shortcutId="new-workspace" /> to start a new chat here
                  </span>
                </div>
              </TooltipContent>
            </Tooltip>
          ) : (
            item
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ── Nav ───────────────────────────────────────────────────────────── */
type SidebarNavProps = {
  onNewChat: () => void;
  onViewChats: () => boolean;
  onNewFolder: () => void;
  /** Add a split pane / start a split (the "Split view" action row). */
  onAddSplitPane?: () => void;
  /** Add a new-chat pane (split dropdown item). */
  onAddNewChatPane?: () => void;
  onReplacePaneAt?: (index: number) => void;
  paneChatIds?: (string | null)[];
  paneLabels?: string[];
  activePaneIndex?: number;
  isSplitActive?: boolean;
  canAddSplitPane?: boolean;
  hasEmptyPane?: boolean;
  /** Split-view tuning, shown inline on the Add Pane row only when each control can act. */
  onCycleLayout?: () => void;
  onResetPaneSizes?: () => void;
  onResetPaneZoom?: () => void;
  onFlows: () => void;
  onPlugins: () => void;
  onShowWorkQueue: () => void;
  workQueueTriggerRef?: RefObject<HTMLButtonElement | null>;
  flowsTriggerRef?: RefObject<HTMLButtonElement | null>;
  isWorkQueueActive?: boolean;
  /** The Flows dashboard is showing. The flow editor is a takeover and never sets this. */
  isFlowsActive?: boolean;
  inboxTaskCount: number;
  pendingReviewCount: number;
  runningTaskCount: number;
  needsAttentionTaskCount?: number;
  failedTaskCount?: number;
  activeTasksHasMore?: boolean;
};

type DestinationNavRowsProps = {
  showFlows: boolean;
  showWorkQueue: boolean;
  onFlows: () => void;
  onShowWorkQueue: () => void;
  onPlugins: () => void;
  flowsTriggerRef?: RefObject<HTMLButtonElement | null>;
  workQueueTriggerRef?: RefObject<HTMLButtonElement | null>;
  isFlowsActive: boolean;
  isWorkQueueActive: boolean;
  counts: WorkQueueCounts;
};

/** The destination cluster: Flows and Work Queue are flag-gated, Plugins never is, so the divider is unconditional. */
function DestinationNavRows({
  showFlows,
  showWorkQueue,
  onFlows,
  onShowWorkQueue,
  onPlugins,
  flowsTriggerRef,
  workQueueTriggerRef,
  isFlowsActive,
  isWorkQueueActive,
  counts,
}: DestinationNavRowsProps): ReactElement {
  return (
    <>
      <hr className="mx-1 my-1.5 border-t border-border/60" />

      {showFlows && (
        <Tooltip delayDuration={TIMING.TOOLTIP_DELAY_MS}>
          <TooltipTrigger asChild>
            <SidebarNavRow
              ref={flowsTriggerRef}
              icon={<Workflow />}
              label="Flows"
              onClick={onFlows}
              active={isFlowsActive}
              aria-current={destinationAriaCurrent(isFlowsActive)}
              aria-label="Flows"
            />
          </TooltipTrigger>
          <TooltipContent side="right">Flows</TooltipContent>
        </Tooltip>
      )}

      {showWorkQueue && (
        <Tooltip delayDuration={TIMING.TOOLTIP_DELAY_MS}>
          <TooltipTrigger asChild>
            <SidebarNavRow
              ref={workQueueTriggerRef}
              icon={<ListTodo />}
              label="Work Queue"
              trailing={workQueueIndicator(counts)}
              onClick={onShowWorkQueue}
              active={isWorkQueueActive}
              aria-current={destinationAriaCurrent(isWorkQueueActive)}
              aria-label={workQueueAriaLabel(counts)}
            />
          </TooltipTrigger>
          <TooltipContent>
            <div className="text-xs">
              <div>Work Queue</div>
              <div className="text-muted-foreground">{workQueueAriaLabel(counts)}</div>
            </div>
          </TooltipContent>
        </Tooltip>
      )}

      {/* Plugins lives as a Settings tab rather than its own destination, so this
          opens Settings on that tab instead of taking over the pane. */}
      <Tooltip delayDuration={TIMING.TOOLTIP_DELAY_MS}>
        <TooltipTrigger asChild>
          <SidebarNavRow
            icon={<Blocks />}
            label="Plugins"
            onClick={onPlugins}
            aria-label="Plugins"
          />
        </TooltipTrigger>
        <TooltipContent side="right">Plugins</TooltipContent>
      </Tooltip>
    </>
  );
}

function SidebarNavComponent({
  onNewChat,
  onViewChats,
  onNewFolder,
  onAddSplitPane,
  onAddNewChatPane,
  onReplacePaneAt,
  paneChatIds = [],
  paneLabels = [],
  activePaneIndex = 0,
  isSplitActive = false,
  canAddSplitPane = true,
  hasEmptyPane = false,
  onCycleLayout,
  onResetPaneSizes,
  onResetPaneZoom,
  onFlows,
  onPlugins,
  onShowWorkQueue,
  workQueueTriggerRef,
  flowsTriggerRef,
  isWorkQueueActive = false,
  isFlowsActive = false,
  inboxTaskCount,
  pendingReviewCount,
  runningTaskCount,
  needsAttentionTaskCount = 0,
  failedTaskCount = 0,
  activeTasksHasMore = false,
}: SidebarNavProps): ReactElement {
  // Tier/cloud-gated destinations HIDE when disabled — a free user cannot enable them.
  const showFlows = LAUNCH_FLAGS.flows;
  const showWorkQueue = LAUNCH_FLAGS.workQueue;
  const counts: WorkQueueCounts = {
    inboxTaskCount,
    pendingReviewCount,
    runningTaskCount,
    needsAttentionTaskCount,
    failedTaskCount,
    activeTasksHasMore,
  };

  return (
    <SidebarNavList aria-label="Primary">
      <NewChatNavRow
        onNewChat={onNewChat}
        onViewChats={onViewChats}
        returnFocusRef={isFlowsActive ? flowsTriggerRef : workQueueTriggerRef}
        onAddNewChatPane={onAddNewChatPane}
        onReplacePaneAt={onReplacePaneAt}
        paneChatIds={paneChatIds}
        paneLabels={paneLabels}
        activePaneIndex={activePaneIndex}
        isSplitActive={isSplitActive}
        isTransientDestinationActive={isWorkQueueActive || isFlowsActive}
        canAddSplitPane={canAddSplitPane}
        hasEmptyPane={hasEmptyPane}
      />

      <SidebarNavRow icon={<FolderPlus />} label={STRINGS.NEW_FOLDER} onClick={onNewFolder} />

      {onAddSplitPane && (
        <div className="flex items-center gap-1">
          <Tooltip delayDuration={TIMING.TOOLTIP_DELAY_MS}>
            <TooltipTrigger asChild>
              <SidebarNavRow
                className="flex-1"
                icon={isSplitActive ? <SquarePlus /> : <Columns2 />}
                label={isSplitActive ? STRINGS.ADD_PANE : 'Split view'}
                onClick={onAddSplitPane}
                disabled={!canAddSplitPane}
              />
            </TooltipTrigger>
            <TooltipContent side="right">
              {isSplitActive ? STRINGS.ADD_PANE : STRINGS.SPLIT_PANE}
              <Kbd shortcutId="new-agent-split" />
            </TooltipContent>
          </Tooltip>
          {/* Layout/reset controls — inline, each shown only when it can act. */}
          <SplitViewControls
            onCycleLayout={onCycleLayout}
            onResetPaneSizes={onResetPaneSizes}
            onResetPaneZoom={onResetPaneZoom}
          />
        </div>
      )}

      <DestinationNavRows
        showFlows={showFlows}
        showWorkQueue={showWorkQueue}
        onFlows={onFlows}
        onShowWorkQueue={onShowWorkQueue}
        onPlugins={onPlugins}
        flowsTriggerRef={flowsTriggerRef}
        workQueueTriggerRef={workQueueTriggerRef}
        isFlowsActive={isFlowsActive}
        isWorkQueueActive={isWorkQueueActive}
        counts={counts}
      />
    </SidebarNavList>
  );
}

export const SidebarNav = memo(SidebarNavComponent);
