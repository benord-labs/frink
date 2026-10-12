import { Button } from '@benord-labs/frink-primitives';
import { Loader2, Play, RotateCcw } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import type { DbFlowRunWithNodeRuns } from '../../../../../../shared/types/flow-run';
import type { RecoveryKind } from '../../../../../../shared/types/flow-run/resume';
import { SideEffectsConfirm } from '../../../../../components/SideEffectsConfirm';
import { trpc } from '../../../../../lib/trpc';

type RecoverInterruptedActionProps = {
  flowId: string;
  run: DbFlowRunWithNodeRuns;
};

/**
 * The one recovery button of a run cancelled by an app restart (only those report `recoveries`):
 * Continue resumes the answering session; Retry re-runs, confirming first for a started non-agent.
 */
export function RecoverInterruptedAction({ flowId, run }: RecoverInterruptedActionProps) {
  const utils = trpc.useUtils();
  const recovery = run.recoveries?.[0];
  // Keyed on run + step + kind: the panel reuses this across runs; a confirm is for one Retry.
  const confirmTarget = `${run.id}:${recovery?.nodeRunId}:${recovery?.kind}`;
  const [confirmingFor, setConfirmingFor] = useState<string | null>(null);
  // Another run, step or kind drops the confirmation, so returning never reopens it.
  if (confirmingFor !== null && confirmingFor !== confirmTarget) setConfirmingFor(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Set on submit, so a second click before `isPending` renders cannot send a second request.
  const inFlight = useRef(false);
  const mutation = trpc.flows.retryRunFromLastNode.useMutation({
    onSuccess: () => {
      setConfirmingFor(null);
      toast.success('Picking up from the interrupted step');
    },
    onError: (err) => {
      toast.error(err.message || 'Could not recover the run');
    },
    // Awaited, so the button stays disabled until the refetched run replaces this one's label.
    onSettled: (_data, _err, variables) => {
      inFlight.current = false;
      return Promise.all([
        utils.flows.listRuns.invalidate({ flowId }),
        utils.flows.list.invalidate(),
        utils.flows.get.invalidate({ id: flowId }),
        utils.flows.getRun.invalidate({ runId: variables.runId }),
      ]);
    },
  });
  if (!recovery) return null;

  const isContinue = recovery.kind === 'continue';
  // The confirm only ever retries, so a refresh mid-confirmation can't turn it into a Continue.
  const recover = (kind: RecoveryKind) => {
    if (inFlight.current) return;
    inFlight.current = true;
    mutation.mutate({ runId: run.id, kind });
  };
  return (
    <div className="mt-2 space-y-1.5 border-t border-border/35 pt-2">
      <Button
        ref={triggerRef}
        type="button"
        size="sm"
        variant="secondary"
        className="h-6 gap-1 text-[11px]"
        disabled={mutation.isPending}
        onClick={() =>
          recovery.confirmSideEffects && !isContinue
            ? setConfirmingFor(confirmTarget)
            : recover(recovery.kind)
        }
      >
        {mutation.isPending ? (
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        ) : isContinue ? (
          <Play className="h-3 w-3" aria-hidden />
        ) : (
          <RotateCcw className="h-3 w-3" aria-hidden />
        )}
        {isContinue ? 'Continue' : 'Retry'}
      </Button>
      {confirmingFor === confirmTarget ? (
        <SideEffectsConfirm
          pending={mutation.isPending}
          onConfirm={() => recover('retry')}
          onCancel={() => setConfirmingFor(null)}
          returnFocusRef={triggerRef}
        />
      ) : null}
    </div>
  );
}
