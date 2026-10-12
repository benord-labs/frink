import { Button } from '@benord-labs/frink-primitives';
import { type LucideIcon, Play, RotateCcw } from 'lucide-react';
import { useRef } from 'react';
import { SideEffectsConfirm } from '../../../../components/SideEffectsConfirm';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../components/ui/tooltip';
import { RunStatusRow } from '../../RunStatusRow';

type RecoverRowProps = {
  /** Retry re-runs the step from its instructions; otherwise Continue picks up the session. */
  isRetry: boolean;
  pending: boolean;
  /** The side-effects confirm is open for the run this row shows. */
  confirming: boolean;
  /** Button click: the parent either recovers straight away or opens the confirm. */
  onTrigger: () => void;
  onConfirm: () => void;
  onCancel: () => void;
};

type RecoverCopy = { Icon: LucideIcon; label: string; ariaLabel: string; tooltip: string };

function recoverCopy(isRetry: boolean, pending: boolean): RecoverCopy {
  if (isRetry) {
    return {
      Icon: RotateCcw,
      label: pending ? 'Retrying…' : 'Retry',
      ariaLabel: 'Retry the interrupted step',
      tooltip: 'Retry runs this step again from its instructions, in the same chat and worktree.',
    };
  }
  return {
    Icon: Play,
    label: pending ? 'Continuing…' : 'Continue',
    ariaLabel: 'Continue the interrupted flow run',
    tooltip:
      'Continue picks up where the agent stopped — same chat and worktree, no repeated instructions. Typing a message also continues it.',
  };
}

/** The interrupted run's Continue/Retry button, plus the side-effects confirm a started step needs. */
export function RecoverRow({
  isRetry,
  pending,
  confirming,
  onTrigger,
  onConfirm,
  onCancel,
}: RecoverRowProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { Icon, label, ariaLabel, tooltip } = recoverCopy(isRetry, pending);
  return (
    <>
      <RunStatusRow dotClassName="bg-[hsl(var(--status-warning))]" label="Flow run interrupted">
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            {/* span keeps the tooltip alive while the button is disabled (disabled elements
                don't fire pointer events). */}
            <span className="inline-flex">
              <Button
                ref={triggerRef}
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 gap-1 text-xs text-muted-foreground hover:text-foreground rounded-md"
                disabled={pending}
                onClick={onTrigger}
                aria-label={ariaLabel}
                aria-busy={pending || undefined}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
                <span>{label}</span>
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      </RunStatusRow>
      {confirming ? (
        <div className="px-2 relative z-10">
          <SideEffectsConfirm
            className="w-full max-w-2xl mx-auto px-3 py-2 mb-1 glass-float rounded-xl border border-border"
            pending={pending}
            onConfirm={onConfirm}
            onCancel={onCancel}
            returnFocusRef={triggerRef}
          />
        </div>
      ) : null}
    </>
  );
}
