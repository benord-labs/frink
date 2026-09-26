/**
 * SidebarDialogs - Rename and task-aware action dialogs
 */

import { Button } from '@benord-labs/frink-primitives';
import { memo, type ReactElement } from 'react';
import { RenameDialog } from '../../../../../components/rename-dialog';
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../../../components/ui/alert-dialog';
import type { TaskAwareActionDialogState } from '../../types';

type SidebarDialogsProps = {
  chatToRename: { id: string; name: string } | null;
  onChatRenameClose: () => void;
  onChatRenameConfirm: (newName: string) => Promise<void>;
  // Project rename — sibling of the chat-rename props, same shared RenameDialog, different entity.
  projectToRename: { id: string; name: string } | null;
  onProjectRenameClose: () => void;
  onProjectRenameConfirm: (newName: string) => Promise<void>;
  isNewFolderDialogOpen: boolean;
  onNewFolderClose: () => void;
  onNewFolderConfirm: (name: string) => Promise<void>;
  taskAwareActionDialog: Omit<TaskAwareActionDialogState, 'chatIds'>;
  onTaskAwareActionKeepRunning: () => void;
  onTaskAwareActionCancelAndContinue: () => void;
  onTaskAwareActionClose: () => void;
};

function SidebarDialogsComponent({
  chatToRename,
  onChatRenameClose,
  onChatRenameConfirm,
  projectToRename,
  onProjectRenameClose,
  onProjectRenameConfirm,
  isNewFolderDialogOpen,
  onNewFolderClose,
  onNewFolderConfirm,
  taskAwareActionDialog,
  onTaskAwareActionKeepRunning,
  onTaskAwareActionCancelAndContinue,
  onTaskAwareActionClose,
}: SidebarDialogsProps): ReactElement {
  const isBatch = taskAwareActionDialog.mode === 'batch';
  const isArchiveAction = taskAwareActionDialog.operation.startsWith('archive');
  const isDeleteAction = !isArchiveAction;
  const taskCount = taskAwareActionDialog.taskIds.length;
  const taskPlural = taskCount === 1 ? '' : 's';

  const continueLabel = isArchiveAction
    ? 'Archive only'
    : isBatch
      ? 'Delete chats only'
      : 'Delete only';
  const cancelAndContinueLabel = isArchiveAction ? 'Stop task + archive' : 'Stop task + delete';

  const title = isDeleteAction
    ? isBatch
      ? `Delete ${taskAwareActionDialog.totalChats} chats?`
      : 'This chat has a linked task'
    : `Before you archive ${isBatch ? `${taskAwareActionDialog.totalChats} chats` : 'this chat'}`;

  const description = isDeleteAction
    ? isBatch
      ? `${taskCount} linked task${taskPlural} will also be stopped and removed.`
      : 'Deleting this chat will also stop and remove the linked task. This cannot be undone.'
    : `${isBatch ? 'These chats are' : 'This chat is'} linked to ${taskCount} running or pending task${taskPlural}.`;

  const bodyCopy = isDeleteAction
    ? null
    : 'Keep task running is the safe default. Stop it first only if you want to cancel the linked task before this action.';

  return (
    <>
      {/* Rename Dialog — chat */}
      <RenameDialog
        isOpen={!!chatToRename}
        onClose={onChatRenameClose}
        onSave={onChatRenameConfirm}
        currentName={chatToRename?.name ?? ''}
        title="Rename chat"
        placeholder="Chat name"
      />

      {/* Rename Dialog — project (same component, different entity) */}
      <RenameDialog
        isOpen={!!projectToRename}
        onClose={onProjectRenameClose}
        onSave={onProjectRenameConfirm}
        currentName={projectToRename?.name ?? ''}
        title="Rename project"
        placeholder="Project name"
      />

      {/* New Folder Dialog */}
      <RenameDialog
        isOpen={isNewFolderDialogOpen}
        onClose={onNewFolderClose}
        onSave={onNewFolderConfirm}
        currentName=""
        title="Create new folder"
        placeholder="Folder name"
      />

      <AlertDialog
        open={taskAwareActionDialog.open}
        onOpenChange={(open) => {
          if (!open) onTaskAwareActionClose();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          {bodyCopy && (
            <AlertDialogBody className="text-sm text-muted-foreground">
              <p>{bodyCopy}</p>
            </AlertDialogBody>
          )}
          <AlertDialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <AlertDialogCancel onClick={onTaskAwareActionClose}>Back</AlertDialogCancel>
            {isArchiveAction && (
              <Button variant="secondary" onClick={onTaskAwareActionKeepRunning}>
                {continueLabel}
              </Button>
            )}
            <Button variant="destructive" onClick={onTaskAwareActionCancelAndContinue}>
              {cancelAndContinueLabel}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export const SidebarDialogs = memo(SidebarDialogsComponent);
