import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { FLOW_ADMISSION_LIVE_STATES } from '../../../../../shared/lib/flow-admission';
import { FLOW_DRIVING_STATUSES } from '../../../../../shared/types/flow';
import type { getDatabase } from '../../index';
import { chats, flowRunAdmissions, flowRuns, flows, flowVersions, tasks } from '../../schema';

type Db = ReturnType<typeof getDatabase>;

export type HardDeleteFlowResult =
  | { deleted: false; unsettledRunIds: string[] }
  | {
      deleted: true;
      flowRunIds: string[];
      taskLinks: Array<{ chatId: string; taskId: string }>;
    };

function unsettledFlowRunIdsForFlow(db: Db, flowId: string): string[] {
  return db
    .selectDistinct({ id: flowRuns.id })
    .from(flowRuns)
    .innerJoin(flowVersions, eq(flowVersions.id, flowRuns.flowVersionId))
    .leftJoin(flowRunAdmissions, eq(flowRunAdmissions.flowRunId, flowRuns.id))
    .leftJoin(tasks, eq(tasks.flowRunId, flowRuns.id))
    .where(
      and(
        eq(flowVersions.flowId, flowId),
        or(
          inArray(flowRuns.status, ['pending', 'running', 'paused']),
          inArray(flowRunAdmissions.state, [...FLOW_ADMISSION_LIVE_STATES]),
          inArray(tasks.status, [...FLOW_DRIVING_STATUSES]),
        ),
      ),
    )
    .all()
    .map((row) => row.id);
}

export async function listUnsettledFlowRunIdsForFlow(db: Db, flowId: string): Promise<string[]> {
  return unsettledFlowRunIdsForFlow(db, flowId);
}

export function hardDeleteFlow(db: Db, flowId: string): HardDeleteFlowResult {
  return db.transaction(
    () => {
      const unsettledRunIds = unsettledFlowRunIdsForFlow(db, flowId);
      if (unsettledRunIds.length > 0) return { deleted: false, unsettledRunIds };

      const flowRunIds = db
        .select({ id: flowRuns.id })
        .from(flowRuns)
        .innerJoin(flowVersions, eq(flowVersions.id, flowRuns.flowVersionId))
        .where(eq(flowVersions.flowId, flowId))
        .all()
        .map((run) => run.id);
      const taskLinks = new Map<string, { chatId: string; taskId: string }>();
      if (flowRunIds.length > 0) {
        for (const row of db
          .selectDistinct({ chatId: chats.id, taskId: tasks.id })
          .from(chats)
          .innerJoin(tasks, eq(tasks.id, chats.taskId))
          .where(inArray(tasks.flowRunId, flowRunIds))
          .all()) {
          taskLinks.set(`${row.chatId}\0${row.taskId}`, row);
        }
        for (const row of db
          .select({
            chatId: sql<string | null>`json_extract(${tasks.result}, '$.chatId')`,
            taskId: tasks.id,
          })
          .from(tasks)
          .where(inArray(tasks.flowRunId, flowRunIds))
          .all()) {
          if (row.chatId)
            taskLinks.set(`${row.chatId}\0${row.taskId}`, { ...row, chatId: row.chatId });
        }
        db.delete(tasks).where(inArray(tasks.flowRunId, flowRunIds)).run();
      }
      db.delete(flows).where(eq(flows.id, flowId)).run();
      return { deleted: true, flowRunIds, taskLinks: [...taskLinks.values()] };
    },
    { behavior: 'immediate' },
  );
}
