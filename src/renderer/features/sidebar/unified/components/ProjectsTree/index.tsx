/**
 * ProjectsTree - Drag-and-drop enabled projects tree view
 */

import type { DragEndEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/core';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  rectIntersection,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { memo, type ReactElement } from 'react';
import type { SidebarBatchGroup } from '../../../../../../shared/types/flows/sidebar-batch-group';
import type { SidebarTaskStatus } from '../../constants';
import { STRINGS } from '../../constants';
import type { CodebaseGroup, ProjectActionHandlers } from '../../types';
import type { ActiveFolderChat, ChatReason } from '../../utils';
import { ChatListItem } from '../ChatListItem';
import { ChatSelectionDragBadge } from '../ChatSelection';
import { CodebaseItem } from '../CodebaseItem';

/** Module-level: dnd-kit's useSensor memoizes on the options object, so an inline literal rebuilds
 * DndContext's internal context every render and re-renders every draggable past its memo (sc-2721). */
const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 8 } };

/** Chat-row action callbacks, bundled so they thread as one prop instead of eight. */
type ChatRowActions = {
  onChatSelect: (chatId: string) => void;
  onChatRename: (chat: { id: string; name: string | null }) => void;
  onChatArchive: (chatId: string) => void;
  onChatFork: (chatId: string) => void;
  onChatDelete: (chatId: string) => void;
  onChatPin?: (chatId: string) => void;
  onChatOpenInNewPane?: (chatId: string) => void;
  /** False when all panes are full → the "Open in New Pane" action renders disabled. */
  canOpenInNewPane?: boolean;
};

/** dnd-kit drag handlers, bundled so they thread as one prop instead of four. */
type DndHandlers = {
  handleDragStart: (event: DragStartEvent) => void;
  handleDragOver: (event: DragOverEvent) => void;
  handleDragEnd: (event: DragEndEvent) => void;
  handleDragCancel: () => void;
};

type ProjectsTreeProps = ProjectActionHandlers & {
  filteredCodebases: CodebaseGroup[];
  searchQuery: string;
  isSearchActive: boolean;
  isCodebaseExpanded: (key: string) => boolean;
  toggleCodebase: (key: string) => void;
  selectedChatId: string | null;
  chatActions: ChatRowActions;
  // onProjectDelete / onRenameProject / onDeleteAllChatsInFolder come from ProjectActionHandlers.
  onDeleteBatch?: (batchId: string, summary: SidebarBatchGroup) => void;
  activeDropTargetId: string | null | undefined;
  activeChat: {
    id: string;
    name: string | null;
    sourceProjectId: string | null;
    isWorktree?: boolean;
  } | null;
  dndHandlers: DndHandlers;
  folderChatCountByKey: Record<string, number>;
  folderHasMoreByKey: Record<string, boolean>;
  folderLoadingByKey: Record<string, boolean>;
  onLoadMoreChats: (codebaseKey: string) => Promise<void>;
  /** Map of chatId → 1-indexed pane number for split view badges */
  chatPaneMap?: Map<string, number>;
  /** Map of linked chatId -> current high-priority task status */
  chatTaskStatusByChatId?: Map<string, SidebarTaskStatus>;
  /** Map of linked chatId -> the winning task's park reason ({summary,details}) for the pill tooltip */
  chatReasonByChatId?: Map<string, ChatReason>;
  /** Batch group summaries keyed by batch_id. Forwarded to CodebaseItem for grouping. */
  batchGroups?: Map<string, SidebarBatchGroup>;
  /** Chat ids with a live held question. Forwarded to BatchGroup's server-fetched rows. */
  pendingQuestionIds?: Set<string>;
  /** Folder key (local project id, null = general) → its active chats. Forwarded to CodebaseItem. */
  activeChatsByFolder?: Map<string | null, ActiveFolderChat[]>;
};

function ProjectsTreeComponent({
  filteredCodebases,
  searchQuery,
  isSearchActive,
  isCodebaseExpanded,
  toggleCodebase,
  selectedChatId,
  chatActions,
  onProjectDelete,
  onRenameProject,
  onDeleteAllChatsInFolder,
  onDeleteBatch,
  activeDropTargetId,
  activeChat,
  dndHandlers,
  folderChatCountByKey,
  folderHasMoreByKey,
  folderLoadingByKey,
  onLoadMoreChats,
  ...chatStatusMaps
}: ProjectsTreeProps): ReactElement {
  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(KeyboardSensor),
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={rectIntersection}
      onDragStart={dndHandlers.handleDragStart}
      onDragOver={dndHandlers.handleDragOver}
      onDragEnd={dndHandlers.handleDragEnd}
      onDragCancel={dndHandlers.handleDragCancel}
    >
      <div className="flex-1 overflow-y-auto px-2 py-1 scrollbar-thin">
        {filteredCodebases.length > 0 ? (
          <div className="space-y-0.5">
            {filteredCodebases.map((codebase) => {
              const key = codebase.gitRemote ?? codebase.displayName;
              return (
                <CodebaseItem
                  key={key}
                  codebaseKey={key}
                  codebase={codebase}
                  isExpanded={isCodebaseExpanded(key)}
                  toggleCodebase={toggleCodebase}
                  selectedChatId={selectedChatId}
                  onChatSelect={chatActions.onChatSelect}
                  onChatRename={chatActions.onChatRename}
                  onChatArchive={chatActions.onChatArchive}
                  onChatFork={chatActions.onChatFork}
                  onChatDelete={chatActions.onChatDelete}
                  onChatPin={chatActions.onChatPin}
                  onChatOpenInNewPane={chatActions.onChatOpenInNewPane}
                  canOpenInNewPane={chatActions.canOpenInNewPane}
                  onProjectDelete={onProjectDelete}
                  onRenameProject={onRenameProject}
                  onDeleteAllChatsInFolder={onDeleteAllChatsInFolder}
                  onDeleteBatch={onDeleteBatch}
                  activeDropTargetId={activeDropTargetId}
                  isSearchActive={isSearchActive}
                  totalChatsCount={folderChatCountByKey[key] ?? 0}
                  hasMoreChatsFromServer={folderHasMoreByKey[key] ?? false}
                  isLoadingMoreChats={folderLoadingByKey[key] ?? false}
                  onLoadMoreChats={onLoadMoreChats}
                  {...chatStatusMaps}
                />
              );
            })}
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-muted-foreground/60">
            {searchQuery ? 'No matches found' : STRINGS.NO_PROJECTS}
          </div>
        )}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeChat && (
          <div className="relative">
            <ChatListItem
              chat={{
                id: activeChat.id,
                name: activeChat.name,
                branch: null,
                updatedAt: null,
                pinnedAt: null,
                projectId: activeChat.sourceProjectId,
                hasUnseenChanges: false,
                isLoading: false,
                hasPendingPlan: false,
                hasPendingQuestion: false,
                isWorktree: activeChat.isWorktree ?? false,
                taskId: null,
                batchId: null,
              }}
              isSelected={false}
              onClick={() => {}}
            />
            <ChatSelectionDragBadge chatId={activeChat.id} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

export const ProjectsTree = memo(ProjectsTreeComponent);
