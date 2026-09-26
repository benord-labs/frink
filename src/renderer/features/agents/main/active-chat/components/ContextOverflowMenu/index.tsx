/**
 * The "more" control of a chat context row: controls that no longer fit inline move here, each on
 * a labelled row and each still the same picker. The ellipsis trigger never reads as a chip.
 */

import { Button } from '@benord-labs/frink-primitives';
import { Ellipsis } from 'lucide-react';
import { forwardRef, type ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export type OverflowRow = { key: string; name: string; node: ReactNode };

type ContextOverflowMenuProps = { rows: OverflowRow[] };

export const ContextOverflowMenu = forwardRef<HTMLButtonElement, ContextOverflowMenuProps>(
  function ContextOverflowMenu({ rows }, ref) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            ref={ref}
            variant="ghost"
            size="sm"
            className="h-6 w-6 shrink-0 rounded-md p-0"
            aria-label={`More: ${rows.map((row) => row.name).join(', ')}`}
          >
            <Ellipsis className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-1">
          {rows.map((row) => (
            <div
              key={row.key}
              className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 px-2 py-1"
            >
              <span className="text-xs text-muted-foreground">{row.name}</span>
              <div className="flex min-w-0">{row.node}</div>
            </div>
          ))}
        </PopoverContent>
      </Popover>
    );
  },
);
