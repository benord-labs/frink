import { Loader2 } from 'lucide-react';
import { memo, type ReactElement } from 'react';

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
      <Loader2 className="h-6 w-6 text-muted-foreground/50 mx-auto mb-2 animate-spin" />
      {message}
    </div>
  );
});
