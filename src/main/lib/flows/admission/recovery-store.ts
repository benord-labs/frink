import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import log from 'electron-log';
import { z } from 'zod';
import type { FlowAdmissionState } from '../../../../shared/lib/flow-admission';
import type { getDatabase } from '../../db';
import { getFlowRun } from '../../db/repos/flow-runs';
import { flowRunAdmissions, flowRuns, nodeRuns, tasks } from '../../db/schema';
import { stepRecoveryKind } from '../rerun/recovery-kind';
import { captureFlowAdmissionException, hasFlowResourceActivity } from './activity';
import type { FlowAdmissionController } from './controller';
import { admissionByTicket, type FlowRunAdmission, transitionAdmission } from './store';
import {
  isParkedNodeStatus,
  isTerminalResumeStatus,
  PARKED_NODE_STATUSES,
} from './terminal-resume/resume-store';

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
const LIVE_NODE_STATUSES = ['pending', 'running'];
const SETTLED_ADMISSION_STATES = new Set<FlowAdmissionState>(['released', 'failed', 'cancelled']);
const LIVE_TASK_STATUSES = ['pending', 'running', 'plan_ready'];
// A prompt cache lives at most an hour past its last call, so a parked step is cold an hour after it
// settled at the latest; a provider that records no expiry is held that long.
const MAX_PROMPT_CACHE_TTL_MS = 60 * 60_000;
const recordedCacheExpirySchema = z.object({
  turnUsage: z.object({ promptCacheExpiresAt: z.number() }),
});
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

/** A resume claim whose run is still terminal or paused provably never promoted: promotion and
 * claimed→active commit in one transaction. Settle it so the slot frees, but never replay it. */
function dropStrandedResumeClaim(
  db: Db,
  row: FlowRunAdmission,
  runStatus: string | null,
): FlowRunAdmission {
  if (!runStatus || (!isTerminalResumeStatus(runStatus) && runStatus !== 'paused')) return row;
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

function hasLiveTask(db: Db, flowRunId: string): boolean {
  const live = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.flowRunId, flowRunId), inArray(tasks.status, LIVE_TASK_STATUSES)))
    .get();
  return live !== undefined;
}

/** When the prompt cache of a run waiting only on a reply to one agent step goes cold (epoch ms);
 * null for any other run. Synchronous, so the release re-reads it in its transaction. */
export function humanWaitColdAt(db: Db, flowRunId: string): number | null {
  const run = db
    .select({ status: flowRuns.status, batchId: flowRuns.batchId })
    .from(flowRuns)
    .where(eq(flowRuns.id, flowRunId))
    .get();
  if (run?.status !== 'paused' || run.batchId !== null) return null;
  if (hasLiveTask(db, flowRunId)) return null;
  const unfinished = db
    .select({ id: nodeRuns.id, status: nodeRuns.status, completedAt: nodeRuns.completedAt })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.flowRunId, flowRunId),
        inArray(nodeRuns.status, [...PARKED_NODE_STATUSES, ...LIVE_NODE_STATUSES]),
      ),
    )
    .all();
  const [parked] = unfinished;
  if (unfinished.length !== 1 || !isParkedNodeStatus(parked.status)) return null;
  const task = db
    .select({ status: tasks.status, result: tasks.result, completedAt: tasks.completedAt })
    .from(tasks)
    .where(eq(tasks.nodeRunId, parked.id))
    .orderBy(desc(tasks.createdAt))
    .get();
  if (task?.status !== 'needs_attention' || !task.completedAt) return null;
  // The watcher applies a park after the task settles: until then the node still holds the hand-off.
  const applied = parked.completedAt !== null && parked.completedAt >= task.completedAt;
  if (!applied || stepRecoveryKind(db, parked.id) !== 'continue') return null;
  const recorded = recordedCacheExpirySchema.safeParse(task.result).data;
  const latest = task.completedAt.getTime() + MAX_PROMPT_CACHE_TTL_MS;
  return Math.min(recorded?.turnUsage.promptCacheExpiresAt ?? latest, latest);
}

function isPausedOnParkedStep(db: Db, flowRunId: string, nodeRunId: string): boolean {
  const run = db
    .select({ status: flowRuns.status })
    .from(flowRuns)
    .where(eq(flowRuns.id, flowRunId))
    .get();
  const node = db
    .select({ status: nodeRuns.status })
    .from(nodeRuns)
    .where(and(eq(nodeRuns.id, nodeRunId), eq(nodeRuns.flowRunId, flowRunId)))
    .get();
  return run?.status === 'paused' && node !== undefined && isParkedNodeStatus(node.status);
}

/** Still paused on this step with no slot: none was ever held for it (newest admission settled), or
 * a resume is waiting to take one back (`queued`). Null while the run still holds its slot. */
export function slotlessPark(
  db: Db,
  flowRunId: string,
  nodeRunId: string,
): 'settled' | 'queued' | null {
  if (!isPausedOnParkedStep(db, flowRunId, nodeRunId)) return null;
  const latest = db
    .select({ state: flowRunAdmissions.state })
    .from(flowRunAdmissions)
    .where(eq(flowRunAdmissions.flowRunId, flowRunId))
    .orderBy(desc(flowRunAdmissions.ticket))
    .get();
  if (!latest) return null;
  if (SETTLED_ADMISSION_STATES.has(latest.state)) return 'settled';
  return latest.state === 'queued' || latest.state === 'claimed' ? 'queued' : null;
}

export type ParkedSlotRelease = { kind: 'released' } | { kind: 'warm'; coldAt: number };

/** Frees a human wait's slot once its prompt cache is cold, reading the wait and live activity in
 * this same transaction (no release window); while warm, a reply continues in place. */
export function releaseParkedSlot(
  db: Db,
  ticket: number,
  now = Date.now(),
): ParkedSlotRelease | null {
  const admission = admissionByTicket(db, ticket);
  if (admission?.state !== 'active' || hasFlowResourceActivity(admission.flowRunId)) return null;
  const coldAt = humanWaitColdAt(db, admission.flowRunId);
  if (coldAt === null) return null;
  if (coldAt > now) return { kind: 'warm', coldAt };
  const released = transitionAdmission(db, ticket, ['active'], {
    state: 'released',
    settledAt: new Date(now),
  });
  return released ? { kind: 'released' } : null;
}

/** Gives back the slot of a paused run's resume that failed before changing anything: its step is
 * still parked and nothing in the run is live, so the run is left as the click found it. */
export function failUnusedParkedResume(
  db: Db,
  ticket: number,
  nodeRunId: string,
  error: string,
): FlowRunAdmission | null {
  const admission = admissionByTicket(db, ticket);
  if (admission?.state !== 'active' || admission.priorityClass !== 'resume') return null;
  const { flowRunId } = admission;
  if (!isPausedOnParkedStep(db, flowRunId, nodeRunId)) return null;
  const liveNode = db
    .select({ id: nodeRuns.id })
    .from(nodeRuns)
    .where(and(eq(nodeRuns.flowRunId, flowRunId), inArray(nodeRuns.status, LIVE_NODE_STATUSES)))
    .get();
  if (liveNode || hasLiveTask(db, flowRunId)) return null;
  return transitionAdmission(db, ticket, ['active'], {
    state: 'failed',
    error,
    settledAt: new Date(),
  });
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
