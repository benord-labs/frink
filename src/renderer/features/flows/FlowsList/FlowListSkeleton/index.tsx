import type { ReactElement } from 'react';
import { Skeleton } from '../../../../components/ui/skeleton';
import { cn } from '../../../../lib/utils';
import { FLOW_ROW_GRID } from '../FlowListRow';

/** The loading state drawn on the row anatomy, so nothing moves when the flows arrive. */
export function FlowListSkeleton(): ReactElement {
  return (
    <div aria-hidden>
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className={cn(FLOW_ROW_GRID, 'grid-rows-[1.25rem_1rem] items-center')}>
          <Skeleton className="size-3.5 rounded-full bg-accent" />
          <Skeleton className="h-3.5 w-48 max-w-full bg-accent" />
          <Skeleton className="col-start-4 h-3 w-12 justify-self-end bg-accent" />
          <Skeleton className="col-span-3 col-start-2 row-start-2 h-3 w-80 max-w-full bg-accent" />
        </div>
      ))}
    </div>
  );
}
