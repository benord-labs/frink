/* eslint-disable max-lines, max-lines-per-function */
/**
 * CodebaseItem - Top-level codebase (grouped by git_remote)
 *
 * Chats are shown directly under the codebase.
 *
 * Supports drag-and-drop: chats can be dropped here to move between folders
 */

import { Button } from '@benord-labs/frink-primitives';
import { useDroppable } from '@dnd-kit/core';
import { Box, Folder, GitBranch, MoreHorizontal, Pencil, Pin, Trash2 } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import type { SidebarBatchGroup } from '../../../../../shared/types/flows/sidebar-batch-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../../components/ui/dropdown-menu';
import { isBuildProjectPath } from '../../../../lib/build-project';
import { cn } from '../../../../lib/utils';
import { SidebarSectionLabel } from '../../components/SidebarSectionLabel';
import type { SidebarTaskStatus } from '../constants';
import { PAGINATION, STRINGS } from '../constants';
import type { ChatItem, CodebaseGroup, ProjectActionHandlers } from '../types';
import {
  type ActiveFolderChat,
  type ChatReason,
  getFolderActiveChats,
  getFolderActiveState,
} from '../utils';
import {
  areCodebaseGroupsSidebarEqual,
  batchGroupsEqualForCodebase,
  folderActivityEqual,
  chatMapsEqualForCodebase,
  reasonsEqual,
  selectionTouchesCodebase,
} from '../utils/chat-equality';
import { BatchGroup } from './BatchGroup';
import { DraggableChat } from './DraggableChat';
import { FolderRowMeta } from './FolderRowMeta';
import { TreeItem } from './TreeItem';

type CodebaseItemProps = ProjectActionHandlers & {
  /** The key used to identify this codebase (gitRemote or displayName) */
  codebaseKey: string;
  codebase: CodebaseGroup;
  isExpanded: boolean;
  toggleCodebase: (key: string) => void;
  selectedChatId: string | null;
  onChatSelect: (chatId: string) => void;
  // Chat-row actions — operate on a CHAT inside this codebase, forwarded down to ChatListItem.
  onChatRename?: (chat: ChatItem) => void;
  onChatArchive?: (chatId: string) => void;
  onChatFork?: (chatId: string) => void;
  onChatDelete?: (chatId: string, chatName?: string | null) => void;
  onChatPin?: (chatId: string) => void;
  onChatOpenInNewPane?: (chatId: string) => void;
  /** False when all panes are full → the "Open in New Pane" chat action renders disabled. */
  canOpenInNewPane?: boolean;
  // Project-level actions (onProjectDelete / onRenameProject / onDeleteAllChatsInFolder) come from
  // the shared ProjectActionHandlers. onDeleteBatch stays inline — its arg type lives in src/main.
  onDeleteBatch?: (batchId: string, summary: SidebarBatchGroup) => void;
  activeDropTargetId?: string | null;
  totalChatsCount: number;
  isSearchActive?: boolean;
  hasMoreChatsFromServer?: boolean;
  isLoadingMoreChats?: boolean;
  onLoadMoreChats?: (codebaseKey: string) => Promise<void>;
  /** Map of chatId → 1-indexed pane number for split view badges */
  chatPaneMap?: Map<string, number>;
  /** Map of linked chatId -> current high-priority task status */
  chatTaskStatusByChatId?: Map<string, SidebarTaskStatus>;
  /** Map of linked chatId -> the winning task's park reason for the pill tooltip */
  chatReasonByChatId?: Map<string, ChatReason>;
  /** Batch group summaries keyed by batch_id. When provided, batched chats are grouped under a BatchGroup sub-folder. */
  batchGroups?: Map<string, SidebarBatchGroup>;
  /** Chat ids with a live held question. Forwarded to BatchGroup's server-fetched rows. */
  pendingQuestionIds?: Set<string>;
  /** Folder key (local project id, null = general) → its active chats, loaded or not. */
  activeChatsByFolder?: Map<string | null, ActiveFolderChat[]>;
};

