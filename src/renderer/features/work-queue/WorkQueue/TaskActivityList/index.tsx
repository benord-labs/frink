import type { ReactElement, ReactNode } from 'react';
import { useLoadedTaskDisclosure } from '../hooks';
import { LoadedTaskDisclosure } from '../LoadedTaskDisclosure';

type Props<Item> = {
  ariaLabel: string;
  emptyState?: ReactNode;
  heading: string;
  headingActions?: ReactNode;
  headingId: string;
  initialCount: number;
  itemLabel: string;
  items: Item[];
  renderItem: (item: Item) => ReactNode;
};

export function TaskActivityList<Item>({
  ariaLabel,
  emptyState,
  heading,
  headingActions,
  headingId,
  initialCount,
  itemLabel,
  items,
  renderItem,
}: Props<Item>): ReactElement | null {
  const { additionalItemCount, isExpanded, listId, toggleExpanded, visibleItems } =
    useLoadedTaskDisclosure(items, initialCount);
  if (items.length === 0 && emptyState == null) return null;

  return (
    <section aria-labelledby={headingId}>
      {headingActions == null ? (
        <h2 id={headingId} className="mb-1 text-[11px] text-muted-foreground">
          {heading}
        </h2>
      ) : (
        <div className="mb-2 flex min-h-6 items-center justify-between gap-3">
          <h2 id={headingId} className="text-[11px] text-muted-foreground">
            {heading}
          </h2>
          {headingActions}
        </div>
      )}
      {items.length === 0 ? (
        emptyState
      ) : (
        <>
          <ul id={listId} aria-label={ariaLabel}>
            {visibleItems.map(renderItem)}
          </ul>
          <LoadedTaskDisclosure
            additionalItemCount={additionalItemCount}
            isExpanded={isExpanded}
            itemLabel={itemLabel}
            listId={listId}
            onToggle={toggleExpanded}
          />
        </>
      )}
    </section>
  );
}
