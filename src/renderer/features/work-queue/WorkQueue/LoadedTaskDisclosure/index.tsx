import { Button } from '@benord-labs/frink-primitives';
import type { ReactElement } from 'react';

type Props = {
  additionalItemCount: number;
  isExpanded: boolean;
  itemLabel: string;
  listId: string;
  onToggle: () => void;
};

export function LoadedTaskDisclosure({
  additionalItemCount,
  isExpanded,
  itemLabel,
  listId,
  onToggle,
}: Props): ReactElement | null {
  if (additionalItemCount === 0) return null;

  const pluralLabel = `${itemLabel}${additionalItemCount === 1 ? '' : 's'}`;

  return (
    <div className="mt-1 flex justify-end">
      <Button
        variant="ghost"
        size="xs"
        aria-controls={listId}
        aria-expanded={isExpanded}
        aria-label={
          isExpanded
            ? `Show fewer ${itemLabel}s`
            : `Show ${additionalItemCount} more ${pluralLabel}`
        }
        onClick={onToggle}
      >
        {isExpanded ? 'Show less' : `Show ${additionalItemCount} more`}
      </Button>
    </div>
  );
}
