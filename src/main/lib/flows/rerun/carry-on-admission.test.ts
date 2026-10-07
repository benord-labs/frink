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

describe('carryOnFlowTask — only the current attempt of a node carries on', () => {
  /** A Retry of the seeded task's node: its attempt becomes history and a new one takes its place. */
  async function retryNode(newAttemptStatus: string): Promise<void> {
    await db.update(tasks).set({ nodeRunId: 'nr-1', status: 'failed' }).where(eq(tasks.id, taskId));
    await db.update(nodeRuns).set({ status: 'superseded' }).where(eq(nodeRuns.id, 'nr-1'));
    await db.insert(nodeRuns).values({
      id: 'nr-2',
      flowRunId,
      nodeId: 'agent',
      blockType: 'agent',
      status: newAttemptStatus,
      attemptNumber: 2,
    });
  }

  it('refuses the attempt a Retry replaced while the new one runs under the re-paused run', async () => {
    await retryNode('awaiting_input');
    await db.insert(tasks).values({
      id: 'task-2',
      description: 'Retry of the step',
      source: 'flow',
      status: 'running',
      flowRunId,
      sourceId: 'nr-2',
      nodeRunId: 'nr-2',
      result: { subChatId: 'sub-1' },
    });

    await expect(carryOnFlowTask(db, taskId)).resolves.toEqual({ ok: false, reason: 'superseded' });
    expect(await taskStatus()).toBe('failed');
  });

  it('still refuses the replaced attempt when the new one failed too, and carries on the new one', async () => {
    await retryNode('failed');
    await db.insert(tasks).values({
      id: 'task-2',
      description: 'Retry of the step',
      source: 'flow',
      status: 'failed',
      flowRunId,
      sourceId: 'nr-2',
      nodeRunId: 'nr-2',
      result: { subChatId: 'sub-1' },
    });
    const prompt = { id: 'u2', role: 'user', parts: [], metadata: { dispatchTaskId: 'task-2' } };
    await db.insert(subChatMessages).values([
      { subChatId: 'sub-1', seq: 2, message: JSON.stringify(prompt) },
      {
        subChatId: 'sub-1',
        seq: 3,
        message: JSON.stringify({ id: 'a2', role: 'assistant', parts: [] }),
      },
    ]);

    await expect(carryOnFlowTask(db, taskId)).resolves.toEqual({ ok: false, reason: 'superseded' });
    expect(await taskStatus()).toBe('failed');
    await expect(carryOnFlowTask(db, 'task-2')).resolves.toMatchObject({ ok: true });
  });

  it('names the replaced attempt rather than the lost admission, whose advice is to Retry', async () => {
    await retryNode('awaiting_input');
    mocks.hasActiveFlowAdmission.mockResolvedValue(false);

    await expect(carryOnFlowTask(db, taskId)).resolves.toEqual({ ok: false, reason: 'superseded' });
    expect(mocks.hasActiveFlowAdmission).not.toHaveBeenCalled();
  });

  it('does not flip the task pending when a Retry replaces its attempt after the attempt check', async () => {
    await db.update(tasks).set({ nodeRunId: 'nr-1' }).where(eq(tasks.id, taskId));
    mocks.hasActiveFlowAdmission.mockImplementation(async () => {
      await db
        .insert(nodeRuns)
        .values({ id: 'nr-2', flowRunId, nodeId: 'agent', blockType: 'agent', attemptNumber: 2 });
      return true;
    });

    await expect(carryOnFlowTask(db, taskId)).resolves.toEqual({
      ok: false,
      reason: 'invalid-state',
    });
    expect(await taskStatus()).toBe('needs_attention');
  });
});

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
