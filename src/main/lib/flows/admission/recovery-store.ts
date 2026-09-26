import { and, asc, eq, gt, sql } from 'drizzle-orm';
import log from 'electron-log';
import type { FlowAdmissionState } from '../../../../shared/lib/flow-admission';
import type { getDatabase } from '../../db';
import { getFlowRun } from '../../db/repos/flow-runs';
import { flowRunAdmissions, flowRuns } from '../../db/schema';
import { captureFlowAdmissionException } from './activity';
import type { FlowAdmissionController } from './controller';
import type { FlowRunAdmission } from './store';

type Db = ReturnType<typeof getDatabase>;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1_000;
const LIVE_ADMISSION_SQL = sql`${flowRunAdmissions.state} IN ('queued', 'claimed', 'active', 'releasing')`;

export function recoveryAdmissions(
  db: Db,
  afterTicket = 0,
  limit = DEFAULT_PAGE_SIZE,
): {
  autoDrainable: FlowRunAdmission[];
  ambiguous: FlowRunAdmission[];
  nextTicket: number | null;
} {
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(limit)));
  const rows = db
    .select()
    .from(flowRunAdmissions)
    .where(and(LIVE_ADMISSION_SQL, gt(flowRunAdmissions.ticket, afterTicket)))
    .orderBy(asc(flowRunAdmissions.ticket))
    .limit(pageSize + 1)
    .all();
  const page = rows.slice(0, pageSize).map((row) => {
    if (row.state !== 'claimed' || row.priorityClass !== 'start' || row.startedAt !== null) {
      return row;
    }
    const run = db
      .select({ status: flowRuns.status, startedAt: flowRuns.startedAt })
      .from(flowRuns)
      .where(eq(flowRuns.id, row.flowRunId))
      .get();
    if (run?.status !== 'pending' || run.startedAt !== null) return row;
    return (
      db
        .update(flowRunAdmissions)
        .set({ state: 'queued', claimedAt: null, error: null, queueOrder: null })
        .where(
          and(eq(flowRunAdmissions.ticket, row.ticket), eq(flowRunAdmissions.state, 'claimed')),
        )
        .returning()
        .get() ?? row
    );
  });
  return {
    autoDrainable: page.filter((row) => row.state === 'queued'),
    ambiguous: page.filter((row) => row.state !== 'queued'),
    nextTicket: rows.length > pageSize ? (page.at(-1)?.ticket ?? null) : null,
  };
}

export type AdmissionOutcome = Extract<FlowAdmissionState, 'released' | 'failed' | 'cancelled'>;

export function outcomeForRunStatus(status: string): AdmissionOutcome | null {
  if (status === 'completed') return 'released';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return null;
}

/** A `releasing` row at boot: its cleanup owner is dead and held only in-memory resources, so a paused
 * run gets its slot back, a terminal run settles to its outcome (error kept), anything else settles failed. */
export async function recoverReleasingAdmission(
  db: Db,
  controller: Pick<FlowAdmissionController, 'reactivate' | 'settle'>,
  row: FlowRunAdmission,
): Promise<boolean> {
  const run = await getFlowRun(db, row.flowRunId);
  const context = { ticket: row.ticket, flowRunId: row.flowRunId, runStatus: run?.status };
  if (row.error) {
    // A cleanup failure that outlived its process: recovered here, but worth a signal on the surface.
    captureFlowAdmissionException(
      new Error(`Admission ${row.ticket} was left releasing by a dead process: ${row.error}`),
      'releasing-recovered-at-boot',
    );
  }
  if (run?.status === 'paused') {
    log.info(
      '[FlowAdmission] restored a paused run slot left releasing by a dead process',
      context,
    );
    return (await controller.reactivate(row.ticket)) !== null;
  }
  const outcome = (run && outcomeForRunStatus(run.status)) ?? 'failed';
  log.info('[FlowAdmission] settled an admission left releasing by a dead process', {
    ...context,
    outcome,
  });
  return (await controller.settle(row.ticket, outcome, row.error)) !== null;
}
