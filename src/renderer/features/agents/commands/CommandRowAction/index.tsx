import { Button } from '@benord-labs/frink-primitives';
import type { ReactElement, ReactNode } from 'react';

/** Hover-revealed icon action on a dropdown row. Mousedown, not click: the row selects on mousedown. */
export function CommandRowAction({
  label,
  title,
  icon,
  onRun,
}: {
  label: string;
  title?: string;
  icon: ReactNode;
  onRun: () => void;
}): ReactElement {
  return (
    <Button
      variant="ghost"
      size="icon"
      tabIndex={-1}
      aria-label={label}
      title={title}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onRun();
      }}
      className="shrink-0 flex opacity-0 group-hover:opacity-100 transition-opacity ml-1 rounded"
    >
      {icon}
    </Button>
  );
}
