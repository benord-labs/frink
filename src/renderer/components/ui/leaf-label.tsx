/**
 * Finder-style name truncation: the namespace before the last "/" shrinks first ("benji…/leaf"),
 * the leaf only when too wide alone, and never below 4ch, since "i…" carries nothing.
 */

import { cn } from '@/lib/utils';

type LeafLabelProps = {
  text: string;
  className?: string;
};

export function LeafLabel({ text, className }: LeafLabelProps) {
  const split = text.lastIndexOf('/') + 1;
  const prefix = text.slice(0, split);
  const leaf = text.slice(split);
  return (
    <span className={cn('flex min-w-[4ch]', className)}>
      {prefix ? <span className="min-w-0 truncate">{prefix}</span> : null}
      <span className="max-w-full shrink-0 truncate">{leaf}</span>
    </span>
  );
}
