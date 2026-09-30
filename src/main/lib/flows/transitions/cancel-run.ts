import { eq } from 'drizzle-orm';
import type { getDatabase } from '../../db';
import { type FlowRun, flowRuns } from '../../db/schema';
import { liveAdmissionForRun } from '../admission/store';
import {
  cancelFlowTaskRows,
  cancelRunRows,
  dropUndispatchedAdmission,
  isCancellableRunStatus,
  sweepUnfinishedRunRows,
} from './run-rows';

type Db = ReturnType<typeof getDatabase>;

/** `liveTicket`: the slot still live at commit, the only one the follow-up release may touch. */
type CancelRunOutcome = {
  run: FlowRun;
  cancelled: boolean;
  droppedTicket: boolean;
  liveTicket: number | null;
};

const readRun = (db: Db, flowRunId: string) =>
  db.select().from(flowRuns).where(eq(flowRuns.id, flowRunId)).get();

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
