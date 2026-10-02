import { type ReactElement, type RefObject, useMemo } from 'react';
import { type ConfirmOptions, useConfirm } from '../../../../components/ui/use-confirm';
import { STRINGS } from '../constants';

const plural = (count: number): string => (count === 1 ? '' : 's');

function chatDeleteCopy(
  chatName: string | null | undefined,
  focusAfterClose: RefObject<HTMLElement | null>,
): ConfirmOptions {
  return {
    title: `Delete "${chatName || STRINGS.UNTITLED_CHAT}" permanently?`,
    description: 'The chat, its history and its worktree will be removed.',
    // Confirming unmounts the trigger row, so focus is handed to a surviving element.
    onCloseAutoFocus: (event) => {
      event.preventDefault();
      focusAfterClose.current?.focus();
    },
  };
}

function projectDeleteCopy(chatCount: number): ConfirmOptions {
  return {
    title:
      chatCount > 0
        ? `Delete this project and ${chatCount} chat${plural(chatCount)}?`
        : 'Delete this project?',
    description: 'This cannot be undone.',
  };
}

function folderChatsDeleteCopy(chatCount: number): ConfirmOptions {
  return {
    title: `Delete ${chatCount} unpinned chat${plural(chatCount)} in this folder?`,
    description:
      'Pinned chats stay in the sidebar. Only active (non-archived) chats are included. This cannot be undone.',
  };
}

/** Running flow runs are named in the one prompt rather than in a second prompt of their own. */
function batchDeleteCopy(
  chatCount: number,
  batch: { flow_name: string; running_count: number },
): ConfirmOptions {
  const running = batch.running_count;
  return {
    title: `Delete all ${chatCount} chat${plural(chatCount)} from batch "${batch.flow_name}"?`,
    description:
      running > 0
        ? `${running} running flow run${plural(running)} will be stopped and all results removed. This cannot be undone.`
        : 'This cannot be undone.',
  };
}

export type DeleteConfirm = {
  chat: (
    chatName: string | null | undefined,
    focusAfterClose: RefObject<HTMLElement | null>,
  ) => Promise<boolean>;
  project: (chatCount: number) => Promise<boolean>;
  folderChats: (chatCount: number) => Promise<boolean>;
  batch: (
    chatCount: number,
    batch: { flow_name: string; running_count: number },
  ) => Promise<boolean>;
};

/**
 * The sidebar's in-app confirm for tree, project, folder and batch deletes; true only on accept.
 * The archived list keeps its own dialog. Render `confirmDialog` once.
 */
export function useDeleteConfirm(): { askDelete: DeleteConfirm; confirmDialog: ReactElement } {
  const { confirm, confirmDialog } = useConfirm();
  const askDelete = useMemo<DeleteConfirm>(
    () => ({
      chat: (chatName, focusAfterClose) => confirm(chatDeleteCopy(chatName, focusAfterClose)),
      project: (chatCount) => confirm(projectDeleteCopy(chatCount)),
      folderChats: (chatCount) => confirm(folderChatsDeleteCopy(chatCount)),
      batch: (chatCount, batch) => confirm(batchDeleteCopy(chatCount, batch)),
    }),
    [confirm],
  );
  return { askDelete, confirmDialog };
}
