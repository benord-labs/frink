import { and, asc, eq, gt, sql } from 'drizzle-orm';
import log from 'electron-log';
import type { FlowAdmissionState } from '../../../../shared/lib/flow-admission';
import type { getDatabase } from '../../db';
import { getFlowRun } from '../../db/repos/flow-runs';
import { flowRunAdmissions, flowRuns } from '../../db/schema';
import { captureFlowAdmissionException } from './activity';
import type { FlowAdmissionController } from './controller';
import { admissionByTicket, type FlowRunAdmission, transitionAdmission } from './store';
import { isTerminalResumeStatus } from './terminal-resume/resume-store';

type Db = ReturnType<typeof getDatabase>;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1_000;
const LIVE_ADMISSION_SQL = sql`${flowRunAdmissions.state} IN ('queued', 'claimed', 'active', 'releasing')`;
const LIVE_ADMISSION_STATES = new Set<FlowAdmissionState>([
  'queued',
  'claimed',
  'active',
  'releasing',
]);
const STRANDED_RESUME_ERROR =
  'Resume claim was interrupted by a restart before dispatch; retry it manually';

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
  // One read carries each row's run status, so the per-row recovery decisions below never re-query.
  const rows = db
    .select({
      admission: flowRunAdmissions,
      runStatus: flowRuns.status,
      runStartedAt: flowRuns.startedAt,
    })
    .from(flowRunAdmissions)
    .leftJoin(flowRuns, eq(flowRuns.id, flowRunAdmissions.flowRunId))
    .where(and(LIVE_ADMISSION_SQL, gt(flowRunAdmissions.ticket, afterTicket)))
    .orderBy(asc(flowRunAdmissions.ticket))
    .limit(pageSize + 1)
    .all();
  const pageRows = rows.slice(0, pageSize);
  const page = pageRows.map(({ admission: row, runStatus, runStartedAt }) => {
    if (row.state !== 'claimed' || row.startedAt !== null) return row;
    if (row.priorityClass === 'resume') return dropStrandedResumeClaim(db, row, runStatus);
    if (row.priorityClass !== 'start') return row;
    if (runStatus !== 'pending' || runStartedAt !== null) return row;
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
  const live = page.filter((row) => LIVE_ADMISSION_STATES.has(row.state));
  return {
    autoDrainable: live.filter((row) => row.state === 'queued'),
    ambiguous: live.filter((row) => row.state !== 'queued'),
    // The cursor walks the rows read, not the rows kept: a page of dropped claims still advances.
    nextTicket: rows.length > pageSize ? (pageRows.at(-1)?.admission.ticket ?? null) : null,
  };
}

/** A resume claim whose run is still terminal provably never promoted: promotion and claimed→active
 * commit in one transaction. Settle it so the slot frees, but never replay it — manual Retry owns it. */
function dropStrandedResumeClaim(
  db: Db,
  row: FlowRunAdmission,
  runStatus: string | null,
): FlowRunAdmission {
  if (!runStatus || !isTerminalResumeStatus(runStatus)) return row;
  const dropped = transitionAdmission(db, row.ticket, ['claimed'], {
    state: 'failed',
    error: STRANDED_RESUME_ERROR,
    settledAt: new Date(),
  });
  if (!dropped) return row;
  log.info('[FlowAdmission] dropped a resume claim left by a dead process', {
    ticket: row.ticket,
    flowRunId: row.flowRunId,
    runStatus,
  });
  return dropped;
}

export type AdmissionOutcome = Extract<FlowAdmissionState, 'released' | 'failed' | 'cancelled'>;

export function outcomeForRunStatus(status: string): AdmissionOutcome | null {
  if (status === 'completed') return 'released';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return null;
}

/** Moves a terminal run's slot to `releasing`, deciding on the run status read in the same
 * transaction, so an un-park or revive that reopened the run first keeps its slot. */
export function beginTerminalRelease(
  db: Db,
  ticket: number,
): { releasing: FlowRunAdmission; outcome: AdmissionOutcome } | null {
  const admission = admissionByTicket(db, ticket);
  const run =
    admission &&
    db
      .select({ status: flowRuns.status })
      .from(flowRuns)
      .where(eq(flowRuns.id, admission.flowRunId))
      .get();
  const outcome = run ? outcomeForRunStatus(run.status) : null;
  if (!admission || !outcome) return null;
  const releasing =
    admission.state === 'active'
      ? transitionAdmission(db, ticket, ['active'], { state: 'releasing', error: null })
      : admission;
  return releasing?.state === 'releasing' ? { releasing, outcome } : null;
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
