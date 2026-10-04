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
} from '../../../../components/ui/alert-dialog';

type StaleVersionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Drop local edits and load the latest version. */
  onReload: () => void;
  /** Save the working copy over the latest version. */
  onOverwrite: () => void;
};

/** Shown when Save is refused because the flow moved on since this editor loaded it. */
export function StaleVersionDialog({
  open,
  onOpenChange,
  onReload,
  onOverwrite,
}: StaleVersionDialogProps): ReactElement {
  // Close explicitly: the actions run async work, and the modal must not sit over its result.
  const closeThen = (action: () => void) => () => {
    onOpenChange(false);
    action();
  };
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Flow modified elsewhere</AlertDialogTitle>
          <AlertDialogDescription>
            This flow was modified from another location. Reload the latest version and lose your
            unsaved edits, or overwrite it with your version.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep my edits</AlertDialogCancel>
          <AlertDialogAction onClick={closeThen(onOverwrite)}>
            Overwrite with mine
          </AlertDialogAction>
          <AlertDialogAction onClick={closeThen(onReload)}>Reload latest</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
