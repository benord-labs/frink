import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { chats, subChatMessages, subChats, tasks } from '../../db/schema';
import { seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import { carryOnFlowTask } from './carry-on';

const GRAPH: FlowGraph = {
  nodes: [{ id: 'agent', blockType: 'agent', config: { instructions: 'work' } }],
  edges: [],
};

let db: TestDb;
let sequence = 0;

beforeEach(() => {
  db = freshDb();
  sequence = 0;
});

const dispatchedPrompt = (taskId: string) => ({
  id: `u-${taskId}`,
  role: 'user',
  parts: [],
  metadata: { dispatchTaskId: taskId },
});

/** A failed manual task; `answered` persists its prompt (stamped with its id) and the session's reply. */
async function seedTask(sessionId: string | null, answered = true): Promise<string> {
  sequence += 1;
  const chatId = `chat-${sequence}`;
  const subChatId = `sub-${sequence}`;
  const taskId = `task-${sequence}`;
  await db.insert(chats).values({ id: chatId, name: `chat ${sequence}` });
  await db.insert(subChats).values({ id: subChatId, chatId, sessionId });
  await db.insert(tasks).values({
    id: taskId,
    description: `task ${sequence}`,
    source: 'manual',
    status: 'failed',
    result: { subChatId },
  });
  if (answered) {
    const prompt = dispatchedPrompt(taskId);
    const reply = { id: 'a1', role: 'assistant', parts: [] };
    await db.insert(subChatMessages).values([
      { subChatId, seq: 0, message: JSON.stringify(prompt) },
      { subChatId, seq: 1, message: JSON.stringify(reply) },
    ]);
  }
  return taskId;
}

const taskStatus = async (taskId: string): Promise<string> =>
  (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]?.status ?? 'missing';

describe('carryOnFlowTask', () => {
  it('rejects Flow-linked carry-on without mutating the task', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const taskId = await seedTask('session-1');
    await db.update(tasks).set({ flowRunId, source: 'flow' }).where(eq(tasks.id, taskId));

    await expect(carryOnFlowTask(db, taskId)).resolves.toEqual({
      ok: false,
      reason: 'admission-required',
    });
    expect(await taskStatus(taskId)).toBe('failed');
  });

  it('rejects a regular task without a resumable session', async () => {
    const taskId = await seedTask(null);

    await expect(carryOnFlowTask(db, taskId)).resolves.toEqual({
      ok: false,
      reason: 'no-session',
    });
    expect(await taskStatus(taskId)).toBe('failed');
  });

  it('rejects a regular task whose prompt its session never answered', async () => {
    const taskId = await seedTask('session-1', false);

    await expect(carryOnFlowTask(db, taskId)).resolves.toEqual({ ok: false, reason: 'no-session' });
    expect(await taskStatus(taskId)).toBe('failed');
  });

  it('resumes a regular task with a persisted session', async () => {
    const taskId = await seedTask('session-1');

    await expect(carryOnFlowTask(db, taskId)).resolves.toMatchObject({ ok: true });
    expect(await taskStatus(taskId)).toBe('pending');
  });

  it('refuses to carry on into an archived chat, linked by result or by the chat anchor', async () => {
    const byResult = await seedTask('session-1');
    await db
      .update(tasks)
      .set({ result: { subChatId: 'sub-1', chatId: 'chat-1' } })
      .where(eq(tasks.id, byResult));
    await db.update(chats).set({ archivedAt: new Date() }).where(eq(chats.id, 'chat-1'));
    const byAnchor = await seedTask('session-2');
    await db
      .update(chats)
      .set({ taskId: byAnchor, archivedAt: new Date() })
      .where(eq(chats.id, 'chat-2'));

    for (const taskId of [byResult, byAnchor]) {
      await expect(carryOnFlowTask(db, taskId)).resolves.toEqual({
        ok: false,
        reason: 'chat-archived',
      });
      expect(await taskStatus(taskId)).toBe('failed');
    }
  });

  it('carries on when the linked chat is live', async () => {
    const taskId = await seedTask('session-1');
    await db
      .update(tasks)
      .set({ result: { subChatId: 'sub-1', chatId: 'chat-1' } })
      .where(eq(tasks.id, taskId));

    await expect(carryOnFlowTask(db, taskId)).resolves.toMatchObject({ ok: true });
  });

  it('returns not-found for a missing task', async () => {
    await expect(carryOnFlowTask(db, 'missing')).resolves.toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('does not mutate a task whose latest state is not retryable', async () => {
    const taskId = await seedTask('session-1');
    await db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, taskId));

    await expect(carryOnFlowTask(db, taskId)).resolves.toEqual({
      ok: false,
      reason: 'invalid-state',
    });
    expect(await taskStatus(taskId)).toBe('done');
  });

  // The check and the write share one transaction, so a change landing before the write is seen.
  it.each([
    ['a rollback empties the session', () => db.update(subChats).set({ sessionId: '' }).run()],
    [
      'a newer turn answers in the same session',
      () =>
        db
          .insert(subChatMessages)
          .values([
            { subChatId: 'sub-1', seq: 2, message: JSON.stringify(dispatchedPrompt('newer')) },
            { subChatId: 'sub-1', seq: 3, message: '{"id":"a2","role":"assistant","parts":[]}' },
          ])
          .run(),
    ],
    [
      'a newer attempt moves the task to an unanswered session',
      () => {
        db.insert(subChats).values({ id: 'sub-new', chatId: 'chat-1', sessionId: 's2' }).run();
        db.update(tasks)
          .set({ result: { subChatId: 'sub-new' } })
          .where(eq(tasks.id, 'task-1'))
          .run();
      },
    ],
  ])('keeps the task stopped when %s before the write', async (_case, change) => {
    const taskId = await seedTask('session-1');
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce((command, config) => {
      change();
      return transaction(command, config);
    });

    await expect(carryOnFlowTask(db, taskId)).resolves.toEqual({ ok: false, reason: 'no-session' });
    expect(await taskStatus(taskId)).toBe('failed');
  });

  it('returns not-found when the task is deleted before the write', async () => {
    const taskId = await seedTask('session-1');
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementation((command, config) => {
      db.delete(tasks).where(eq(tasks.id, taskId)).run();
      return transaction(command, config);
    });

    await expect(carryOnFlowTask(db, taskId)).resolves.toEqual({ ok: false, reason: 'not-found' });
  });
});
