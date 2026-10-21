import { Button } from '@benord-labs/frink-primitives';
import type { ReactElement } from 'react';
import { BUTTON_SHADOW } from '../../../lib/button-shadow';
import { cn } from '../../../lib/utils';
import { PRIMARY_CTA } from '../connect-account-shell';

type SignInState = 'idle' | 'waiting' | 'failed';

/** Starts a provider's own browser sign-in, then waits for it with a way out. */
export function SignInWaitingCard({
  name,
  state,
  onStart,
  onCancel,
}: {
  /** What the person signs in with, such as "Claude". */
  name: string;
  state: SignInState;
  onStart: () => void;
  onCancel: () => void;
}): ReactElement {
  return (
    <div aria-live="polite" className="space-y-2">
      {state === 'waiting' ? (
        <div className="p-4 rounded-lg border border-border space-y-3">
          <p className="text-sm text-foreground">
            Finish signing in in your browser. This page updates when you're done.
          </p>
          <p className="text-xs text-muted-foreground">Frink never sees your password.</p>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onCancel} className="min-h-[44px] rounded-lg">
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <Button onClick={onStart} className={cn(PRIMARY_CTA, BUTTON_SHADOW)}>
            Sign in with {name}
          </Button>
          {state === 'failed' && (
            <p className="text-sm text-destructive">Sign-in didn't finish. Try again.</p>
          )}
        </>
      )}
    </div>
  );
}
