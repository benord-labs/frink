/**
 * The body of a searchable picker: one search row and one virtualised listbox. It owns neither
 * the trigger nor a row's contents, so each picker renders its own row inside the positioned slot.
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import { type ReactNode, useEffect, useRef } from 'react';
import { Search } from 'lucide-react';

type Props<T> = {
  items: T[];
  itemKey: (item: T) => string;
  rowHeight: number;
  maxHeight: number;
  overscan: number;
  /** The containing popover's open state; the list re-measures when it opens. */
  open: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  searchPlaceholder: string;
  searchLabel: string;
  listLabel: string;
  emptyText: string;
  /** Rendered inside the search row after the input (e.g. a create button). */
  searchAdornment?: ReactNode;
  renderRow: (item: T) => ReactNode;
};

export function VirtualSearchList<T>({
  items,
  itemKey,
  rowHeight,
  maxHeight,
  overscan,
  open,
  query,
  onQueryChange,
  searchPlaceholder,
  searchLabel,
  listLabel,
  emptyText,
  searchAdornment,
  renderRow,
}: Props<T>): ReactNode {
  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => rowHeight,
    overscan,
    enabled: open,
  });
  useEffect(() => {
    if (open) virtualizer.measure();
  }, [open, virtualizer]);

  return (
    <>
      {/* Search row — input-adjacent surface (globals: --input-background) */}
      <div className="mx-1 my-1 flex h-8 items-center gap-1.5 rounded-md border border-border/60 bg-input-background/50 px-2">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          type="text"
          placeholder={searchPlaceholder}
          aria-label={searchLabel}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-hidden placeholder:text-muted-foreground/70 focus-visible:outline-hidden"
        />
        {searchAdornment}
      </div>
      {items.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">{emptyText}</div>
      ) : (
        <div
          ref={listRef}
          className="overflow-auto py-1 scrollbar-hide"
          role="listbox"
          aria-label={listLabel}
          style={{ height: Math.min(items.length * rowHeight + 8, maxHeight) }}
        >
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((row) => {
              const item = items[row.index];
              if (!item) return null;
              return (
                <div
                  key={itemKey(item)}
                  className="absolute left-0 top-0 mx-1 w-[calc(100%-8px)]"
                  style={{ height: `${row.size}px`, transform: `translateY(${row.start}px)` }}
                >
                  {renderRow(item)}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
