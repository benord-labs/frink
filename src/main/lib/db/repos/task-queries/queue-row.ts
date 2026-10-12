/**
 * The Work Queue's row read: a task with its project, linked chat, run status and per-flow-collapse
 * display status. The paginated list and a single-row re-check share it so they always agree.
 */

import { and, sql as drizzleSql, eq, lt, or, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { getDatabase } from '../../index';
import { chats, flowRuns, projects, type Task, tasks } from '../../schema';
import { effectiveStatusExpr } from './flow-collapse';

type Db = ReturnType<typeof getDatabase>;

export type TaskListCursor = { createdAt: string; id: string };

export type TaskWithProjectRow = Task & {
  projectName: string | null;
  linkedChatId: string | null;
  flowRunStatus: string | null;
  /** Display status (effectiveStatusExpr); mutations still read raw `status`. */
  effectiveStatus: string;
};

/** Rows matching `where`, as the Work Queue lists them. */
export function selectQueueTaskRows(db: Db, where: SQL | undefined) {
  const resultChat = alias(chats, 'result_chat');
  return db
    .select({
      task: tasks,
      projectName: projects.name,
      linkedChatId: drizzleSql<string | null>`coalesce(${chats.id}, ${resultChat.id})`,
      flowRunStatus: flowRuns.status,
      effectiveStatus: effectiveStatusExpr.as('effective_status'),
    })
    .from(tasks)
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .leftJoin(chats, eq(chats.taskId, tasks.id))
    .leftJoin(resultChat, eq(resultChat.id, drizzleSql`json_extract(${tasks.result}, '$.chatId')`))
    .leftJoin(flowRuns, eq(flowRuns.id, tasks.flowRunId))
    .where(where);
}

type QueueSelectRow = Awaited<ReturnType<typeof selectQueueTaskRows>>[number];

export function toQueueTaskRow(r: QueueSelectRow): TaskWithProjectRow {
  return {
    ...r.task,
    projectName: r.projectName ?? null,
    linkedChatId: r.linkedChatId ?? null,
    flowRunStatus: r.flowRunStatus ?? null,
    effectiveStatus: String(r.effectiveStatus ?? r.task.status),
  };
}

/** One task as the Work Queue lists it, or null when it is gone. */
export async function getQueueTaskRow(db: Db, id: string): Promise<TaskWithProjectRow | null> {
  const [row] = await selectQueueTaskRows(db, eq(tasks.id, id)).limit(1);
  return row ? toQueueTaskRow(row) : null;
}

/** Rows after `cursor` in the list's newest-first order. */
export function beforeQueueCursor(cursor: TaskListCursor): SQL | undefined {
  const cursorDate = new Date(cursor.createdAt);
  return or(
    lt(tasks.createdAt, cursorDate),
    and(eq(tasks.createdAt, cursorDate), lt(tasks.id, cursor.id)),
  );
}
