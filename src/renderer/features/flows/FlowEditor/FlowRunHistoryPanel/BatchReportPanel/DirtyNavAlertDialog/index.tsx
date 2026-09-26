/**
 * Shared confirmation dialog for dirty-flow-editor navigation.
 * Used by BatchRunRowItem and BatchPlanCanvasInner via useDirtyNavGuard.
 */

import type { ReactElement } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../../../../components/ui/alert-dialog';

type DirtyNavAlertDialogProps = {
  showDialog: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function DirtyNavAlertDialog({
  showDialog,
  onConfirm,
  onCancel,
}: DirtyNavAlertDialogProps): ReactElement | null {
  if (!showDialog) return null;
  return (
    <AlertDialog open onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Leave the flow editor?</AlertDialogTitle>
          <AlertDialogDescription>
            Opening this chat closes the editor. Your unsaved edits are kept as a local draft and
            restored when you reopen this flow.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Open chat</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
