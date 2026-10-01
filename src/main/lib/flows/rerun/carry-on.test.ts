import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { chats, subChats, tasks } from '../../db/schema';
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

async function seedTask(sessionId: string | null): Promise<string> {
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

  it('resumes a regular task with a persisted session', async () => {
    const taskId = await seedTask('session-1');

    await expect(carryOnFlowTask(db, taskId)).resolves.toMatchObject({ ok: true });
    expect(await taskStatus(taskId)).toBe('pending');
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
});
