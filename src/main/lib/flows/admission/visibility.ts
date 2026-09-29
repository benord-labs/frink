import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FlowAdmissionState } from '../../../../shared/lib/flow-admission';
import type { getDatabase } from '../../db';
import { flowRunAdmissions, flowRuns, flows, flowVersions, projects } from '../../db/schema';
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
  // for terminal resume runs, so use the queue index's priority prefix instead of scanning starts.
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
        eq(flowRunAdmissions.priorityClass, 'resume'),
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
