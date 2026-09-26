import type { ReactElement, ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../../../../components/ui/dialog';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
};

export function TriggerDialogShell({ open, onOpenChange, title, children }: Props): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[96vw] sm:w-[92vw] lg:w-[86vw] xl:w-[1100px] max-w-[1100px] p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 py-4 border-b border-border">
          <DialogTitle className="text-base">{title}</DialogTitle>
          <DialogDescription className="sr-only">
            Review the full source content captured for this queued task.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[85vh] overflow-y-auto px-5 py-4 space-y-4">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
