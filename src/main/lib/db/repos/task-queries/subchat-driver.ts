import { and, desc, eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import type { getDatabase } from '../../index';
import { flowRuns, nodeRuns, tasks } from '../../schema';

type Db = ReturnType<typeof getDatabase>;

/** Query builders also accept an outer sub-chat column for batched projections. */
export function latestFlowTaskForSubChatId(db: Db, subChatId: string | SQL) {
  return (
    db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.source, 'flow'),
          sql`json_extract(${tasks.result}, '$.subChatId') = ${subChatId}`,
        ),
      )
      // A terminal task still supersedes an older parked task. Insertion order breaks timestamp ties.
      .orderBy(desc(tasks.createdAt), desc(sql`tasks.rowid`))
      .limit(1)
  );
}

export function activeFlowRunForSubChatId(db: Db, subChatId: string | SQL) {
  return (
    db
      .select({ id: flowRuns.id })
      .from(flowRuns)
      .leftJoin(nodeRuns, eq(nodeRuns.flowRunId, flowRuns.id))
      .leftJoin(tasks, eq(tasks.flowRunId, flowRuns.id))
      .where(
        and(
          inArray(flowRuns.status, ['pending', 'running', 'paused']),
          or(
            sql`json_extract(${flowRuns.triggerContext}, '$.subChatId') = ${subChatId}`,
            sql`json_extract(${nodeRuns.nodeOutput}, '$.outputs.subChatId') = ${subChatId}`,
            sql`json_extract(${tasks.result}, '$.subChatId') = ${subChatId}`,
          ),
        ),
      )
      // Run-side links keep newer taskless runs authoritative over a previous run's parked task.
      .orderBy(desc(flowRuns.createdAt), desc(sql`flow_runs.rowid`))
      .limit(1)
  );
}
