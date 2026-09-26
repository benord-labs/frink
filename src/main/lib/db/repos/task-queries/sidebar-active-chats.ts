import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { getDatabase } from '../../index';
import { chats, tasks } from '../../schema';
import { getBatchIdByChatId, listChatIdsWithActiveFlowRun } from '../flow-runs';

type Db = ReturnType<typeof getDatabase>;

export type SidebarActiveChat = {
  chatId: string;
  projectId: string | null;
  batchId: string | null;
  hasLiveFlowRun: boolean;
};

// Finished tasks never drive a sidebar status, so their chats are left out to keep the read bounded.
const FINISHED_TASK_STATUSES = ['completed', 'cancelled'];

/** Non-archived local chats with an unfinished task (by task_id or result.chatId, as the task list
 * links them) or a live flow run, loaded in the sidebar or not, with their folder and batch. */
export async function listSidebarActiveChats(db: Db): Promise<SidebarActiveChat[]> {
  const taskLinks = await db
    .select({
      chatId: sql<string | null>`coalesce(${chats.id}, json_extract(${tasks.result}, '$.chatId'))`,
    })
    .from(tasks)
    .leftJoin(chats, eq(chats.taskId, tasks.id))
    .where(notInArray(tasks.status, FINISHED_TASK_STATUSES));
  const liveFlowChatIds = new Set(await listChatIdsWithActiveFlowRun(db));
  const candidateIds = new Set([
    ...taskLinks.flatMap((row) => row.chatId ?? []),
    ...liveFlowChatIds,
  ]);
  if (candidateIds.size === 0) return [];
  const [rows, batchByChatId] = await Promise.all([
    db
      .select({ chatId: chats.id, projectId: chats.projectId })
      .from(chats)
      .where(and(inArray(chats.id, [...candidateIds]), isNull(chats.archivedAt))),
    getBatchIdByChatId(db),
  ]);
  return rows.map((row) => ({
    ...row,
    batchId: batchByChatId.get(row.chatId) ?? null,
    hasLiveFlowRun: liveFlowChatIds.has(row.chatId),
  }));
}
