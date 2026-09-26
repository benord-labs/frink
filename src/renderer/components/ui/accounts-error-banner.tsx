import { Button } from '@benord-labs/frink-primitives';
import type { ReactNode } from 'react';

type AccountsErrorBannerProps = {
  /** Context-specific copy (each caller explains what degrades while the load is failing). */
  message: ReactNode;
  onRetry?: () => void;
};

/**
 * Inline "could not load accounts" alert with a Retry action. Shared by the accounts list
 * and the models section; each supplies its own message.
 */
export function AccountsErrorBanner({ message, onRetry }: AccountsErrorBannerProps) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between px-4 py-3 border-b border-border bg-destructive/10 text-sm text-destructive"
    >
      <span>{message}</span>
      {onRetry ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10"
          onClick={() => {
            void onRetry();
          }}
        >
          Retry
        </Button>
      ) : null}
    </div>
  );
}
