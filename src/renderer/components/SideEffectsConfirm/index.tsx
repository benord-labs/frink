import { Button } from '@benord-labs/frink-primitives';
import { Loader2, RotateCcw } from 'lucide-react';
import { type ReactElement, type RefObject, useEffect, useRef } from 'react';
import { SIDE_EFFECTS_RETRY } from '../../../shared/lib/task-recovery/side-effects-confirm';
import { cn } from '../../lib/utils';
import type { ConfirmOptions } from '../ui/use-confirm';

/** The same ask as a useConfirm dialog, for a Retry that lives in a menu or a status row. */
export const SIDE_EFFECTS_CONFIRM: ConfirmOptions = {
  title: SIDE_EFFECTS_RETRY.title,
  description: SIDE_EFFECTS_RETRY.warning,
  confirmLabel: SIDE_EFFECTS_RETRY.confirmLabel,
};

type SideEffectsConfirmProps = {
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** The Retry trigger, so Cancel hands focus back to it. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
};

/**
 * One-time confirm before retrying a started non-agent step (command, request), since running it
 * again may repeat what it did. Agent steps never need it.
 */
export function SideEffectsConfirm({
  pending,
  onConfirm,
  onCancel,
  returnFocusRef,
  className,
}: SideEffectsConfirmProps): ReactElement {
  const confirmRef = useRef<HTMLButtonElement>(null);
  // Focus lands on the decision it asks for (WCAG 2.4.3).
  useEffect(() => confirmRef.current?.focus(), []);
  return (
    <div className={cn('space-y-1.5', className)} role="alert">
      <p className="text-[11px] text-muted-foreground">{SIDE_EFFECTS_RETRY.warning}</p>
      <div className="flex items-center gap-1.5">
        <Button
          ref={confirmRef}
          type="button"
          size="sm"
          variant="secondary"
          className="h-6 gap-1 text-[11px]"
          disabled={pending}
          onClick={onConfirm}
        >
          {pending ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          ) : (
            <RotateCcw className="h-3 w-3" aria-hidden />
          )}
          {SIDE_EFFECTS_RETRY.confirmLabel}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 text-[11px] text-muted-foreground"
          disabled={pending}
          onClick={() => {
            onCancel();
            returnFocusRef?.current?.focus();
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
