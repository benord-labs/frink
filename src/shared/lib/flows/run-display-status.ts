/**
 * Maps a flow run's engine status + its active flow-driving task status to a DISPLAY status for the
 * run-history label/icon and last-run badge. The engine parks a run at `paused` on every
 * `awaiting_input` async agent hand-off, so `flow_run.status` alone reads "Paused" while an agent is
 * actively running. When a paused run still has a driving task, surface what it's really doing:
 *   running / pending            → 'running'        (agent working)
 *   plan_ready / needs_attention → 'awaiting_input' (parked for user action)
 * Any non-paused status, or paused with no active task, passes through unchanged — cloud runs leave
 * `active_task_status` undefined and keep today's behavior.
 * A durable queued admission takes display precedence without changing the engine status, and a
 * pending run held for Start reads 'held'.
 */
export function flowRunDisplayStatus(
  status: string,
  activeTaskStatus?: string | null,
  admissionState?: string | null,
): string {
  if (admissionState === 'queued' || admissionState === 'held') return admissionState;
  if (status !== 'paused' || !activeTaskStatus) return status;
  if (activeTaskStatus === 'running' || activeTaskStatus === 'pending') return 'running';
  if (activeTaskStatus === 'plan_ready' || activeTaskStatus === 'needs_attention') {
    return 'awaiting_input';
  }
  return status;
}

/** A run's engine status, except that a pending run held for Start reads 'held'. */
export function runStatusWithHold(run: {
  status: string;
  admission_state?: string | null;
}): string {
  return run.admission_state === 'held' ? 'held' : run.status;
}
