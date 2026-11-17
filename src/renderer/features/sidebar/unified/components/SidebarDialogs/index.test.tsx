// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarDialogs } from './index';

vi.mock('../../../../../components/rename-dialog', () => ({
  RenameDialog: () => null,
}));

vi.mock('../../../../../components/ui/alert-dialog', () => ({
  AlertDialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogCancel: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

afterEach(cleanup);

function renderDialogs(overrides?: Partial<ComponentProps<typeof SidebarDialogs>>) {
  const props: ComponentProps<typeof SidebarDialogs> = {
    chatToRename: null,
    onChatRenameClose: vi.fn(),
    onChatRenameConfirm: vi.fn(async () => {}),
    projectToRename: null,
    onProjectRenameClose: vi.fn(),
    onProjectRenameConfirm: vi.fn(async () => {}),
    isNewFolderDialogOpen: false,
    onNewFolderClose: vi.fn(),
    onNewFolderConfirm: vi.fn(async () => {}),
    taskAwareActionDialog: {
      open: true,
      mode: 'single',
      operation: 'delete',
      taskIds: ['task-1'],
      totalChats: 1,
    },
    onTaskAwareActionCancelAndContinue: vi.fn(),
    onTaskAwareActionClose: vi.fn(),
    ...overrides,
  };
  render(<SidebarDialogs {...props} />);
  return props;
}

describe('SidebarDialogs', () => {
  describe('delete operation', () => {
    it('does not show keep-running button', () => {
      renderDialogs();
      expect(screen.queryByText('Delete only')).toBeNull();
    });

    it('shows correct title and description', () => {
      renderDialogs();
      expect(screen.getByText('This chat has a linked task')).toBeTruthy();
      expect(
        screen.getByText(
          'Deleting this chat will also stop and remove the linked task. This cannot be undone.',
        ),
      ).toBeTruthy();
    });

    it('triggers cancel-and-continue callback', () => {
      const props = renderDialogs();
      fireEvent.click(screen.getByText('Stop task + delete'));
      expect(props.onTaskAwareActionCancelAndContinue).toHaveBeenCalledTimes(1);
    });

    it('shows batch title and description for delete_batch', () => {
      renderDialogs({
        taskAwareActionDialog: {
          open: true,
          mode: 'batch',
          operation: 'delete_batch',
          taskIds: ['task-1', 'task-2'],
          totalChats: 5,
        },
      });
      expect(screen.getByText('Delete 5 chats?')).toBeTruthy();
      expect(screen.getByText('2 linked tasks will also be stopped and removed.')).toBeTruthy();
    });

    it('shows only back and destructive buttons for delete_batch', () => {
      renderDialogs({
        taskAwareActionDialog: {
          open: true,
          mode: 'batch',
          operation: 'delete_batch',
          taskIds: ['task-1'],
          totalChats: 2,
        },
      });
      expect(screen.getByText('Back')).toBeTruthy();
      expect(screen.getByText('Stop task + delete')).toBeTruthy();
      expect(screen.queryByText('Delete chats only')).toBeNull();
    });
  });
});
