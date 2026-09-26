import { buttonVariants } from '@benord-labs/frink-primitives';
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
} from './alert-dialog';

type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  title: string;
  description: string;
  /** Label for the destructive action. Defaults to "Delete". */
  confirmLabel?: string;
  /**
   * Focus target after the dialog closes. Supply this when confirming unmounts the trigger,
   * otherwise Radix falls back to document.body and keyboard users lose their place.
   */
  onCloseAutoFocus?: (event: Event) => void;
};

/**
 * Destructive-action confirmation. Used for irreversible operations in place of a native prompt.
 *
 * `AlertDialogAction` closes the dialog itself, so `onConfirm` must not also drive `onOpenChange`.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  description,
  confirmLabel = 'Delete',
  onCloseAutoFocus,
}: ConfirmDialogProps): ReactElement {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: 'destructive' })}
            onClick={onConfirm}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
