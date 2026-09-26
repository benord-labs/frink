import { Button } from '@benord-labs/frink-primitives';
import { cn } from '../../../../../../lib/utils';
import type { FanOutLaneStatus } from '../derive-result-status';

export type StatusFilter = 'all' | FanOutLaneStatus;

type StatusChipProps = {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
};

function StatusChip({ label, count, active, onClick }: StatusChipProps) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className={cn(
        'h-auto gap-1 rounded px-1.5 py-0.5 text-[10px]',
        active
          ? 'bg-primary/15 text-primary hover:bg-primary/15 hover:text-primary'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
      <span
        className={cn(
          'rounded-full px-1 py-px text-[9px] tabular-nums',
          active ? 'bg-primary/20' : 'bg-muted',
        )}
      >
        {count}
      </span>
    </Button>
  );
}

type StatusFilterBarProps = {
  counts: Record<StatusFilter, number>;
  active: StatusFilter;
  onChange: (f: StatusFilter) => void;
};

export function StatusFilterBar({ counts, active, onChange }: StatusFilterBarProps) {
  const chips: { id: StatusFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'passed', label: 'Passed' },
    { id: 'failed', label: 'Failed' },
    { id: 'skipped', label: 'Skipped' },
    { id: 'unknown', label: 'Unknown' },
  ];

  return (
    <div className="flex flex-wrap gap-1">
      {chips.map(({ id, label }) => (
        <StatusChip
          key={id}
          label={label}
          count={counts[id]}
          active={active === id}
          onClick={() => onChange(id)}
        />
      ))}
    </div>
  );
}
