import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FlowAdmissionState } from '../../../../shared/lib/flow-admission';
import type { getDatabase } from '../../db';
import { listHumanWaitFlowRunIds } from '../../db/repos/node-runs';
import { flowRunAdmissions, flowRuns, flows, flowVersions, projects } from '../../db/schema';
import { flowAdmissionResumeKey } from '../../db/schema/flow-run-admissions';
import type { FlowAdmissionController } from './controller';
import { FLOW_ADMISSION_QUEUE_ORDER_BY, FLOW_ADMISSION_QUEUE_ORDER_SQL } from './queue-order';

type Db = ReturnType<typeof getDatabase>;

export type FlowAdmissionVisibility = {
  admissionState: FlowAdmissionState;
  queuePosition: number | null;
  requestedAt: Date;
};

export type FlowAdmissionRun = {
  id: string;
  status: string;
  activeTaskStatus: string | null;
};

export type FlowRunAdmissionSnapshot = {
  runStatus: string;
  startedAt: Date | null;
  completedAt: Date | null;
  admission: FlowAdmissionVisibility | null;
};

export type QueuedFlowAdmission = {
  batchId: string | null;
  flowName: string;
  priorityClass: 'resume' | 'start';
  projectName: string | null;
  requestedAt: Date;
  runFirst: boolean;
  ticket: number;
  /** The run's originating trigger payload, raw — the renderer validates and summarises it. */
  triggerContext: Record<string, unknown> | null;
};

const LIVE_ADMISSION_SQL = sql`${flowRunAdmissions.state} IN ('queued', 'claimed', 'active', 'releasing')`;

export function flowRunAdmissionSnapshotsForRuns(
  db: Db,
  flowRunIds: string[],
): Map<string, FlowRunAdmissionSnapshot> {
  if (flowRunIds.length === 0) return new Map();
  const rankedQueue = db
    .select({
      ticket: flowRunAdmissions.ticket,
      position: sql<number>`row_number() over (order by ${FLOW_ADMISSION_QUEUE_ORDER_SQL})`.as(
        'queue_position',
      ),
    })
    .from(flowRunAdmissions)
    .where(eq(flowRunAdmissions.state, 'queued'))
    .as('ranked_flow_admission_queue');
  const rows = db
    .select({
      flowRunId: flowRuns.id,
      runStatus: flowRuns.status,
      startedAt: flowRuns.startedAt,
      completedAt: flowRuns.completedAt,
      admissionState: flowRunAdmissions.state,
      requestedAt: flowRunAdmissions.requestedAt,
      queuePosition: rankedQueue.position,
    })
    .from(flowRuns)
    .leftJoin(
      flowRunAdmissions,
      and(eq(flowRunAdmissions.flowRunId, flowRuns.id), LIVE_ADMISSION_SQL),
    )
    .leftJoin(rankedQueue, eq(rankedQueue.ticket, flowRunAdmissions.ticket))
    .where(inArray(flowRuns.id, flowRunIds))
    .all();
  return new Map(
    rows.map((row) => [
      row.flowRunId,
      {
        runStatus: row.runStatus,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        admission:
          row.admissionState && row.requestedAt
            ? {
                admissionState: row.admissionState,
                queuePosition: row.queuePosition === null ? null : Number(row.queuePosition),
                requestedAt: row.requestedAt,
              }
            : null,
      },
    ]),
  );
}

export function admissionVisibilityForRuns(
  db: Db,
  flowRunIds: string[],
): Map<string, FlowAdmissionVisibility> {
  const admissions = new Map<string, FlowAdmissionVisibility>();
  for (const [flowRunId, snapshot] of flowRunAdmissionSnapshotsForRuns(db, flowRunIds)) {
    if (snapshot.admission) admissions.set(flowRunId, snapshot.admission);
  }
  return admissions;
}

