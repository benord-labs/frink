/** Archive is a soft delete: it stops the manual Work Queue task its chat drives, atomically. */
import { and, eq, isNotNull, inArray, isNull, or } from 'drizzle-orm';
import type { getDatabase } from '../../index';
import { type Chat, chats, type Task, tasks } from '../../schema';
import { cancelTaskDetailed } from '../tasks';
import { chatLinkId } from './linked-flow-runs';

type Db = ReturnType<typeof getDatabase>;

/** The statuses the old "Stop task + archive" stopped. `needs_attention` stays reachable from the
 * Work Queue, as user-docs/task-lifecycle.md documents. */
const ARCHIVE_STOPPED_TASK_STATUSES = ['pending', 'running', 'plan_ready'] as const;

export type ArchiveChatResult = {
  chat: Chat | null;
  /** Pre-cancel rows; the caller stops their sessions once this has committed. */
  cancelledPrevious: Task[];
};

/**
 * Cancel the chat's live manual tasks (linked by `chats.task_id` or `tasks.result.chatId`) and set
 * `archived_at` in one transaction. Flow tasks are left to their run's chat-scoped cancel.
 */
export function archiveChatCancellingLinkedTasks(db: Db, chatId: string): ArchiveChatResult {
  return db.transaction(() => {
    const anchorTaskId = db
      .select({ taskId: chats.taskId })
      .from(chats)
      .where(eq(chats.id, chatId))
      .get()?.taskId;
    const linked = or(
      eq(chatLinkId(tasks.result, '$.chatId'), chatId),
      anchorTaskId ? eq(tasks.id, anchorTaskId) : undefined,
    );
    const live = db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          linked,
          isNull(tasks.flowRunId),
          inArray(tasks.status, [...ARCHIVE_STOPPED_TASK_STATUSES]),
        ),
      )
      .all();

    const cancelledPrevious: Task[] = [];
    for (const { id } of live) {
      const { previous, task } = cancelTaskDetailed(db, id);
      if (task && previous) cancelledPrevious.push(previous);
    }

    const [chat] = db
      .update(chats)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(chats.id, chatId))
      .returning()
      .all();
    return { chat: chat ?? null, cancelledPrevious };
  });
}

export function isChatArchived(db: Db, chatId: string): boolean {
  const row = db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.id, chatId), isNotNull(chats.archivedAt)))
    .get();
  return row !== undefined;
}

/** Whether a chat the task is linked to (by `chats.task_id` or its result's chatId) is archived. */
export function isTaskChatArchived(db: Db, task: Pick<Task, 'id'>): boolean {
  const resultChatId = db
    .select({ chatId: chatLinkId(tasks.result, '$.chatId') })
    .from(tasks)
    .where(eq(tasks.id, task.id));
  const row = db
    .select({ id: chats.id })
    .from(chats)
    .where(
      and(
        isNotNull(chats.archivedAt),
        or(eq(chats.taskId, task.id), inArray(chats.id, resultChatId)),
      ),
    )
    .get();
  return row !== undefined;
}
