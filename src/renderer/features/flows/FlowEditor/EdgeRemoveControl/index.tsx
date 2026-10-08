/**
 * Two-step remove for a canvas edge: an × that turns into "Remove? ✓ ✗".
 */

import { Button } from '@benord-labs/frink-primitives';
import { Check, X } from 'lucide-react';
import type { MouseEvent, ReactElement } from 'react';

type EdgeRemoveControlProps = {
  /** What the edge is called: a flow canvas connection, or a batch plan dependency. */
  noun: 'connection' | 'dependency';
  pending: boolean;
  onPendingChange: (pending: boolean) => void;
  onConfirm: () => void;
};

const BUTTON_CLASS = 'h-7 w-7 rounded-[5px]';

/** The canvas must not see the press, or it would select or pan instead. */
function stopCanvas(e: { stopPropagation: () => void }): void {
  e.stopPropagation();
}

export function EdgeRemoveControl({
  noun,
  pending,
  onPendingChange,
  onConfirm,
}: EdgeRemoveControlProps): ReactElement {
  const settle = (e: MouseEvent, confirmed: boolean): void => {
    e.stopPropagation();
    onPendingChange(false);
    if (confirmed) onConfirm();
  };

  if (!pending) {
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className={`${BUTTON_CLASS} text-muted-foreground hover:text-destructive`}
        aria-label={`Remove this ${noun}`}
        onPointerDown={stopCanvas}
        onClick={(e) => {
          e.stopPropagation();
          onPendingChange(true);
        }}
        iconOnly
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </Button>
    );
  }

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="flex items-center gap-0.5">
      <span className="px-1.5 text-xs text-muted-foreground select-none">Remove?</span>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className={`${BUTTON_CLASS} text-destructive hover:text-destructive`}
        aria-label={`Confirm remove ${noun}`}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        onPointerDown={stopCanvas}
        onClick={(e) => settle(e, true)}
        iconOnly
      >
        <Check className="h-3.5 w-3.5" aria-hidden />
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className={`${BUTTON_CLASS} text-muted-foreground hover:text-foreground`}
        aria-label={`Cancel remove ${noun}`}
        onPointerDown={stopCanvas}
        onClick={(e) => settle(e, false)}
        iconOnly
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </div>
  );
}
