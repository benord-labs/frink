import { beforeEach, describe, expect, it } from 'vitest';
import { getFlowRun, setFlowRunStatus } from '../../db/repos/flow-runs';
import { createNodeRun, listNodeRunsForFlowRun, setNodeRunStatus } from '../../db/repos/node-runs';
import { cancelChatOwnedFlowWorkForArchive } from '../../db/repos/task-queries/chat-flow-cleanup';
import { createTask, getTaskById, type TaskStatus, updateTaskStatus } from '../../db/repos/tasks';
import { seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import { cancelRunRows, runTransition } from '.';

const GRAPH = { nodes: [], edges: [], settings: {} };

describe('run-row transitions', () => {
  let db: TestDb;
  let flowRunId: string;

  beforeEach(async () => {
    db = freshDb();
    ({ flowRunId } = await seedFlowRun(db, GRAPH));
  });

  const taskIn = async (status: TaskStatus) => {
    const task = await createTask(db, { description: status, source: 'flow', flowRunId });
    await updateTaskStatus(db, task.id, status, { result: { subChatId: `sc-${status}` } });
    return task.id;
  };

  const taskStatuses = async (ids: string[]) =>
    Promise.all(ids.map(async (id) => (await getTaskById(db, id))?.status));

  describe('cancelRunRows', () => {
    it('cancels a live run, its unfinished nodes and its executing tasks, keeping parked ones', async () => {
      const done = await createNodeRun(db, { flowRunId, nodeId: 'a', blockType: 'x' });
      await setNodeRunStatus(db, done.id, 'completed');
      await createNodeRun(db, { flowRunId, nodeId: 'b', blockType: 'x', status: 'awaiting_input' });
      const tasks = await Promise.all(
        (['running', 'pending', 'needs_attention', 'plan_ready'] as const).map(taskIn),
      );
      const now = new Date('2026-09-01T00:00:00Z');

      expect(
        runTransition(db, () => cancelRunRows(db, flowRunId, { includeParked: false }, now)),
      ).toBe(true);

      expect(await getFlowRun(db, flowRunId)).toMatchObject({
        status: 'cancelled',
        completedAt: now,
      });
      expect((await listNodeRunsForFlowRun(db, flowRunId)).map((node) => node.status)).toEqual([
        'completed',
        'cancelled',
      ]);
      expect(await taskStatuses(tasks)).toEqual([
        'cancelled',
        'cancelled',
        'needs_attention',
        'plan_ready',
      ]);
      // The cancel marker merges into the result, so the sub-chat linkage survives.
      expect((await getTaskById(db, tasks[0]))?.result).toMatchObject({
        cancelled: true,
        subChatId: 'sc-running',
      });
    });

    it('sweeps parked tasks too when asked', async () => {
      const tasks = await Promise.all((['needs_attention', 'plan_ready'] as const).map(taskIn));

      cancelRunRows(db, flowRunId, { includeParked: true });

      expect(await taskStatuses(tasks)).toEqual(['cancelled', 'cancelled']);
    });

    it.each(['completed', 'failed', 'cancelled'] as const)(
      'writes nothing for a %s run',
      async (status) => {
        await setFlowRunStatus(db, flowRunId, status);
        const node = await createNodeRun(db, { flowRunId, nodeId: 'a', blockType: 'x' });
        const task = await taskIn('running');

        expect(cancelRunRows(db, flowRunId, { includeParked: true })).toBe(false);

        expect((await getFlowRun(db, flowRunId))?.status).toBe(status);
        expect((await listNodeRunsForFlowRun(db, flowRunId))[0]).toMatchObject({
          id: node.id,
          status: 'pending',
        });
        expect((await getTaskById(db, task))?.status).toBe('running');
      },
    );
  });

  it('archiving a chat cancels its run but keeps its parked review task for restore', async () => {
    const inChat = async (status: TaskStatus) => {
      const task = await createTask(db, { description: status, source: 'flow', flowRunId });
      await updateTaskStatus(db, task.id, status, { result: { chatId: 'chat-a' } });
      return task.id;
    };
    const tasks = [await inChat('running'), await inChat('needs_attention')];

    expect(cancelChatOwnedFlowWorkForArchive(db, flowRunId, ['chat-a'])).toEqual({
      outcome: 'cancelled',
      droppedTicket: false,
      liveTicket: null,
    });

    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
    expect(await taskStatuses(tasks)).toEqual(['cancelled', 'needs_attention']);
  });
});
