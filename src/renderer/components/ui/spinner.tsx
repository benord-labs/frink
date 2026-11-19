import { Loader2 } from 'lucide-react';
import type { ReactElement } from 'react';
import { cn } from '../../lib/utils';

/** Loading spinner sized by `className`. The rotation sits on an HTML box, not the svg,
 *  so the compositor can run it when the page is zoomed. */
export function Spinner({ className }: { className?: string }): ReactElement {
  return (
    <span aria-hidden className={cn('inline-flex shrink-0 motion-safe:animate-spin', className)}>
      <Loader2 className="size-full" />
    </span>
  );
}
