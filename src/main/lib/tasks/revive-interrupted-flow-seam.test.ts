/** Seam: a revive declined for lack of an admission slot leaves task, run and marker intact, so the
 * follow-up park's `running` CAS matches nothing and Re-run can still recover the run. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type NodeOutput, RESTART_INTERRUPTION_REASON } from '../../../shared/types/flow';
import { getFlowRun, setFlowRunStatus } from '../db/repos/flow-runs';
import { createNodeRun, getNodeRun, setNodeRunStatus } from '../db/repos/node-runs';
import { createSubChat } from '../db/repos/sub-chats';
import { parkFlowTaskForSubChat } from '../db/repos/task-parking';
import { createTask, getTaskById, updateTaskStatus } from '../db/repos/tasks';
import { chats } from '../db/schema';
import { seedFlowRun } from '../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import { _setFlowAdmissionControllerForTests } from '../flows/admission/runtime';
import { reviveRestartInterruptedFlow } from './revive-interrupted-flow';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getDatabase: () => holder.db,
}));

const SUB_CHAT_ID = 'sc-seam';

describe('declined revive keeps the run recoverable (revive → park seam)', () => {
  let db: TestDb;
  let runId: string;
  let nodeRunId: string;
  let taskId: string;

  beforeEach(async () => {
    db = freshDb();
    holder.db = db;
    // No admission row is seeded, so the run holds no active slot.
    _setFlowAdmissionControllerForTests(null);
    const seeded = await seedFlowRun(db, { nodes: [], edges: [] }, { idempotencyKey: 'k-seam' });
    runId = seeded.flowRunId;
    await db.insert(chats).values({ id: 'chat-seam' });
    await createSubChat(db, {
      id: SUB_CHAT_ID,
      chatId: 'chat-seam',
      name: 'main',
      sessionId: 'session-seam',
    });
    // The exact shape crash teardown leaves behind: node + task cancelled with the restart
    // marker, run terminal `cancelled`, admission slot settled (the mock above).
    const nodeRun = await createNodeRun(db, { flowRunId: runId, nodeId: 'a', blockType: 'agent' });
    nodeRunId = nodeRun.id;
    await setNodeRunStatus(db, nodeRunId, 'cancelled', {
      completedAt: new Date(),
      nodeOutput: {
        status: 'cancelled',
        outputs: {},
        artifacts: [],
        durationMs: 0,
        error: { message: RESTART_INTERRUPTION_REASON, retryable: true },
      },
    });
    await setFlowRunStatus(db, runId, 'cancelled');
    const task = await createTask(db, {
      description: 'agent step',
      source: 'flow',
      flowRunId: runId,
      result: { subChatId: SUB_CHAT_ID },
    });
    taskId = task.id;
    await updateTaskStatus(db, taskId, 'cancelled', {
      result: { subChatId: SUB_CHAT_ID, cancelled: true, error: RESTART_INTERRUPTION_REASON },
    });
  });

  it('leaves task, run and marker untouched, and the follow-up park cannot fire', async () => {
    await reviveRestartInterruptedFlow(taskId, runId, SUB_CHAT_ID);

    expect((await getTaskById(db, taskId))?.status).toBe('cancelled');
    expect((await getFlowRun(db, runId))?.status).toBe('cancelled');

    // The turn that would have followed the revive ends in a park attempt; with no `running`
    // task its CAS matches nothing, so the run is never rewritten to `paused`.
    expect(
      await parkFlowTaskForSubChat(db, SUB_CHAT_ID, {
        kind: 'api-error',
        status: null,
        message: 'no longer admitted',
      }),
    ).toBeNull();
    expect((await getFlowRun(db, runId))?.status).toBe('cancelled');

    const nodeOutput = (await getNodeRun(db, nodeRunId))?.nodeOutput as NodeOutput | null;
    expect(nodeOutput?.error?.message).toBe(RESTART_INTERRUPTION_REASON);
  });
});
