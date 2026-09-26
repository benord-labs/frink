import type { ReactElement } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../../../components/ui/alert-dialog';
import type { ExternalSideEffect } from '../../../lib/detect-external-side-effects';

export type PendingRollbackConfirm = {
  effects: ExternalSideEffect[];
  onConfirm: () => void;
};

type RollbackConfirmDialogProps = {
  pending: PendingRollbackConfirm | null;
  onCancel: () => void;
};

/**
 * Shown before a rollback that would discard turns which made external integration writes.
 * Rollback restores Frink's chat + worktree, but cannot undo those external changes — so we
 * confirm rather than silently leak the discrepancy. Prop-driven (mirrors DirtyNavAlertDialog).
 */
export function RollbackConfirmDialog({
  pending,
  onCancel,
}: RollbackConfirmDialogProps): ReactElement | null {
  if (!pending) return null;
  return (
    <AlertDialog open onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Roll back past external changes?</AlertDialogTitle>
          <AlertDialogDescription>
            Rollback restores this chat and its code, but won't undo external changes already made:
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogBody>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {pending.effects.map((effect) => (
              <li key={effect.label}>{effect.label}</li>
            ))}
          </ul>
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={pending.onConfirm}>Continue</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
