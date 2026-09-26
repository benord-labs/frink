// @vitest-environment happy-dom
import { DndContext } from '@dnd-kit/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdSelectionStore } from '../../../../../lib/tree-navigation';
import type { ChatItem } from '../../types';
import { ChatSelectionContext } from '../ChatSelection';
import { DraggableChat } from '.';

// oxlint-disable anti-slop/no-module-mocking -- the row's menu, tooltip and task hook need app
// providers that are irrelevant to click wiring; the same doubles ChatListItem.test uses.
vi.mock('../../../../../components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('../../../../../components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
vi.mock('@/hooks/use-mark-task-complete', () => ({ useMarkTaskComplete: () => vi.fn() }));

const chat: ChatItem = {
  id: 'chat-1',
  name: 'Remove toast testing',
  branch: null,
  updatedAt: null,
  pinnedAt: null,
  projectId: 'proj-1',
  hasUnseenChanges: false,
  isLoading: false,
  hasPendingPlan: false,
  hasPendingQuestion: false,
  isWorktree: false,
  taskId: null,
  batchId: null,
};

afterEach(cleanup);

describe('DraggableChat multi-select wiring', () => {
  it('Cmd+click marks the row selected without opening it; a plain click opens it', () => {
    const store = createIdSelectionStore();
    const onChatSelect = vi.fn();
    const { container } = render(
      <ChatSelectionContext.Provider value={store}>
        <DndContext>
          <div role="tree">
            <DraggableChat chat={chat} isSelected={false} onChatSelect={onChatSelect} />
          </div>
        </DndContext>
      </ChatSelectionContext.Provider>,
    );
    const row = container.querySelector('[data-item-id="chat-1"]');

    fireEvent.click(screen.getByText('Remove toast testing'), { metaKey: true });
    expect(onChatSelect).not.toHaveBeenCalled();
    expect(store.isSelected('chat-1')).toBe(true);
    expect(row?.className).toContain('ring-primary/40');

    fireEvent.click(screen.getByText('Remove toast testing'));
    expect(onChatSelect).toHaveBeenCalledWith('chat-1');
    expect(store.isSelected('chat-1')).toBe(false);
    expect(row?.className).not.toContain('ring-primary/40');
  });
});
