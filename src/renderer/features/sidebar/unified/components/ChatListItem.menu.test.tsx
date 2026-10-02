// @vitest-environment happy-dom
/** The row "…" menu against the REAL Radix DropdownMenu: its own memo boundary (sc-2721) must keep
 * the trigger wiring intact. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useConfirm } from '../../../../components/ui/use-confirm';
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

  it('hands delete the latest chat name so the confirmation can name it', async () => {
    const onDelete = vi.fn();
    const props = { isSelected: false, onClick: vi.fn(), onDelete };
    const { rerender } = render(<ChatListItem chat={{ ...chat, name: null }} {...props} />);
    // The title arrives after the row first rendered; the menu must not hand delete a stale name.
    rerender(<ChatListItem chat={chat} {...props} />);
    const trigger = screen.getByRole('button', { name: 'Chat actions' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete chat permanently' }));

    expect(onDelete).toHaveBeenCalledWith('chat-1', 'Menu chat');
  });

  it('opens the confirm from the real menu with Cancel focused, and leaves the page usable after', async () => {
    const onConfirmed = vi.fn();
    function Host(): ReactElement {
      const { confirm, confirmDialog } = useConfirm();
      return (
        <>
          <ChatListItem
            chat={chat}
            isSelected={false}
            onClick={vi.fn()}
            onDelete={async (chatId, chatName) => {
              const title = `Delete "${chatName}" permanently?`;
              if (await confirm({ title, description: 'Removed for good.' })) onConfirmed(chatId);
            }}
          />
          {confirmDialog}
        </>
      );
    }
    render(<Host />);
    const trigger = screen.getByRole('button', { name: 'Chat actions' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete chat permanently' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Delete "Menu chat" permanently?');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    // A key still held from picking the menu item must land on Cancel, never on Delete.
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(document.activeElement).toBe(cancel));

    fireEvent.click(cancel);

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onConfirmed).not.toHaveBeenCalled();
    // The menu and the dialog both lock the page while open; neither lock may outlive them.
    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe('none'));
  });
});
