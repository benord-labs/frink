import { desc, eq, inArray, sql } from 'drizzle-orm';
import type { UsageActivity } from '../../../../shared/types/usage-history';
import { getDatabase } from '../../db';
import { flowRuns, flows, flowVersions, tasks } from '../../db/schema';

const TOP_FLOWS = 3;

/** Flow runs, finished tasks and the most-run flows. `done` is ready for review and `completed`
 * is accepted: both count as finished. */
export function getUsageActivity(db = getDatabase()): UsageActivity {
  const runs = sql<number>`count(*)`;
  const flowRunCount = db.select({ runs }).from(flowRuns).get()?.runs ?? 0;
  const tasksFinished =
    db
      .select({ runs })
      .from(tasks)
      .where(inArray(tasks.status, ['done', 'completed']))
      .get()?.runs ?? 0;
  const topFlows = db
    .select({ name: flows.name, runs })
    .from(flowRuns)
    .innerJoin(flowVersions, eq(flowRuns.flowVersionId, flowVersions.id))
    .innerJoin(flows, eq(flowVersions.flowId, flows.id))
    .groupBy(flows.id)
    .orderBy(desc(runs))
    .limit(TOP_FLOWS)
    .all();
  return { flowRuns: flowRunCount, tasksFinished, topFlows };
}