const CODEBASE_ITEM_REF_KEYS = [
  'codebaseKey',
  'isExpanded',
  'toggleCodebase',
  'onChatSelect',
  'onChatRename',
  'onChatArchive',
  'onChatFork',
  'onChatDelete',
  'onChatPin',
  'onChatOpenInNewPane',
  'canOpenInNewPane',
  'onProjectDelete',
  'onRenameProject',
  'onDeleteAllChatsInFolder',
  'onDeleteBatch',
  'activeDropTargetId',
  'totalChatsCount',
  'isSearchActive',
  'hasMoreChatsFromServer',
  'isLoadingMoreChats',
  'onLoadMoreChats',
  // Memoized from the pending-questions atom; a new reference only appears when a question is
  // raised or retired, so reference equality is both correct and cheap here.
  'pendingQuestionIds',
] as const satisfies readonly (keyof CodebaseItemProps)[];

function areCodebaseItemPropsEqual(
  prev: Readonly<CodebaseItemProps>,
  next: Readonly<CodebaseItemProps>,
): boolean {
  for (const key of CODEBASE_ITEM_REF_KEYS) {
    if (prev[key] !== next[key]) return false;
  }
  if (!areCodebaseGroupsSidebarEqual(prev.codebase, next.codebase)) return false;
  if (
    prev.selectedChatId !== next.selectedChatId &&
    selectionTouchesCodebase(prev.codebase, prev.selectedChatId, next.selectedChatId)
  ) {
    return false;
  }
  if (!chatMapsEqualForCodebase(prev.chatPaneMap, next.chatPaneMap, prev.codebase)) return false;
  if (
    !chatMapsEqualForCodebase(
      prev.chatTaskStatusByChatId,
      next.chatTaskStatusByChatId,
      prev.codebase,
    )
  ) {
    return false;
  }
  // Compared by neither the ref keys nor the scans above until now: with the memo finally holding,
  // an unmatched reason change would leave the pill tooltip permanently stale.
  if (
    !chatMapsEqualForCodebase(
      prev.chatReasonByChatId,
      next.chatReasonByChatId,
      prev.codebase,
      reasonsEqual,
    )
  ) {
    return false;
  }
  if (!batchGroupsEqualForCodebase(prev.batchGroups, next.batchGroups, prev.codebase)) return false;
  return folderActivityEqual(prev, next, prev.codebase);
}

