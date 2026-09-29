// @vitest-environment happy-dom
/** The row "…" menu against the REAL Radix DropdownMenu: its own memo boundary (sc-2721) must keep
 * the trigger wiring intact. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatItem } from '../types';
import { ChatListItem } from './ChatListItem';

// oxlint-disable anti-slop/no-module-mocking -- tooltips and the task mutation need app providers
// irrelevant to the menu's keyboard contract.
vi.mock('../../../../components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
vi.mock('@/hooks/use-mark-task-complete', () => ({ useMarkTaskComplete: () => vi.fn() }));

const chat: ChatItem = {
  id: 'chat-1',
  name: 'Menu chat',
  branch: null,
  updatedAt: null,
  pinnedAt: null,
  projectId: 'proj-1',
  hasUnseenChanges: false,
  isLoading: false,
  hasPendingPlan: false,
  hasPendingQuestion: false,
  isHeld: false,
  isWorktree: false,
  taskId: null,
  batchId: null,
};

afterEach(cleanup);

describe('ChatListItem actions menu (real Radix)', () => {
  it('opens from the keyboard, focuses into the menu, and Escape returns focus to the trigger', async () => {
    render(
      <ChatListItem
        chat={chat}
        isSelected={false}
        onClick={vi.fn()}
        onRename={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Chat actions' });
    expect(screen.queryByRole('menu')).toBeNull();

    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });

    const menu = await screen.findByRole('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.className).toContain('opacity-100');
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(document.activeElement ?? menu, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('keeps the menu open and usable across a stream tick on the same row', async () => {
    const onRename = vi.fn();
    const props = { isSelected: false, onClick: vi.fn(), onRename };
    const { rerender } = render(<ChatListItem chat={chat} {...props} />);
    const trigger = screen.getByRole('button', { name: 'Chat actions' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    await screen.findByRole('menu');

    rerender(
      <ChatListItem chat={{ ...chat, isLoading: true, updatedAt: new Date() }} {...props} />,
    );

    const item = await screen.findByRole('menuitem', { name: 'Rename' });
    fireEvent.click(item);
    expect(onRename).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'chat-1', isLoading: true }),
    );
  });
});
