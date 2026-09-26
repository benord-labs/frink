import { cn } from '../../../lib/utils';

type LoopIterationBadgeProps = {
  loopIteration: number;
  loopTotalCount?: number;
  /** Canvas node chip vs compact Run History row. */
  variant: 'canvas' | 'panel';
};

/**
 * Fan-out loop progress `#N` or `#N/T` with accessible name and polite live updates.
 */
export function LoopIterationBadge({
  loopIteration,
  loopTotalCount,
  variant,
}: LoopIterationBadgeProps) {
  const n = loopIteration + 1;
  const visible = loopTotalCount != null ? `#${n}/${loopTotalCount}` : `#${n}`;
  const label = loopTotalCount != null ? `Iteration ${n} of ${loopTotalCount}` : `Iteration ${n}`;

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={label}
      className={cn(
        'shrink-0 rounded-full bg-primary font-bold text-primary-foreground',
        variant === 'canvas' && 'self-start px-2 py-0.5 text-[11px] shadow-xs',
        variant === 'panel' && 'px-1.5 py-0.5 text-[10px]',
      )}
    >
      {visible}
    </span>
  );
}
