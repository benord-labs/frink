import { and, eq, exists, inArray } from 'drizzle-orm';
import {
  RESUME_ACTIONABLE_NODE_STATUSES,
  SUPERSEDED_NODE_STATUS,
} from '../../../../shared/types/flow';
import type { getDatabase } from '../../db';
import type { FlowRunStatus } from '../../db/repos/flow-runs';
import {
  type FlowRun,
  flowRunAdmissions,
  flowRuns,
  type NewNodeRun,
  type NodeRun,
  nodeRuns,
} from '../../db/schema';

type Db = ReturnType<typeof getDatabase>;

declare const fenceBrand: unique symbol;

/** A decision's run identity: the admission ticket the run held when the decision was made. Only
 * `readRunFence` constructs one, so every fence names a ticket that was live at decision time. */
export type RunFence = {
  readonly flowRunId: string;
  readonly ticket: number;
  readonly [fenceBrand]: true;
};

const DISPATCHABLE_RUN_STATUSES: readonly FlowRunStatus[] = ['running', 'paused'];
const FENCED_ADMISSION_STATES = ['active', 'releasing'] as const;

const fenceHolds = (db: Db, fence: RunFence, runStatuses: readonly FlowRunStatus[]) =>
  and(
    eq(flowRuns.id, fence.flowRunId),
    inArray(flowRuns.status, [...runStatuses]),
    exists(
      db
        .select({ ticket: flowRunAdmissions.ticket })
        .from(flowRunAdmissions)
        .where(
          and(
            eq(flowRunAdmissions.ticket, fence.ticket),
            eq(flowRunAdmissions.flowRunId, fence.flowRunId),
            inArray(flowRunAdmissions.state, FENCED_ADMISSION_STATES),
          ),
        ),
    ),
  );

/** The fence of a running or paused run whose live admission (`ticket`, when given) is active or
 * releasing; null otherwise. A releasing slot passes so a retained cleanup error never wedges a run. */
export function readRunFence(db: Db, flowRunId: string, ticket?: number): RunFence | null {
  const row = db
    .select({ ticket: flowRunAdmissions.ticket })
    .from(flowRuns)
    .innerJoin(flowRunAdmissions, eq(flowRunAdmissions.flowRunId, flowRuns.id))
    .where(
      and(
        eq(flowRuns.id, flowRunId),
        inArray(flowRuns.status, [...DISPATCHABLE_RUN_STATUSES]),
        inArray(flowRunAdmissions.state, FENCED_ADMISSION_STATES),
        ticket === undefined ? undefined : eq(flowRunAdmissions.ticket, ticket),
      ),
    )
    .get();
  return row ? ({ flowRunId, ticket: row.ticket } as RunFence) : null;
}

/** Writes the run's status only while it is in `from` and still holds the fence's ticket; null,
 * writing nothing, once a Cancel, a settle or a newer admission has replaced it. */
export function setFencedRunStatus(
  db: Db,
  fence: RunFence,
  status: FlowRunStatus,
  patch: { completedAt?: Date } = {},
  from: readonly FlowRunStatus[] = DISPATCHABLE_RUN_STATUSES,
): FlowRun | null {
  return (
    db
      .update(flowRuns)
      .set({ status, ...patch })
      .where(fenceHolds(db, fence, from))
      .returning()
      .get() ?? null
  );
}

/** Inserts a node_run only while the fence holds (else null); a Retry's `supersedesNodeRunId` is
 * terminalized in the same tick, so a Cancel never strands it. Runs inside `runTransition`. */
export function insertNodeRunIfFenced(
  db: Db,
  fence: RunFence,
  input: Omit<NewNodeRun, 'flowRunId'>,
  supersedesNodeRunId?: string,
): NodeRun | null {
  const live = db
    .select({ id: flowRuns.id })
    .from(flowRuns)
    .where(fenceHolds(db, fence, DISPATCHABLE_RUN_STATUSES))
    .get();
  if (!live) return null;
  const values = { ...input, flowRunId: fence.flowRunId, admissionTicket: fence.ticket };
  if (supersedesNodeRunId === undefined)
    return db.insert(nodeRuns).values(values).returning().get();
  // The attempt stopped being actionable since the Retry was decided (a late completion advanced
  // it): inserting a replacement would re-run a step that already finished.
  const attemptNumber = supersedeAttempt(db, fence.flowRunId, supersedesNodeRunId);
  if (attemptNumber === null) return null;
  return db
    .insert(nodeRuns)
    .values({ ...values, attemptNumber })
    .returning()
    .get();
}

/** CAS a still-actionable attempt to `superseded`; the next attempt number, or null if it lost. */
function supersedeAttempt(db: Db, flowRunId: string, nodeRunId: string): number | null {
  const superseded = db
    .update(nodeRuns)
    .set({ status: SUPERSEDED_NODE_STATUS, completedAt: new Date() })
    .where(
      and(
        eq(nodeRuns.id, nodeRunId),
        eq(nodeRuns.flowRunId, flowRunId),
        inArray(nodeRuns.status, [...RESUME_ACTIONABLE_NODE_STATUSES]),
      ),
    )
    .returning({ attemptNumber: nodeRuns.attemptNumber })
    .get();
  return superseded ? superseded.attemptNumber + 1 : null;
}
