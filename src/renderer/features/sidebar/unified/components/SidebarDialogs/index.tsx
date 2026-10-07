/**
 * SidebarDialogs - Rename and task-aware action dialogs
 */

import { Button } from '@benord-labs/frink-primitives';
import { memo, type ReactElement } from 'react';
import { RenameDialog } from '../../../../../components/rename-dialog';
import {
  AlertDialog,
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
  onTaskAwareActionCancelAndContinue,
  onTaskAwareActionClose,
}: SidebarDialogsProps): ReactElement {
  const isBatch = taskAwareActionDialog.mode === 'batch';
  const taskCount = taskAwareActionDialog.taskIds.length;
  const taskPlural = taskCount === 1 ? '' : 's';

  const title = isBatch
    ? `Delete ${taskAwareActionDialog.totalChats} chats?`
    : 'This chat has a linked task';

  const description = isBatch
    ? `${taskCount} linked task${taskPlural} will also be stopped and removed.`
    : 'Deleting this chat will also stop and remove the linked task. This cannot be undone.';

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
          <AlertDialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <AlertDialogCancel onClick={onTaskAwareActionClose}>Back</AlertDialogCancel>
            <Button variant="destructive" onClick={onTaskAwareActionCancelAndContinue}>
              Stop task + delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export const SidebarDialogs = memo(SidebarDialogsComponent);
