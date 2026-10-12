import { and, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { getDatabase } from '../../index';
import { flowRuns, tasks } from '../../schema';
import { chatLinkId, linkedFlowRunIds } from './linked-flow-runs';

type Db = ReturnType<typeof getDatabase>;

/** Query builders also accept an outer sub-chat column for batched projections. */
export function latestFlowTaskForSubChatId(db: Db, subChatId: string | SQL) {
  return (
    db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.source, 'flow'), eq(chatLinkId(tasks.result, '$.subChatId'), subChatId)))
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
      .where(
        and(
          inArray(flowRuns.status, ['pending', 'running', 'paused']),
          inArray(flowRuns.id, linkedFlowRunIds(db, 'subChatId', subChatId)),
        ),
      )
      // Run-side links keep newer taskless runs authoritative over a previous run's parked task.
      .orderBy(desc(flowRuns.createdAt), desc(sql`flow_runs.rowid`))
      .limit(1)
  );
}

/** {@link activeFlowRunForSubChatId} in any status: the linked set is one sub-chat's few runs. */
export function newestFlowRunForSubChatId(db: Db, subChatId: string) {
  return db
    .select({ id: flowRuns.id, status: flowRuns.status })
    .from(flowRuns)
    .where(inArray(flowRuns.id, linkedFlowRunIds(db, 'subChatId', subChatId)))
    .orderBy(desc(flowRuns.createdAt), desc(sql`flow_runs.rowid`))
    .limit(1);
}
