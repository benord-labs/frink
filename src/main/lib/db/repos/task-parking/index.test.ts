import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { flowRuns } from '../../schema';
import { seedFlowRun } from '../../test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../test-utils/fresh-db';
import { createTask, getTaskById, updateTaskStatus } from '../tasks';
import { parkFlowTaskForSubChat } from './index';

const GRAPH = {
  nodes: [{ id: 'a1', blockType: 'agent', config: {}, position: { x: 0, y: 0 } }],
  edges: [],
};

describe('parkFlowTaskForSubChat — batch members park the same as any other flow task', () => {
  let db: TestDb;
  let flowRunId: string;

  beforeEach(async () => {
    db = freshDb();
    ({ flowRunId } = await seedFlowRun(db, GRAPH));
  });

  const runningFlowTask = async (subChatId: string) => {
    const task = await createTask(db, {
      description: 'agent turn',
      source: 'flow',
      flowRunId,
      result: { subChatId, chatId: 'c1' },
    });
    await updateTaskStatus(db, task.id, 'running');
    return task;
  };

  it('non-batch flow task parks needs_attention with result.apiError (linkage preserved)', async () => {
    const task = await runningFlowTask('sc-park');

    const parkedId = await parkFlowTaskForSubChat(db, 'sc-park', {
      kind: 'api-error',
      status: null,
      message: 'claude stream exploded',
    });

    expect(parkedId).toBe(task.id);
    const row = await getTaskById(db, task.id);
    expect(row?.status).toBe('needs_attention');
    expect(row?.result).toMatchObject({
      subChatId: 'sc-park',
      apiError: { message: 'claude stream exploded', status: null },
    });
  });

  it('batch member + api-error parks needs_attention with result.apiError (no result.error)', async () => {
    await db.update(flowRuns).set({ batchId: 'batch-1' }).where(eq(flowRuns.id, flowRunId));
    const task = await runningFlowTask('sc-batch');

    const parkedId = await parkFlowTaskForSubChat(db, 'sc-batch', {
      kind: 'api-error',
      status: 529,
      message: 'overloaded',
    });

    expect(parkedId).toBe(task.id);
    const row = await getTaskById(db, task.id);
    expect(row?.status).toBe('needs_attention');
    expect(row?.result).toMatchObject({
      subChatId: 'sc-batch',
      apiError: { message: 'overloaded', status: 529 },
    });
    expect(row?.result).not.toHaveProperty('error');
  });

  it('no-ops against an already-parked task — a fallback park must never clobber a user pause', async () => {
    const task = await runningFlowTask('sc-already-parked');
    await updateTaskStatus(db, task.id, 'needs_attention', {
      result: { subChatId: 'sc-already-parked', chatId: 'c1', userPause: { at: 'x' } },
    });

    const parkedId = await parkFlowTaskForSubChat(db, 'sc-already-parked', {
      kind: 'api-error',
      status: null,
      message: 'The operation was aborted',
    });

    expect(parkedId).toBeNull();
    const row = await getTaskById(db, task.id);
    expect(row?.status).toBe('needs_attention');
    const result = row?.result as Record<string, unknown>;
    expect(result.userPause).toBeDefined();
    expect(result.apiError).toBeUndefined();
  });

  it('batch member + user-pause parks needs_attention with result.userPause', async () => {
    await db.update(flowRuns).set({ batchId: 'batch-1' }).where(eq(flowRuns.id, flowRunId));
    const task = await runningFlowTask('sc-pause');

    const parkedId = await parkFlowTaskForSubChat(db, 'sc-pause', { kind: 'user-pause' });

    expect(parkedId).toBe(task.id);
    const row = await getTaskById(db, task.id);
    expect(row?.status).toBe('needs_attention');
    const result = row?.result as Record<string, unknown>;
    expect(result.userPause).toBeDefined();
  });
});
