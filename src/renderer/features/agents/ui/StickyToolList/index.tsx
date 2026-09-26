import type { ReactNode } from 'react';
import { cn } from '../../../../lib/utils';

/** A to-do or task list pinned under its turn's user message (z-10), if the turn shows one. While
 *  stuck each row wears `stuck:glass-float`, with the same hard glass edge as the pinned message. */
export function StickyToolList({ sticky, children }: { sticky: boolean; children: ReactNode }) {
  return (
    <div
      className={cn('mx-2', sticky && 'sticky z-5 [container-type:scroll-state]')}
      style={sticky ? { top: 'calc(var(--user-message-height, 28px) - 29px)' } : undefined}
    >
      {children}
    </div>
  );
}
