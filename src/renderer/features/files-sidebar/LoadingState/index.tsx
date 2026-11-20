import type { ReactElement } from 'react';
import { memo } from 'react';
import { Spinner } from '../../../components/ui/spinner';

export const LoadingState = memo(function LoadingState(): ReactElement {
  return (
    <div className="flex items-center justify-center py-8 text-muted-foreground/60">
      <Spinner className="h-4 w-4" />
    </div>
  );
});
