import { and, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { getDatabase } from '../../index';
import { chats, flowRuns, type Task, tasks } from '../../schema';
import { getBatchIdByChatId, listChatIdsWithActiveFlowRun } from '../flow-runs';
import { effectiveStatusExpr } from './flow-collapse';

type Db = ReturnType<typeof getDatabase>;

type SidebarActiveChat = {
  chatId: string;
  projectId: string | null;
  batchId: string | null;
  hasLiveFlowRun: boolean;
};

/** Only what the sidebar derives a row's status pill from; the full task row is far too heavy to poll. */
type SidebarTaskStatusRow = {
  id: string;
  status: Task['status'];
  linkedChatId: string;
  flowRunStatus: string | null;
  effectiveStatus: string;
  agentSignalSummary: string | null;
};

export type SidebarActivity = { chats: SidebarActiveChat[]; tasks: SidebarTaskStatusRow[] };

// Finished tasks never drive a sidebar status, so their chats are left out to keep the read bounded.
const FINISHED_TASK_STATUSES = ['completed', 'cancelled'];

/** Non-archived local chats with an unfinished task (by task_id or result.chatId, as the task list
 * links them) or a live flow run, loaded in the sidebar or not, with their folder, batch and tasks. */
export async function listSidebarActiveChats(db: Db): Promise<SidebarActivity> {
  const linkedChatId = sql<string>`coalesce(${chats.id}, json_extract(${tasks.result}, '$.chatId'))`;
  const visibleChat = alias(chats, 'visible_chat');
  const visibleChatIds = db
    .select({ id: visibleChat.id })
    .from(visibleChat)
    .where(isNull(visibleChat.archivedAt));
  const taskRows = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      linkedChatId,
      flowRunStatus: flowRuns.status,
      effectiveStatus: effectiveStatusExpr.as('effective_status'),
      agentSignalSummary: sql<
        string | null
      >`json_extract(${tasks.result}, '$.agentSignal.summary')`,
    })
    .from(tasks)
    .leftJoin(chats, eq(chats.taskId, tasks.id))
    .leftJoin(flowRuns, eq(flowRuns.id, tasks.flowRunId))
    .where(
      and(notInArray(tasks.status, FINISHED_TASK_STATUSES), inArray(linkedChatId, visibleChatIds)),
    )
    .orderBy(desc(tasks.createdAt), desc(tasks.id));
  const liveFlowChatIds = new Set(await listChatIdsWithActiveFlowRun(db));
  const candidateIds = new Set([...taskRows.map((row) => row.linkedChatId), ...liveFlowChatIds]);
  if (candidateIds.size === 0) return { chats: [], tasks: [] };
  const [rows, batchByChatId] = await Promise.all([
    db
      .select({ chatId: chats.id, projectId: chats.projectId })
      .from(chats)
      .where(and(inArray(chats.id, [...candidateIds]), isNull(chats.archivedAt))),
    getBatchIdByChatId(db),
  ]);
  return {
    chats: rows.map((row) => ({
      ...row,
      batchId: batchByChatId.get(row.chatId) ?? null,
      hasLiveFlowRun: liveFlowChatIds.has(row.chatId),
    })),
    tasks: taskRows,
  };
}
