// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useChatDnd } from './use-chat-dnd';

function makeDragStartEvent(chat: {
  id: string;
  name: string | null;
  sourceProjectId: string | null;
}) {
  return {
    active: {
      data: { current: chat },
    },
  } as const;
}

function makeDragOverEvent(projectId: string | null) {
  return {
    over: {
      id: `folder-${projectId ?? 'general'}`,
      data: { current: { type: 'folder', projectId } },
    },
  } as const;
}

describe('useChatDnd', () => {
  it('moves chat when dropped on a different folder', () => {
    const onMoveChat = vi.fn();
    const { result } = renderHook(() => useChatDnd({ onMoveChat }));

    act(() => {
      result.current.handleDragStart(
        makeDragStartEvent({ id: 'chat-1', name: 'Chat', sourceProjectId: 'project-a' }) as never,
      );
    });
    act(() => {
      result.current.handleDragOver(makeDragOverEvent('project-b') as never);
    });
    act(() => {
      result.current.handleDragEnd({
        over: {
          id: 'folder-project-b',
          data: { current: { type: 'folder', projectId: 'project-b' } },
        },
      } as never);
    });

    expect(onMoveChat).toHaveBeenCalledTimes(1);
    expect(onMoveChat).toHaveBeenCalledWith('chat-1', 'project-b', 'project-a');
  });

  // The rest of a multi-selection may live elsewhere; moveChats skips chats already in the target.
  it('hands a same-folder drop to onMoveChat', () => {
    const onMoveChat = vi.fn();
    const { result } = renderHook(() => useChatDnd({ onMoveChat }));

    act(() => {
      result.current.handleDragStart(
        makeDragStartEvent({ id: 'chat-1', name: 'Chat', sourceProjectId: 'project-a' }) as never,
      );
    });
    act(() => {
      result.current.handleDragOver(makeDragOverEvent('project-a') as never);
    });
    act(() => {
      result.current.handleDragEnd({
        over: {
          id: 'folder-project-a',
          data: { current: { type: 'folder', projectId: 'project-a' } },
        },
      } as never);
    });

    expect(onMoveChat).toHaveBeenCalledWith('chat-1', 'project-a', 'project-a');
  });

  it('uses last valid folder target when drag-end over is undefined', () => {
    const onMoveChat = vi.fn();
    const { result } = renderHook(() => useChatDnd({ onMoveChat }));

    act(() => {
      result.current.handleDragStart(
        makeDragStartEvent({ id: 'chat-1', name: 'Chat', sourceProjectId: 'project-a' }) as never,
      );
    });
    act(() => {
      result.current.handleDragOver(makeDragOverEvent(null) as never);
    });
    act(() => {
      result.current.handleDragEnd({ over: null } as never);
    });

    expect(onMoveChat).toHaveBeenCalledTimes(1);
    expect(onMoveChat).toHaveBeenCalledWith('chat-1', null, 'project-a');
  });

  it('does not move when drop target is not a folder', () => {
    const onMoveChat = vi.fn();
    const { result } = renderHook(() => useChatDnd({ onMoveChat }));

    act(() => {
      result.current.handleDragStart(
        makeDragStartEvent({ id: 'chat-1', name: 'Chat', sourceProjectId: 'project-a' }) as never,
      );
    });
    act(() => {
      result.current.handleDragOver({
        over: { id: 'chat-row', data: { current: { type: 'chat' } } },
      } as never);
    });
    act(() => {
      result.current.handleDragEnd({
        over: { id: 'chat-row', data: { current: { type: 'chat' } } },
      } as never);
    });

    expect(onMoveChat).not.toHaveBeenCalled();
  });

  it('supports rapid sequential moves for same chat (A->B->C)', () => {
    const onMoveChat = vi.fn();
    const { result } = renderHook(() => useChatDnd({ onMoveChat }));

    // A -> B
    act(() => {
      result.current.handleDragStart(
        makeDragStartEvent({ id: 'chat-1', name: 'Chat', sourceProjectId: 'project-a' }) as never,
      );
    });
    act(() => {
      result.current.handleDragOver(makeDragOverEvent('project-b') as never);
    });
    act(() => {
      result.current.handleDragEnd({
        over: {
          id: 'folder-project-b',
          data: { current: { type: 'folder', projectId: 'project-b' } },
        },
      } as never);
    });
    // B -> C
    act(() => {
      result.current.handleDragStart(
        makeDragStartEvent({ id: 'chat-1', name: 'Chat', sourceProjectId: 'project-b' }) as never,
      );
    });
    act(() => {
      result.current.handleDragOver(makeDragOverEvent('project-c') as never);
    });
    act(() => {
      result.current.handleDragEnd({
        over: {
          id: 'folder-project-c',
          data: { current: { type: 'folder', projectId: 'project-c' } },
        },
      } as never);
    });

    expect(onMoveChat).toHaveBeenCalledTimes(2);
    expect(onMoveChat).toHaveBeenNthCalledWith(1, 'chat-1', 'project-b', 'project-a');
    expect(onMoveChat).toHaveBeenNthCalledWith(2, 'chat-1', 'project-c', 'project-b');
  });
});
