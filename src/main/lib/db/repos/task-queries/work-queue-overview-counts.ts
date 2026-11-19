import { and, sql as drizzleSql, eq } from 'drizzle-orm';
import type { getDatabase } from '../../index';
import { flowRunAdmissions, flowRuns, tasks } from '../../schema';
import { isHeldFlowRun } from '../flow-runs';
import { isFlowRepresentative } from './flow-collapse';
import {
  isNotQueuedForAdmission,
  isNotWaitingOnApproval,
  workQueueOverviewSectionExpr,
} from './work-queue-overview-filter';

type Db = ReturnType<typeof getDatabase>;

export type WorkQueueOverviewCounts = {
  inbox: number;
  queued: number;
  review: number;
  running: number;
};

/** Runs held for Start, the Work Queue Inbox; counted here so no caller needs the list. */
export async function countHeldFlowRuns(db: Db): Promise<number> {
  const row = await db
    .select({ count: drizzleSql<number>`count(*)` })
    .from(flowRuns)
    .where(isHeldFlowRun)
    .get();
  return Number(row?.count ?? 0);
}

/**
 * Counts the mutually exclusive states shown by the Work Queue overview.
 *
 * Queued is machine admission, before a Flow necessarily has a task row. Existing task rows for a
 * queued resume are excluded from Running/Review so one Flow never occupies two progress segments.
 */
export async function getWorkQueueOverviewCounts(db: Db): Promise<WorkQueueOverviewCounts> {
  const queuedRow = await db
    .select({ count: drizzleSql<number>`count(*)` })
    .from(flowRunAdmissions)
    .innerJoin(flowRuns, eq(flowRuns.id, flowRunAdmissions.flowRunId))
    .where(eq(flowRunAdmissions.state, 'queued'))
    .get();

  const taskRows = await db
    .select({
      section: workQueueOverviewSectionExpr.as('section'),
      count: drizzleSql<number>`count(*)`.as('count'),
    })
    .from(tasks)
    .leftJoin(flowRuns, eq(flowRuns.id, tasks.flowRunId))
    .where(and(isFlowRepresentative, isNotQueuedForAdmission, isNotWaitingOnApproval))
    .groupBy(workQueueOverviewSectionExpr);

  let review = 0;
  let running = 0;
  for (const row of taskRows) {
    const count = Number(row.count);
    if (row.section === 'attention') review += count;
    if (row.section === 'running') running += count;
  }

  return {
    inbox: await countHeldFlowRuns(db),
    queued: Number(queuedRow?.count ?? 0),
    review,
    running,
  };
}
