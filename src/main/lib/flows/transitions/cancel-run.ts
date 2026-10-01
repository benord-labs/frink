import { and, eq } from 'drizzle-orm';
import type { getDatabase } from '../../db';
import { abandonRestartInterruption } from '../../db/repos/task-parking/abandon-marker';
import { cancelTaskDetailed } from '../../db/repos/tasks';
import { type FlowRun, type Task, tasks } from '../../db/schema';
import { liveAdmissionForRun } from '../admission/store';
import {
  cancelFlowTaskRows,
  cancelRunRows,
  dropUndispatchedAdmission,
  isCancellableRunStatus,
  readRun,
  sweepUnfinishedRunRows,
} from './run-rows';

type Db = ReturnType<typeof getDatabase>;

/** `liveTicket`: the slot still live at commit, the only one the follow-up release may touch. */
export type CancelRunOutcome = {
  run: FlowRun;
  cancelled: boolean;
  droppedTicket: boolean;
  liveTicket: number | null;
};

/** Drops an undispatched ticket, then cancels a live run and its unfinished rows; null when missing.
 * A terminal run keeps its status; `includeParked` (permanent deletion) still sweeps its parked tasks. */
export function cancelRunCommand(
  db: Db,
  flowRunId: string,
  { includeParked }: { includeParked: boolean },
  now = new Date(),
): CancelRunOutcome | null {
  const before = readRun(db, flowRunId);
  if (!before) return null;
  const droppedTicket = dropUndispatchedAdmission(db, flowRunId, now);
  const cancelled = isCancellableRunStatus(before.status);
  // A dropped start ticket has already cancelled its pending run, but not the run's rows.
  if (cancelled && !cancelRunRows(db, flowRunId, { includeParked }, now))
    sweepUnfinishedRunRows(db, flowRunId, includeParked, now);
  if (!cancelled && includeParked) cancelFlowTaskRows(db, flowRunId, true, now);
  const liveTicket = liveAdmissionForRun(db, flowRunId)?.ticket ?? null;
  return { run: readRun(db, flowRunId) ?? before, cancelled, droppedTicket, liveTicket };
}

type WorkQueueCancelOutcome = CancelRunOutcome & {
  /** Anything written: the run, its restart marker, a queued ticket or the clicked row. */
  touched: boolean;
  /** The run's `running` flow tasks as they were before this Cancel stopped them. */
  stopped: Task[];
  clicked: ReturnType<typeof cancelTaskDetailed>;
};

/** Work Queue Cancel of a flow row: a live run gets the run-level Cancel (parked siblings kept), a
 * restart marker is cleared, then the clicked row is cancelled. Null when the run is missing. */
export function cancelWorkQueueRunCommand(
  db: Db,
  flowRunId: string,
  clickedTaskId: string,
  now = new Date(),
): WorkQueueCancelOutcome | null {
  const before = readRun(db, flowRunId);
  if (!before) return null;
  const running = db
    .select()
    .from(tasks)
    .where(and(eq(tasks.flowRunId, flowRunId), eq(tasks.status, 'running')))
    .all();
  const live = isCancellableRunStatus(before.status);
  // A terminal run keeps its queued Retry or Re-run unless its restart marker is cleared.
  const interrupted = !live && abandonRestartInterruption(db, flowRunId);
  const outcome =
    live || interrupted
      ? cancelRunCommand(db, flowRunId, { includeParked: false }, now)
      : { run: before, cancelled: false, droppedTicket: false, liveTicket: null };
  if (!outcome) return null;
  const abandoned = interrupted || (live && abandonRestartInterruption(db, flowRunId));
  const clicked = cancelTaskDetailed(db, clickedTaskId);
  const touched = outcome.cancelled || outcome.droppedTicket || abandoned || clicked.task !== null;
  return { ...outcome, touched, stopped: outcome.cancelled ? running : [], clicked };
}
