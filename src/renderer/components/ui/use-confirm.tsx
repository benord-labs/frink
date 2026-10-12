import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from './confirm-dialog';

export type ConfirmOptions = {
  title: string;
  description: string;
  /** Label for the destructive action. Defaults to "Delete". */
  confirmLabel?: string;
  /** Focus target after the dialog closes; see ConfirmDialog. */
  onCloseAutoFocus?: (event: Event) => void;
};

type ConfirmApi = {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** Closes an open dialog as a Cancel, e.g. when what it asked about has changed. */
  dismiss: () => void;
  confirmDialog: ReactElement;
};

/**
 * Promise-based ConfirmDialog in place of `window.confirm`: true only when accepted, settled once.
 * Render `confirmDialog` once in the owning component.
 */
export function useConfirm(): ConfirmApi {
  // Options outlive `open` so the closing animation keeps its copy and the focus-return callback
  // (Radix calls onCloseAutoFocus after the dialog has closed).
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    resolve?.(confirmed);
  }, []);

  const confirm = useCallback(
    (next: ConfirmOptions) => {
      settle(false);
      setOptions(next);
      setOpen(true);
      return new Promise<boolean>((resolve) => {
        resolveRef.current = resolve;
      });
    },
    [settle],
  );

  const dismiss = useCallback(() => {
    settle(false);
    setOpen(false);
  }, [settle]);

  useEffect(() => () => settle(false), [settle]);

  const confirmDialog = (
    <ConfirmDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss();
      }}
      onConfirm={() => settle(true)}
      onCloseAutoFocus={options?.onCloseAutoFocus}
      title={options?.title ?? ''}
      description={options?.description ?? ''}
      confirmLabel={options?.confirmLabel}
    />
  );

  return { confirm, dismiss, confirmDialog };
}
