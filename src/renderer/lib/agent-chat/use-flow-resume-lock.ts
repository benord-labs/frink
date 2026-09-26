import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

/**
 * Single-shot lock shared by the paused bar's two continuation affordances (Resume and a typed
 * Reply). Extracted from FlowPausedBar for the same reason useFlowNoteField was — it is all policy
 * and no markup, so it reads better on its own and keeps that component inside its budget.
 *
 * The lock is a REF as well as state: React state disables the rendered controls, but the ref closes
 * the same-tick double-click window before React commits that state. Without it, two fast clicks
 * both pass the guard and the second aborts the continuation the first just started.
 *
 * Release is engine-confirmed, never optimistic: the lock clears once a turn has actually been seen
 * active and then ends. A turn that ends while the run is STILL paused means the continuation
 * failed, so it unlocks with an error — except when the user pressed Stop, which is a deliberate end
 * rather than a failure.
 */
export function useFlowResumeLock(flowRunId: string, isTurnActive: boolean) {
  const [resumePending, setResumePending] = useState(false);
  const lockedRef = useRef(false);
  const sawActiveTurnRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const previousFlowRunIdRef = useRef(flowRunId);

  // A new run under the same mounted bar starts unlocked; otherwise the previous run's lock would
  // strand its controls disabled forever.
  useEffect(() => {
    if (previousFlowRunIdRef.current === flowRunId) return;
    previousFlowRunIdRef.current = flowRunId;
    lockedRef.current = false;
    sawActiveTurnRef.current = false;
    stopRequestedRef.current = false;
    setResumePending(false);
  }, [flowRunId]);

  useEffect(() => {
    if (!resumePending) return;
    if (isTurnActive) {
      sawActiveTurnRef.current = true;
      return;
    }
    if (!sawActiveTurnRef.current) return;

    lockedRef.current = false;
    sawActiveTurnRef.current = false;
    setResumePending(false);
    if (!stopRequestedRef.current) {
      toast.error('Flow did not resume', {
        description: 'The continuation ended while the flow was still paused. Try again.',
      });
    }
    stopRequestedRef.current = false;
  }, [isTurnActive, resumePending]);

  /** Runs `send` under the lock; a refused or throwing send releases it so the user can retry. */
  const start = (send: () => boolean): boolean => {
    if (lockedRef.current) return false;
    lockedRef.current = true;
    stopRequestedRef.current = false;
    try {
      if (!send()) {
        lockedRef.current = false;
        return false;
      }
    } catch (error) {
      lockedRef.current = false;
      throw error;
    }
    sawActiveTurnRef.current = isTurnActive;
    setResumePending(true);
    return true;
  };

  /** Marks the next turn-end as deliberate, so it does not report a resume failure. */
  const markStopRequested = () => {
    stopRequestedRef.current = true;
  };

  return { resumePending, start, markStopRequested };
}
