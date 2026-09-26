/** DraggableChat - a chat row with its drag handle. Flow-managed task chats cannot be dragged. */

import { Button } from '@benord-labs/frink-primitives';
import {
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  useDraggable,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { memo, useMemo } from 'react';
import { cn } from '../../../../../lib/utils';
import type { ChatItem } from '../../types';
import { areChatRowMemoEqual } from '../../utils/chat-equality';
import { ChatListItem, type ChatRowActions } from '../ChatListItem';
import { useChatRowSelection } from '../ChatSelection';

type DraggableChatProps = ChatRowActions & {
  chat: ChatItem;
  isSelected: boolean;
  onChatSelect: (chatId: string) => void;
};

// Reference-compared props; `chat` and `reason` get structural checks in areChatRowMemoEqual.
// `canOpenInNewPane` must stay listed so the disabled menu item re-renders as panes fill.
const DRAGGABLE_CHAT_REF_KEYS = [
  'isSelected',
  'splitPaneIndex',
  'taskStatus',
  'onChatSelect',
  'onRename',
  'onArchive',
  'onFork',
  'onDelete',
  'onPin',
  'onOpenInNewPane',
  'canOpenInNewPane',
] as const satisfies readonly (keyof DraggableChatProps)[];

function areDraggableChatPropsEqual(
  prev: Readonly<DraggableChatProps>,
  next: Readonly<DraggableChatProps>,
): boolean {
  return areChatRowMemoEqual(prev, next, DRAGGABLE_CHAT_REF_KEYS);
}

// Hidden at rest and revealed when the row is hovered or keyboard-focused; task grips never show.
const DRAGGABLE_GRIP_CLASS =
  'cursor-grab opacity-0 transition-opacity group-hover/drag:opacity-100 group-focus-within/drag:opacity-100 hover:text-muted-foreground/70 active:cursor-grabbing';

type DragGripProps = {
  isLocked: boolean;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
};

/** A locked grip is `disabled`, which takes it out of the tab order; aria-hidden on a focusable
 * button would fail axe's aria-hidden-focus rule. */
function DragGrip({ isLocked, attributes, listeners }: DragGripProps) {
  const dragProps = isLocked
    ? { disabled: true, 'aria-hidden': true }
    : { ...attributes, ...listeners, 'aria-label': 'Drag to reorder' };
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn(
        'ml-1 px-1 text-muted-foreground/30 hover:bg-transparent',
        isLocked ? 'cursor-default disabled:opacity-100' : DRAGGABLE_GRIP_CLASS,
      )}
      {...dragProps}
    >
      <GripVertical className={cn('h-3.5 w-3.5', isLocked && 'invisible')} />
    </Button>
  );
}

export const DraggableChat = memo(function DraggableChat({
  chat,
  isSelected,
  onChatSelect,
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
}: DraggableChatProps) {
  const { isMultiSelected, onClick } = useChatRowSelection(chat.id, onChatSelect);

  const draggableData = useMemo(
    () => ({
      id: chat.id,
      name: chat.name,
      sourceProjectId: chat.projectId,
      isWorktree: chat.isWorktree,
    }),
    [chat.id, chat.name, chat.projectId, chat.isWorktree],
  );

  // Moving a flow-managed chat between folders breaks its flow↔project link. Gate on taskId, not
  // taskStatus: finished task chats keep their taskId and must stay locked.
  const isTaskChat = chat.taskId !== null;

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: chat.id,
    data: draggableData,
    disabled: isTaskChat,
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.3 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="group/drag relative flex items-center">
      <DragGrip isLocked={isTaskChat} attributes={attributes} listeners={listeners} />
      <div className="flex-1 min-w-0 -ml-1">
        <ChatListItem
          chat={chat}
          taskStatus={taskStatus}
          reason={reason}
          isSelected={isSelected}
          isMultiSelected={isMultiSelected}
          onClick={onClick}
          onRename={onRename}
          onArchive={onArchive}
          onFork={onFork}
          onDelete={onDelete}
          onPin={onPin}
          onOpenInNewPane={onOpenInNewPane}
          canOpenInNewPane={canOpenInNewPane}
          isPinned={!!chat.pinnedAt}
          splitPaneIndex={splitPaneIndex}
          depth={0}
        />
      </div>
    </div>
  );
}, areDraggableChatPropsEqual);
