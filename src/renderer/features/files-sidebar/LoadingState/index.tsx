import type { ReactElement } from 'react';
import { memo } from 'react';
import { Loader2 } from 'lucide-react';

export const LoadingState = memo(function LoadingState(): ReactElement {
  return (
    <div className="flex items-center justify-center py-8 text-muted-foreground/60">
      <Loader2 className="h-4 w-4 animate-spin" />
    </div>
  );
});