export const CodebaseItem = memo(function CodebaseItem({
  codebaseKey,
  codebase,
  isExpanded,
  toggleCodebase,
  selectedChatId,
  onChatSelect,
  onChatRename,
  onChatArchive,
  onChatFork,
  onChatDelete,
  onChatPin,
  onChatOpenInNewPane,
  canOpenInNewPane,
  onProjectDelete,
  onRenameProject,
  onDeleteAllChatsInFolder,
  onDeleteBatch,
  activeDropTargetId,
  totalChatsCount: totalChats,
  isSearchActive = false,
  hasMoreChatsFromServer = false,
  isLoadingMoreChats = false,
  onLoadMoreChats,
  chatPaneMap,
  chatTaskStatusByChatId,
  chatReasonByChatId,
  batchGroups,
  pendingQuestionIds,
  activeChatsByFolder,
}: CodebaseItemProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState<number>(PAGINATION.FOLDER_CHAT_PAGE_SIZE);
  const hasGitRemote = !!codebase.gitRemote;

  const handleToggle = useCallback(() => {
    toggleCodebase(codebaseKey);
  }, [toggleCodebase, codebaseKey]);

  const allChats = useMemo(() => {
    return [...codebase.chats].sort((a, b) => {
      const aPinned = a.pinnedAt?.getTime() ?? 0;
      const bPinned = b.pinnedAt?.getTime() ?? 0;
      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;
      if (aPinned && bPinned) return bPinned - aPinned;
      if (!a.updatedAt && !b.updatedAt) return 0;
      if (!a.updatedAt) return 1;
      if (!b.updatedAt) return -1;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });
  }, [codebase.chats]);

  /** Same keying as useGroupedProjects — for BatchGroup server-fetched rows */
  const projectPathById = useMemo(() => {
    return new Map(codebase.projects.map((p) => [p.id, p.path]));
  }, [codebase.projects]);

  /**
   * Sidebar entries: chats + batch groups, sorted by pin then recency.
   * When the folder has both pinned and unpinned entries (and search is inactive),
   * insert "Pinned" / "Recent" section headers so the divide is unmistakable.
   * During search, headers are skipped so matches surface across boundaries.
   */
  type SidebarEntry =
    | { type: 'chat'; chat: ChatItem }
    | { type: 'batchGroup'; batchId: string; chats: ChatItem[]; summary: SidebarBatchGroup }
    | { type: 'sectionHeader'; label: 'Pinned' | 'Recent'; count: number };

  const sidebarEntries = useMemo((): SidebarEntry[] => {
    const isEntryPinned = (e: SidebarEntry): boolean => {
      if (e.type === 'chat') return !!e.chat.pinnedAt;
      if (e.type === 'batchGroup') return !!e.chats[0]?.pinnedAt;
      return false;
    };

    // A chat entry uses its own date; a batch group uses its first chat's. Anything else sorts oldest.
    const entryTimestamp = (e: SidebarEntry, field: 'pinnedAt' | 'updatedAt'): number => {
      if (e.type === 'chat') return e.chat[field]?.getTime() ?? 0;
      if (e.type === 'batchGroup') return e.chats[0]?.[field]?.getTime() ?? 0;
      return 0;
    };

    const buildSorted = (): SidebarEntry[] => {
      if (!batchGroups || batchGroups.size === 0 || isSearchActive) {
        return allChats.map((chat) => ({ type: 'chat', chat }));
      }

      const batchedChatsByBatchId = new Map<string, ChatItem[]>();
      const flatChats: ChatItem[] = [];

      for (const chat of allChats) {
        if (chat.batchId && batchGroups.has(chat.batchId)) {
          const group = batchedChatsByBatchId.get(chat.batchId) ?? [];
          group.push(chat);
          batchedChatsByBatchId.set(chat.batchId, group);
        } else {
          flatChats.push(chat);
        }
      }

      const out: SidebarEntry[] = flatChats.map((chat): SidebarEntry => ({ type: 'chat', chat }));

      for (const [batchId, groupChats] of batchedChatsByBatchId) {
        const summary = batchGroups.get(batchId);
        if (!summary) continue;
        out.push({ type: 'batchGroup', batchId, chats: groupChats, summary });
      }

      out.sort((a, b) => {
        // Pinned entries first (newest pin on top), then the rest by recency.
        const aPinnedAt = entryTimestamp(a, 'pinnedAt');
        const bPinnedAt = entryTimestamp(b, 'pinnedAt');
        if (aPinnedAt && !bPinnedAt) return -1;
        if (!aPinnedAt && bPinnedAt) return 1;
        if (aPinnedAt && bPinnedAt) return bPinnedAt - aPinnedAt;
        return entryTimestamp(b, 'updatedAt') - entryTimestamp(a, 'updatedAt');
      });

      return out;
    };

    const sorted = buildSorted();
    if (isSearchActive) return sorted;

    const pinnedCount = sorted.filter(isEntryPinned).length;
    const unpinnedCount = sorted.length - pinnedCount;
    if (pinnedCount === 0 || unpinnedCount === 0) return sorted;

    const withHeaders: SidebarEntry[] = [
      { type: 'sectionHeader', label: 'Pinned', count: pinnedCount },
    ];
    let recentInserted = false;
    for (const entry of sorted) {
      if (!recentInserted && !isEntryPinned(entry)) {
        withHeaders.push({ type: 'sectionHeader', label: 'Recent', count: unpinnedCount });
        recentInserted = true;
      }
      withHeaders.push(entry);
    }
    return withHeaders;
  }, [allChats, batchGroups, isSearchActive]);

  /** Section headers don't count toward pagination; they are layout, not content. */
  const renderableEntryCount = useMemo(
    () => sidebarEntries.filter((e) => e.type !== 'sectionHeader').length,
    [sidebarEntries],
  );
  const hasMoreVisibleChats = !isSearchActive && renderableEntryCount > visibleCount;
  const canRequestOlderChats = !isSearchActive && !hasMoreVisibleChats && hasMoreChatsFromServer;
  const canLoadMore = hasMoreVisibleChats || canRequestOlderChats;

  const firstProject = codebase.projects[0];
  const isGeneralChats = !firstProject;
  const projectId = firstProject?.id ?? null;

  const droppableData = useMemo(() => ({ type: 'folder' as const, projectId }), [projectId]);
  const { setNodeRef, isOver } = useDroppable({
    id: projectId ? `folder-${projectId}` : 'folder-general',
    data: droppableData,
  });

  const isActiveDropTarget = activeDropTargetId === projectId;

  // Collapsed folders wear the highest-precedence state of their chats so running / needs-you work
  // is findable without expanding every project. Expanded folders already show it on the rows.
  const folderState = useMemo(() => {
    if (isExpanded) return null;
    const activeChats = getFolderActiveChats(activeChatsByFolder, codebase);
    return getFolderActiveState(
      allChats,
      chatTaskStatusByChatId,
      batchGroups,
      activeChats,
      pendingQuestionIds,
    );
  }, [
    isExpanded,
    activeChatsByFolder,
    codebase,
    allChats,
    chatTaskStatusByChatId,
    batchGroups,
    pendingQuestionIds,
  ]);

  const canDelete = !isGeneralChats && onProjectDelete;

  const handleLoadMoreChats = useCallback(async () => {
    if (hasMoreVisibleChats) {
      setVisibleCount((current) => current + PAGINATION.FOLDER_CHAT_PAGE_SIZE);
      return;
    }

    if (canRequestOlderChats && onLoadMoreChats) {
      await onLoadMoreChats(codebaseKey);
      setVisibleCount((current) => current + PAGINATION.FOLDER_CHAT_PAGE_SIZE);
    }
  }, [canRequestOlderChats, hasMoreVisibleChats, onLoadMoreChats, codebaseKey]);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'group/codebase rounded-md transition-colors min-h-[32px] first:mt-0 mt-0.5',
        (isOver || isActiveDropTarget) && 'bg-primary/10 ring-1 ring-primary/30',
      )}
    >
      <TreeItem
        label={
          <span className="truncate font-medium text-foreground" title={codebase.displayName}>
            {codebase.displayName}
          </span>
        }
        icon={
          hasGitRemote ? (
            <GitBranch className="h-4 w-4 text-muted-foreground" />
          ) : isBuildProjectPath(firstProject?.path) ? (
            <Box className="h-4 w-4 text-muted-foreground" />
          ) : (
            <Folder className="h-4 w-4 text-muted-foreground" />
          )
        }
        rightContent={
          totalChats > 0 ? (
            <FolderRowMeta
              isExpanded={isExpanded}
              chats={allChats}
              chatPaneMap={chatPaneMap}
              folderState={folderState}
              totalChats={totalChats}
            />
          ) : undefined
        }
        trailingAction={
          canDelete || (totalChats > 0 && onDeleteAllChatsInFolder) ? (
            <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    'rounded',
                    // Hover the project header row, or keyboard-focus the button itself. NOT
                    // group-focus-within (that kept it visible whenever any chat in the project held focus).
                    'opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100',
                    isMenuOpen && 'opacity-100',
                  )}
                  aria-label="Folder actions"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {/* Rename only for auto-named build projects — a real repo's name is meaningful. */}
                {onRenameProject && firstProject && isBuildProjectPath(firstProject.path) && (
                  <DropdownMenuItem
                    onClick={() => onRenameProject(firstProject.id, codebase.displayName)}
                  >
                    <Pencil className="h-4 w-4 mr-2" />
                    Rename
                  </DropdownMenuItem>
                )}
                {onProjectDelete && firstProject && (
                  <DropdownMenuItem
                    onClick={() => onProjectDelete(firstProject.id)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete Project
                  </DropdownMenuItem>
                )}
                {totalChats > 0 && onDeleteAllChatsInFolder && (
                  <DropdownMenuItem
                    onClick={() => {
                      onDeleteAllChatsInFolder(codebaseKey);
                    }}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    {STRINGS.DELETE_ALL_CHATS_IN_FOLDER}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined
        }
        isExpanded={isExpanded}
        onToggle={handleToggle}
        depth={0}
        itemId={codebaseKey}
      >
        {/* Chats and batch groups */}
        {allChats.length > 0 ? (
          <fieldset aria-label={`${codebase.displayName} chats`} className="contents">
            {(isSearchActive
              ? sidebarEntries
              : (() => {
                  const out: SidebarEntry[] = [];
                  let renderable = 0;
                  for (const entry of sidebarEntries) {
                    if (entry.type !== 'sectionHeader') {
                      if (renderable >= visibleCount) break;
                      renderable += 1;
                    }
                    out.push(entry);
                  }
                  while (out.length > 0 && out[out.length - 1]?.type === 'sectionHeader') {
                    out.pop();
                  }
                  return out;
                })()
            ).map((entry) =>
              entry.type === 'sectionHeader' ? (
                <SidebarSectionLabel
                  key={`section-${entry.label}`}
                  label={entry.label}
                  count={entry.count}
                  rule
                  icon={
                    entry.label === 'Pinned' ? (
                      <Pin
                        className="h-2.5 w-2.5 text-primary fill-primary/40"
                        aria-hidden="true"
                      />
                    ) : undefined
                  }
                  className={cn(
                    'pl-9 pr-2',
                    entry.label === 'Pinned' ? 'pt-1.5 pb-0.5' : 'pt-2 pb-0.5',
                  )}
                />
              ) : entry.type === 'batchGroup' ? (
                <BatchGroup
                  key={`batch-${entry.batchId}`}
                  summary={entry.summary}
                  localChats={entry.chats}
                  projectPathById={projectPathById}
                  selectedChatId={selectedChatId}
                  onChatSelect={onChatSelect}
                  onChatRename={onChatRename}
                  onChatArchive={onChatArchive}
                  onChatFork={onChatFork}
                  onChatDelete={onChatDelete}
                  onChatOpenInNewPane={onChatOpenInNewPane}
                  canOpenInNewPane={canOpenInNewPane}
                  onDeleteBatch={onDeleteBatch}
                  chatPaneMap={chatPaneMap}
                  chatTaskStatusByChatId={chatTaskStatusByChatId}
                  chatReasonByChatId={chatReasonByChatId}
                  pendingQuestionIds={pendingQuestionIds}
                />
              ) : (
                <DraggableChat
                  key={entry.chat.id}
                  chat={entry.chat}
                  taskStatus={chatTaskStatusByChatId?.get(entry.chat.id)}
                  reason={chatReasonByChatId?.get(entry.chat.id)}
                  isSelected={selectedChatId === entry.chat.id}
                  onChatSelect={onChatSelect}
                  onRename={onChatRename}
                  onArchive={onChatArchive}
                  onFork={onChatFork}
                  onDelete={onChatDelete}
                  onPin={onChatPin}
                  onOpenInNewPane={onChatOpenInNewPane}
                  canOpenInNewPane={canOpenInNewPane}
                  splitPaneIndex={chatPaneMap?.get(entry.chat.id)}
                />
              ),
            )}
            {canLoadMore && (
              <div className="py-1 pl-9">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleLoadMoreChats}
                  disabled={isLoadingMoreChats && canRequestOlderChats}
                  className={cn(
                    'h-auto justify-start text-xs text-muted-foreground hover:bg-transparent hover:text-foreground',
                    'min-h-[44px] px-2 -ml-0.5',
                  )}
                >
                  {isLoadingMoreChats && canRequestOlderChats
                    ? 'Load more chats...'
                    : 'Load more chats'}
                </Button>
              </div>
            )}
            {isSearchActive && totalChats > allChats.length && (
              <div role="note" className="py-1 pl-9 text-[11px] text-muted-foreground/70">
                Showing matches from loaded chats only. Load more to search older chats.
              </div>
            )}
          </fieldset>
        ) : totalChats > 0 && isLoadingMoreChats ? (
          <div className="py-1.5 pl-9 text-xs text-muted-foreground/70">Loading chats...</div>
        ) : (
          <div role="note" className="py-1.5 pl-9 text-xs text-muted-foreground/60 italic">
            {STRINGS.NO_CHATS}. Start one to see it here.
          </div>
        )}
      </TreeItem>
    </div>
  );
}, areCodebaseItemPropsEqual);
