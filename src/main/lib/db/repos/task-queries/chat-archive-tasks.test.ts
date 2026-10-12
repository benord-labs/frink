import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createChat, getChatById, linkChatToTask, unarchiveChat } from '../chats';
import {
  claimTask,
  createTask,
  getTaskById,
  startExecutionFromReviewDetailed,
  type TaskResultRecord,
  type TaskStatus,
  updateTaskStatus,
} from '../tasks';
import { seedFlowRun } from '../../test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../test-utils/fresh-db';
import { archiveChatCancellingLinkedTasks } from './chat-archive-tasks';

let db: TestDb;

beforeEach(() => {
  db = freshDb();
});

async function manualTask(status: TaskStatus, result?: TaskResultRecord) {
  const task = await createTask(db, { description: 'manual', source: 'manual' });
  if (status !== 'pending' || result) updateTaskStatus(db, task.id, status, { result });
  return task;
}

describe('archiveChatCancellingLinkedTasks', () => {
  it('cancels the running task the chat anchors and archives the chat', async () => {
    const chat = await createChat(db, { projectId: null, name: 'c' });
    const task = await manualTask('running', { chatId: chat.id, subChatId: 'sub-1' });
    await linkChatToTask(db, chat.id, task.id);

    const { chat: archived, cancelledPrevious } = archiveChatCancellingLinkedTasks(db, chat.id);

    expect(archived?.archivedAt).toBeInstanceOf(Date);
    expect((await getTaskById(db, task.id))?.status).toBe('cancelled');
    // The pre-cancel row, so the caller can stop the running session after the commit.
    expect(cancelledPrevious.map((row) => [row.id, row.status])).toEqual([[task.id, 'running']]);
  });

  it('cancels a pending or plan-ready task linked only through its result', async () => {
    const chat = await createChat(db, { projectId: null, name: 'c' });
    const planReady = await manualTask('plan_ready', { chatId: chat.id });
    const pending = await manualTask('pending', { chatId: chat.id, retryMode: 'continue' });

    archiveChatCancellingLinkedTasks(db, chat.id);

    expect((await getTaskById(db, planReady.id))?.status).toBe('cancelled');
    expect((await getTaskById(db, pending.id))?.status).toBe('cancelled');
  });

  it("leaves parked, finished, flow and other chats' tasks alone", async () => {
    const chat = await createChat(db, { projectId: null, name: 'c' });
    const other = await createChat(db, { projectId: null, name: 'other' });
    const parked = await manualTask('needs_attention', { chatId: chat.id });
    const done = await manualTask('done', { chatId: chat.id });
    const elsewhere = await manualTask('running', { chatId: other.id });
    const { flowRunId } = await seedFlowRun(db, { nodes: [], edges: [] });
    const flowTask = await createTask(db, {
      description: 'flow',
      source: 'flow',
      flowRunId,
      result: { chatId: chat.id },
    });
    updateTaskStatus(db, flowTask.id, 'running');

    const { cancelledPrevious } = archiveChatCancellingLinkedTasks(db, chat.id);

    expect(cancelledPrevious).toEqual([]);
    expect((await getTaskById(db, parked.id))?.status).toBe('needs_attention');
    expect((await getTaskById(db, done.id))?.status).toBe('done');
    expect((await getTaskById(db, elsewhere.id))?.status).toBe('running');
    // A flow task is its run's to cancel (chat-scoped), never the archive's.
    expect((await getTaskById(db, flowTask.id))?.status).toBe('running');
  });

  it('archives neither the chat nor cancels the task when the cancel fails', async () => {
    const chat = await createChat(db, { projectId: null, name: 'c' });
    const task = await manualTask('running', { chatId: chat.id });
    db.run(
      sql.raw(`CREATE TRIGGER refuse_cancel BEFORE UPDATE OF status ON tasks
        WHEN NEW.status = 'cancelled' BEGIN SELECT RAISE(ABORT, 'cancel refused'); END`),
    );

    expect(() => archiveChatCancellingLinkedTasks(db, chat.id)).toThrow(/cancel refused/);

    expect((await getChatById(db, chat.id))?.archivedAt).toBeNull();
    expect((await getTaskById(db, task.id))?.status).toBe('running');
  });

  it('leaves nothing for a claim or a plan start that lands after the archive', async () => {
    const chat = await createChat(db, { projectId: null, name: 'c' });
    const pending = await manualTask('pending', { chatId: chat.id, retryMode: 'continue' });
    const planReady = await manualTask('plan_ready', { chatId: chat.id });

    archiveChatCancellingLinkedTasks(db, chat.id);

    expect(await claimTask(db, pending.id, 'machine')).toBeNull();
    expect(await startExecutionFromReviewDetailed(db, planReady.id, 'machine')).toEqual({
      task: null,
      reason: 'invalid_state',
    });
  });

  // Two panes can archive the same chat; the second must not hand back the first one's cancelled
  // rows, or the router would stop the same session twice.
  it('cancels nothing more when the chat is archived a second time', async () => {
    const chat = await createChat(db, { projectId: null, name: 'c' });
    await manualTask('running', { chatId: chat.id, subChatId: 'sub-1' });

    archiveChatCancellingLinkedTasks(db, chat.id);
    const again = archiveChatCancellingLinkedTasks(db, chat.id);

    expect(again.chat?.archivedAt).toBeInstanceOf(Date);
    expect(again.cancelledPrevious).toEqual([]);
  });

  // Product rule: restore brings the chat back, never the work archive stopped.
  it('keeps the task cancelled when the chat is restored', async () => {
    const chat = await createChat(db, { projectId: null, name: 'c' });
    const task = await manualTask('running', { chatId: chat.id });

    archiveChatCancellingLinkedTasks(db, chat.id);
    await unarchiveChat(db, chat.id);

    expect((await getChatById(db, chat.id))?.archivedAt).toBeNull();
    expect((await getTaskById(db, task.id))?.status).toBe('cancelled');
  });

  it('returns a null chat and touches nothing for an unknown chat id', () => {
    expect(archiveChatCancellingLinkedTasks(db, 'missing')).toEqual({
      chat: null,
      cancelledPrevious: [],
    });
  });
});
