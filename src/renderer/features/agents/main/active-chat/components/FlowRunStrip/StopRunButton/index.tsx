/**
 * The terminal verb shared by both flow bottom surfaces. Stop combines `flows.cancelRun` with the
 * composer's turn abort (`onStopTurn`) because cancelRun alone does not stop the in-flight agent
 * turn, and it sits behind a two-step inline confirm.
 */
import { Button } from '@benord-labs/frink-primitives';
import { Loader2, Square } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '../../../../../../../lib/trpc';
import { invalidateTaskQueries } from '../../../utils';
import { StripAction } from '../FlowSurfaceCard';

export function StopRunButton({
  flowRunId,
  onStopTurn,
  onConfirmingChange,
}: {
  flowRunId: string;
  onStopTurn: () => Promise<void> | void;
  /**
   * Lets the card shed competing chrome while the destructive question is on screen. The confirm
   * pair is 206px measured and cannot share a narrow row with the readout and a second verb, and shortening
   * either word is not an option — an ✕ beside "Confirm stop" reads as "cancel the run".
   */
  onConfirmingChange: (confirming: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const [confirming, setConfirming] = useState(false);
  const arm = (next: boolean) => {
    setConfirming(next);
    onConfirmingChange(next);
  };
  const cancelRun = trpc.flows.cancelRun.useMutation({
    onSuccess: () => {
      toast.success('Flow run stopped');
      invalidateTaskQueries(utils);
      utils.flows.listRuns.invalidate();
      utils.flows.getRun.invalidate();
    },
    onError: (e) => toast.error(e.message || 'Could not stop the run'),
  });

  if (!confirming) {
    return (
      <StripAction
        label="Stop"
        title="Stop this flow run"
        icon={<Square className="h-3 w-3" aria-hidden />}
        onClick={() => arm(true)}
      />
    );
  }
  // The group is right-anchored, so "Keep running" — not "Confirm stop" — is what lands under a
  // cursor that just clicked Stop. A double-click cannot cancel a run.
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        type="button"
        size="sm"
        variant="destructive"
        className="h-7 gap-1 text-xs"
        disabled={cancelRun.isPending}
        onClick={() => {
          // Abort the local turn FIRST so Stop feels instant; cancelRun terminalizes the run.
          void onStopTurn();
          cancelRun.mutate({ runId: flowRunId });
          arm(false);
        }}
        title="Cancel this flow run. This cannot be undone."
      >
        {cancelRun.isPending ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
        Confirm stop
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 text-xs text-muted-foreground"
        onClick={() => arm(false)}
      >
        Keep running
      </Button>
    </div>
  );
}