export function queuedRunsForFlows(db: Db, flowIds: string[]): Map<string, FlowAdmissionRun> {
  if (flowIds.length === 0) return new Map();
  // Pending starts already come from getLatestRunsForFlows. This supplemental lookup exists only
  // for terminal resume runs, so seek the queue index's resume-key prefix instead of scanning starts.
  const rankedRuns = db
    .select({
      flowId: flowVersions.flowId,
      id: flowRuns.id,
      status: flowRuns.status,
      rank: sql<number>`row_number() over (partition by ${flowVersions.flowId} order by ${FLOW_ADMISSION_QUEUE_ORDER_SQL})`.as(
        'flow_queue_rank',
      ),
    })
    .from(flowRunAdmissions)
    .innerJoin(flowRuns, eq(flowRuns.id, flowRunAdmissions.flowRunId))
    .innerJoin(flowVersions, eq(flowVersions.id, flowRuns.flowVersionId))
    .where(
      and(
        inArray(flowVersions.flowId, flowIds),
        eq(flowRunAdmissions.state, 'queued'),
        sql`${flowAdmissionResumeKey(flowRunAdmissions)} = 1`,
      ),
    )
    .as('ranked_queued_flow_runs');
  const rows = db
    .select({
      flowId: rankedRuns.flowId,
      id: rankedRuns.id,
      status: rankedRuns.status,
    })
    .from(rankedRuns)
    .where(eq(rankedRuns.rank, 1))
    .all();
  return new Map(
    rows.map((row) => [row.flowId, { id: row.id, status: row.status, activeTaskStatus: null }]),
  );
}

export function queuedFlowAdmissions(db: Db): QueuedFlowAdmission[] {
  return db
    .select({
      batchId: flowRuns.batchId,
      flowName: flows.name,
      priorityClass: flowRunAdmissions.priorityClass,
      projectName: projects.name,
      requestedAt: flowRunAdmissions.requestedAt,
      runFirst: flowRunAdmissions.runFirst,
      ticket: flowRunAdmissions.ticket,
      triggerContext: flowRuns.triggerContext,
    })
    .from(flowRunAdmissions)
    .innerJoin(flowRuns, eq(flowRuns.id, flowRunAdmissions.flowRunId))
    .innerJoin(flowVersions, eq(flowVersions.id, flowRuns.flowVersionId))
    .innerJoin(flows, eq(flows.id, flowVersions.flowId))
    .leftJoin(projects, eq(projects.id, flows.projectId))
    .where(eq(flowRunAdmissions.state, 'queued'))
    .orderBy(...FLOW_ADMISSION_QUEUE_ORDER_BY)
    .all();
}

/**
 * Resolve one still-queued admission ticket to the Flow run it admits. Removal from the Work
 * Queue is keyed by ticket while cancellation is keyed by run, so this bridges the two.
 */
export function queuedAdmissionRun(db: Db, ticket: number): { flowRunId: string } | null {
  return (
    db
      .select({ flowRunId: flowRunAdmissions.flowRunId })
      .from(flowRunAdmissions)
      .where(and(eq(flowRunAdmissions.ticket, ticket), eq(flowRunAdmissions.state, 'queued')))
      .get() ?? null
  );
}

/** Slots still held by paused runs someone must act on (approvals, plan reviews, steps that retry). */
export async function countSlotsHeldByHumanWaits(db: Db): Promise<number> {
  const held = db
    .select({ flowRunId: flowRunAdmissions.flowRunId })
    .from(flowRunAdmissions)
    .innerJoin(flowRuns, eq(flowRuns.id, flowRunAdmissions.flowRunId))
    .where(
      and(
        inArray(flowRunAdmissions.state, ['claimed', 'active', 'releasing']),
        eq(flowRuns.status, 'paused'),
      ),
    )
    .all();
  return (
    await listHumanWaitFlowRunIds(
      db,
      held.map((row) => row.flowRunId),
    )
  ).size;
}

export type FlowAdmissionSettings = {
  queue_paused: boolean;
  concurrency_limit_enabled: boolean;
  max_concurrent_runs: number;
  occupied_runs: number;
  /** Occupied slots whose run is paused waiting for a person. */
  held_by_waiting_runs: number;
  queued_runs: number;
  draining: boolean;
};

/** The machine-wide admission settings and occupancy the Settings panel and MCP launches read. */
export async function readFlowAdmissionSettings(
  controller: Pick<FlowAdmissionController, 'getSnapshot'>,
  db: ReturnType<typeof getDatabase>,
): Promise<FlowAdmissionSettings> {
  const [snapshot, heldByWaitingRuns] = await Promise.all([
    controller.getSnapshot(),
    countSlotsHeldByHumanWaits(db),
  ]);
  return {
    queue_paused: snapshot.config.queuePaused,
    concurrency_limit_enabled: snapshot.config.concurrencyLimitEnabled,
    max_concurrent_runs: snapshot.config.maxConcurrentRuns,
    occupied_runs: snapshot.occupied,
    held_by_waiting_runs: heldByWaitingRuns,
    queued_runs: snapshot.counts.queued,
    draining: snapshot.draining,
  };
}
