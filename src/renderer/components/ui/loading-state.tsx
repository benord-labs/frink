import { memo, type ReactElement } from 'react';
import { Spinner } from './spinner';

type Props = {
  message?: string;
  className?: string;
};

export const LoadingState = memo(function LoadingState({
  message = 'Loading...',
  className = '',
}: Props): ReactElement {
  return (
    <div
      className={`bg-background rounded-lg border border-border p-4 text-sm text-muted-foreground text-center ${className}`}
    >
      <Spinner className="flex h-6 w-6 text-muted-foreground/50 mx-auto mb-2" />
      {message}
    </div>
  );
});
