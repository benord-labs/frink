/**
 * Hook for cross-folder chat drag-and-drop
 * Manages DndContext at sidebar level for inter-folder moves
 */

import type { DragEndEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/core';
import { useCallback, useRef, useState } from 'react';

type DraggedChat = {
  id: string;
  name: string | null;
  sourceProjectId: string | null;
  isWorktree?: boolean;
};

type UseChatDndParams = {
  onMoveChat: (
    chatId: string,
    targetProjectId: string | null,
    sourceProjectId: string | null,
  ) => void;
};

export function useChatDnd({ onMoveChat }: UseChatDndParams) {
  const [activeChat, setActiveChat] = useState<DraggedChat | null>(null);
  const activeChatRef = useRef<DraggedChat | null>(null);
  const [overProjectId, setOverProjectId] = useState<string | null | undefined>(undefined);
  // Track the last valid drop target to handle timing issues
  const lastValidOverRef = useRef<{ id: string; projectId: string | null } | null>(null);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { active } = event;
    const chatData = active.data.current as DraggedChat | undefined;
    if (chatData) {
      setActiveChat(chatData);
      activeChatRef.current = chatData;
      lastValidOverRef.current = null;
    }
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event;

    if (!over) {
      setOverProjectId(undefined);
      return;
    }

    const overData = over.data.current as { type: string; projectId: string | null } | undefined;
    if (overData?.type === 'folder') {
      setOverProjectId(overData.projectId);
      lastValidOverRef.current = { id: over.id as string, projectId: overData.projectId };
    } else {
      setOverProjectId(undefined);
    }
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { over } = event;
      const dragging = activeChatRef.current;

      // Use the last valid over if current over is undefined (timing issue workaround)
      const effectiveOver =
        over ??
        (lastValidOverRef.current
          ? {
              id: lastValidOverRef.current.id,
              data: { current: { type: 'folder', projectId: lastValidOverRef.current.projectId } },
            }
          : null);

      if (!effectiveOver || !dragging) {
        setActiveChat(null);
        activeChatRef.current = null;
        setOverProjectId(undefined);
        lastValidOverRef.current = null;
        return;
      }

      const overData = effectiveOver.data?.current as
        | { type: string; projectId: string | null }
        | undefined;

      // Same-folder drops pass too: the rest of a multi-selection may live elsewhere.
      if (overData?.type === 'folder') {
        onMoveChat(dragging.id, overData.projectId, dragging.sourceProjectId);
      }

      setActiveChat(null);
      activeChatRef.current = null;
      setOverProjectId(undefined);
      lastValidOverRef.current = null;
    },
    [onMoveChat],
  );

  const handleDragCancel = useCallback(() => {
    setActiveChat(null);
    activeChatRef.current = null;
    setOverProjectId(undefined);
  }, []);

  return {
    activeChat,
    overProjectId,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
  };
}
