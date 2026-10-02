import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { chats, flowRuns, nodeRuns, subChatMessages, subChats, tasks } from '../../db/schema';
import { seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';

const mocks = vi.hoisted(() => ({
  hasActiveFlowAdmission: vi.fn(),
  reconcile: vi.fn(async () => {}),
}));

vi.mock('../admission/runtime', () => ({
  hasActiveFlowAdmission: mocks.hasActiveFlowAdmission,
}));

import { setFlowAdmissionLifecycleHooks } from '../admission/activity';
import { carryOnFlowTask } from './carry-on';

const GRAPH: FlowGraph = {
  nodes: [{ id: 'agent', blockType: 'agent', config: { instructions: 'work' } }],
  edges: [],
};

let db: TestDb;
let flowRunId: string;
let taskId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  db = freshDb();
  ({ flowRunId } = await seedFlowRun(db, GRAPH));
  await db.update(flowRuns).set({ status: 'paused' }).where(eq(flowRuns.id, flowRunId));
  await db.insert(chats).values({ id: 'chat-1', name: 'Flow chat' });
  await db.insert(subChats).values({ id: 'sub-1', chatId: 'chat-1', sessionId: 'session-1' });
  taskId = 'task-1';
  await db.insert(nodeRuns).values({ id: 'nr-1', flowRunId, nodeId: 'agent', blockType: 'agent' });
  await db.insert(tasks).values({
    id: taskId,
    description: 'Continue the Flow',
    source: 'flow',
    status: 'needs_attention',
    flowRunId,
    sourceId: 'nr-1',
    result: { subChatId: 'sub-1' },
  });
  await seedTranscript(true);
  mocks.hasActiveFlowAdmission.mockResolvedValue(true);
  setFlowAdmissionLifecycleHooks({
    reconcile: mocks.reconcile,
    requestRelease: vi.fn(async () => {}),
  });
});

/** The task's dispatched prompt in the sub-chat, plus the session's reply when `answered`. */
async function seedTranscript(answered: boolean): Promise<void> {
  await db.delete(subChatMessages);
  const prompt = { id: 'u1', role: 'user', parts: [], metadata: { dispatchTaskId: 'task-1' } };
  const reply = { id: 'a1', role: 'assistant', parts: [] };
  await db
    .insert(subChatMessages)
    .values([
      { subChatId: 'sub-1', seq: 0, message: JSON.stringify(prompt) },
      ...(answered ? [{ subChatId: 'sub-1', seq: 1, message: JSON.stringify(reply) }] : []),
    ]);
}

const taskStatus = async (): Promise<string> =>
  (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]?.status ?? 'missing';

describe('carryOnFlowTask admission', () => {
  it('continues a paused non-batch Flow through its active admission', async () => {
    await expect(carryOnFlowTask(db, taskId)).resolves.toMatchObject({ ok: true });
    expect(await taskStatus()).toBe('pending');
    expect(mocks.hasActiveFlowAdmission).toHaveBeenCalledWith(flowRunId);
  });

  it("refuses when the shared session never answered this task's node — nothing of it to continue", async () => {
    await seedTranscript(false);

    await expect(carryOnFlowTask(db, taskId)).resolves.toEqual({
      ok: false,
      reason: 'no-session',
    });
    expect(await taskStatus()).toBe('needs_attention');
  });

  it('refuses the continuation after the Flow admission is gone', async () => {
    mocks.hasActiveFlowAdmission.mockResolvedValue(false);

    await expect(carryOnFlowTask(db, taskId)).resolves.toEqual({
      ok: false,
      reason: 'admission-required',
    });
    expect(await taskStatus()).toBe('needs_attention');
  });

  it('does not flip the task pending when cancellation wins after the admission check starts', async () => {
    mocks.hasActiveFlowAdmission.mockImplementation(async () => {
      await db.update(flowRuns).set({ status: 'cancelled' }).where(eq(flowRuns.id, flowRunId));
      return true;
    });

    await expect(carryOnFlowTask(db, taskId)).resolves.toEqual({
      ok: false,
      reason: 'invalid-state',
    });
    expect(await taskStatus()).toBe('needs_attention');
  });

  it('probes admission for a paused batch member exactly like a non-batch Flow', async () => {
    await db.update(flowRuns).set({ batchId: 'batch-1' }).where(eq(flowRuns.id, flowRunId));

    await expect(carryOnFlowTask(db, taskId)).resolves.toMatchObject({ ok: true });
    expect(await taskStatus()).toBe('pending');
    expect(mocks.hasActiveFlowAdmission).toHaveBeenCalledWith(flowRunId);
  });

  it('rejects a batch member whose run is not paused without probing admission', async () => {
    await db
      .update(flowRuns)
      .set({ batchId: 'batch-1', status: 'failed' })
      .where(eq(flowRuns.id, flowRunId));

    await expect(carryOnFlowTask(db, taskId)).resolves.toEqual({
      ok: false,
      reason: 'admission-required',
    });
    expect(await taskStatus()).toBe('needs_attention');
    expect(mocks.hasActiveFlowAdmission).not.toHaveBeenCalled();
  });
});
