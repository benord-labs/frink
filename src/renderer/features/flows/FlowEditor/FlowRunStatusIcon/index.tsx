/**
 * Shared status icon for flow runs (list row + last-run badge).
 */

import { CheckCircle2, CircleDashed, Clock, ListOrdered, Loader2, XCircle } from 'lucide-react';
import type { ReactElement } from 'react';
import { cn } from '../../../../lib/utils';

const LIVE_ADMISSION_STATES = new Set(['queued', 'claimed', 'active', 'releasing']);
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function isLiveFlowAdmissionState(state?: string | null): boolean {
  return state != null && LIVE_ADMISSION_STATES.has(state);
}

export function shouldPollFlowAdmission(
  status?: string | null,
  admissionState?: string | null,
): boolean {
  return (
    admissionState === 'queued' ||
    (status != null &&
      TERMINAL_RUN_STATUSES.has(status) &&
      isLiveFlowAdmissionState(admissionState))
  );
}

/**
 * Maps a flow run's engine status + its active flow-driving task status to a DISPLAY status for the
 * run-history label/icon and last-run badge. The engine parks a run at `paused` on every
 * `awaiting_input` async agent hand-off, so `flow_run.status` alone reads "Paused" while an agent is
 * actively running. When a paused run still has a driving task, surface what it's really doing:
 *   running / pending            → 'running'        (agent working)
 *   plan_ready / needs_attention → 'awaiting_input' (parked for user action)
 * Any non-paused status, or paused with no active task, passes through unchanged — cloud runs leave
 * `active_task_status` undefined and keep today's behavior.
 * A durable queued admission takes display precedence without changing the engine status.
 */
export function flowRunDisplayStatus(
  status: string,
  activeTaskStatus?: string | null,
  admissionState?: string | null,
): string {
  if (admissionState === 'queued') return 'queued';
  if (status !== 'paused' || !activeTaskStatus) return status;
  if (activeTaskStatus === 'running' || activeTaskStatus === 'pending') return 'running';
  if (activeTaskStatus === 'plan_ready' || activeTaskStatus === 'needs_attention') {
    return 'awaiting_input';
  }
  return status;
}

/**
 * A paused run shows human actions (Retry/Skip/Approve) only when it is NOT actively working. The
 * engine parks a run at `paused` for the WHOLE async agent hand-off, so raw `status==='paused'`
 * over-reports "awaiting human"; gate on the same `active_task_status`-aware signal the header uses.
 */
export function shouldShowPausedActions(
  status: string,
  activeTaskStatus?: string | null,
  admissionState?: string | null,
): boolean {
  const displayStatus = flowRunDisplayStatus(status, activeTaskStatus, admissionState);
  return status === 'paused' && displayStatus !== 'running' && displayStatus !== 'queued';
}

type FlowRunStatusIconProps = {
  status: string;
  /** Badge uses sm; run history rows use md */
  size?: 'sm' | 'md';
  /** When true, icons expose aria-label (compact badge); when false, aria-hidden (row inside button) */
  labelled?: boolean;
};

export function FlowRunStatusIcon({
  status,
  size = 'md',
  labelled = false,
}: FlowRunStatusIconProps): ReactElement {
  const dim = size === 'sm' ? 'h-3 w-3' : 'h-4 w-4';

  if (status === 'completed') {
    return (
      <CheckCircle2
        className={cn(dim, 'shrink-0 text-emerald-500')}
        aria-hidden={!labelled}
        {...(labelled ? { 'aria-label': 'Last run completed' } : {})}
      />
    );
  }
  if (status === 'failed') {
    return (
      <XCircle
        className={cn(dim, 'shrink-0 text-destructive')}
        aria-hidden={!labelled}
        {...(labelled ? { 'aria-label': 'Last run failed' } : {})}
      />
    );
  }
  if (status === 'awaiting_input') {
    return (
      <Clock
        className={cn(dim, 'shrink-0 text-warning')}
        aria-hidden={!labelled}
        {...(labelled ? { 'aria-label': 'Run awaiting input' } : {})}
      />
    );
  }
  if (status === 'queued') {
    return (
      <ListOrdered
        className={cn(dim, 'shrink-0 text-blue-500')}
        aria-hidden={!labelled}
        {...(labelled ? { 'aria-label': 'Run queued' } : {})}
      />
    );
  }
  if (status === 'running' || status === 'paused') {
    return (
      <Loader2
        className={cn(dim, 'shrink-0 text-blue-500', status === 'running' && 'animate-spin')}
        aria-hidden={!labelled}
        {...(labelled ? { 'aria-label': 'Run in progress' } : {})}
      />
    );
  }
  if (status === 'cancelled') {
    return (
      <CircleDashed
        className={cn(dim, 'shrink-0 text-muted-foreground/50')}
        aria-hidden={!labelled}
        {...(labelled ? { 'aria-label': 'Last run cancelled' } : {})}
      />
    );
  }
  return (
    <CircleDashed
      className={cn(
        dim,
        'shrink-0',
        size === 'sm' ? 'text-muted-foreground/40' : 'text-muted-foreground/30',
      )}
      aria-hidden={!labelled}
      {...(labelled ? { 'aria-label': 'Last run status' } : {})}
    />
  );
}
