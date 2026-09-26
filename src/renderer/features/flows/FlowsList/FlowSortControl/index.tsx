import { ArrowUpDown } from 'lucide-react';
import type { ReactElement } from 'react';
import { cn } from '../../../../lib/utils';

export type FlowSortOrder = 'updated_at' | 'name';

const SORT_OPTIONS: { value: FlowSortOrder; label: string }[] = [
  { value: 'updated_at', label: 'Updated' },
  { value: 'name', label: 'Name' },
];

type FlowSortControlProps = {
  sortOrder: FlowSortOrder;
  onSortChange: (order: FlowSortOrder) => void;
};

/** Sits in the toolbar beside search, so it stays put while the list scrolls or regroups. */
export function FlowSortControl({ sortOrder, onSortChange }: FlowSortControlProps): ReactElement {
  return (
    <div
      role="group"
      aria-label="Sort flows"
      className="flex h-8 shrink-0 items-center gap-0.5 rounded-[var(--field-radius)] border border-field-border bg-field p-0.5"
    >
      <ArrowUpDown className="mx-1.5 size-3.5 text-muted-foreground" aria-hidden />
      {SORT_OPTIONS.map((option) => {
        const active = sortOrder === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onSortChange(option.value)}
            className={cn(
              'h-full cursor-pointer rounded-[7px] px-2.5 text-xs transition-colors duration-150 ease-out',
              'outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'bg-accent text-foreground dark:bg-foreground/10'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
