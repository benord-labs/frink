import { Button } from '@benord-labs/frink-primitives';
import { Target } from 'lucide-react';
import type { ReactElement } from 'react';
import type { ActiveGoal } from '../../../../lib/commands/goal';
import { cn } from '../../../../lib/utils';

type GoalCardProps = {
  goal: ActiveGoal;
  isStreaming: boolean;
  hasCardAbove: boolean;
  onClear: () => void;
};

/** The goal Claude keeps working toward. Clear only while idle: a running turn stops via Stop. */
export function GoalCard({
  goal,
  isStreaming,
  hasCardAbove,
  onClear,
}: GoalCardProps): ReactElement {
  const detail = isStreaming
    ? goal.lastCheck
      ? `Not there yet: ${goal.lastCheck}`
      : 'Keeps working until this is true'
    : 'Paused. Your next message picks it back up.';
  return (
    <div
      data-stacked-card
      className={cn(
        'border border-border glass-float border-b-0 flex items-center gap-2 pl-3 pr-1 py-1.5',
        hasCardAbove ? 'rounded-none' : 'rounded-t-2xl',
      )}
    >
      <Target className="w-4 h-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1 text-xs">
        <p className="truncate text-foreground" title={goal.objective}>
          Goal: {goal.objective}
        </p>
        <p className="truncate text-muted-foreground" title={detail}>
          {detail}
        </p>
      </div>
      {!isStreaming && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          className="h-6 px-2 text-xs font-normal rounded-md shrink-0 transition-transform duration-150 active:scale-[0.97]"
        >
          Clear goal
        </Button>
      )}
    </div>
  );
}
