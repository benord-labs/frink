import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { chats, flowRunAdmissions, flowRuns, nodeRuns } from '../schema';
import { seedCompletedNodeRun, seedFlowRun } from '../test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../test-utils/fresh-db';
import { createChat, getChatById, linkChatToTask } from './chats';
import {
  getActiveFlowDrivingStatusByRun,
  getActiveFlowRunForSubChat,
  getBatchIdByChatId,
  getLatestFlowRunForChat,
  getLatestRunsForFlows,
  getOrCreateFlowRunByIdempotencyKey,
  getNewestFlowRunForSubChat,
  listActiveFlowRunIdsForChat,
  listChatIdsWithActiveFlowRun,
  listChatsByBatch,
  listFlowRunsForFlow,
  listIncompleteFlowRunIdsForChat,
  recoverOrphanedFlowRuns,
  setFlowRunStatus,
} from './flow-runs';
import { cancelFlowTaskRows } from '../../flows/transitions/run-rows';
import { createFlowVersion } from './flow-versions';
import { createFlow } from './flows';
import {
  cancelRemainingNodeRunsForRun,
  cleanupNodeRunsForTerminalFlows,
  createNodeRun,
} from './node-runs';
import {
  deleteChatWithFlowQueueTasks,
  deleteFlowQueueTasksForChats,
} from './task-queries/chat-flow-cleanup';
import {
  createTask,
  getTaskById,
  listTasksWithProjectPaginated,
  type TaskStatus,
  updateTaskStatus,
} from './tasks';

// The exactly-once guarantee under webhook redelivery: a provider that re-sends the
// same delivery produces the same idempotency key (webhook:{intg}:{event}:{deliveryId}:{flowId}),
// and this atomic immediate-transaction SELECT-then-INSERT must yield ONE run, not two.
// handleVerifiedWebhookEvent's replayed-vs-fired count depends entirely on the isReplay return.

const GRAPH: FlowGraph = {
  nodes: [
    { id: 't', blockType: 'manual_trigger', position: { x: 0, y: 0 } },
    { id: 'a', blockType: 'agent', config: { instructions: 'go' }, position: { x: 0, y: 1 } },
  ],
  edges: [{ id: 'e1', source: 't', target: 'a' }],
};

describe('getOrCreateFlowRunByIdempotencyKey — exactly-once on replay', () => {
  let db: TestDb;
  let flowVersionId: string;

  beforeEach(async () => {
    db = freshDb();
    const flow = await createFlow(db, { name: 'F' });
    const version = await createFlowVersion(db, { flowId: flow.id, graph: GRAPH });
    flowVersionId = version.id;
  });

  const input = (idempotencyKey: string | null) => ({
    flowVersionId,
    userId: 'u1',
    status: 'running' as const,
    triggerContext: null,
    idempotencyKey,
    startedAt: new Date(),
  });

  it('returns the same run (isReplay) on a second call with the same key — no duplicate row', async () => {
    const key = 'webhook:integration-1:story_assigned:d1:flow-1';
    const first = await getOrCreateFlowRunByIdempotencyKey(db, input(key));
    const second = await getOrCreateFlowRunByIdempotencyKey(db, input(key));

    expect(first.isReplay).toBe(false);
    expect(second.isReplay).toBe(true);
    expect(second.run.id).toBe(first.run.id);

    const rows = await db.select().from(flowRuns).where(eq(flowRuns.idempotencyKey, key));
    expect(rows).toHaveLength(1);
  });

  it('treats a pre-existing row with the key as a replay (SELECT-hit branch)', async () => {
    const key = 'webhook:integration-1:story_assigned:d2:flow-1';
    const first = await getOrCreateFlowRunByIdempotencyKey(db, input(key));
    const replay = await getOrCreateFlowRunByIdempotencyKey(db, input(key));
    expect(replay.isReplay).toBe(true);
    expect(replay.run.id).toBe(first.run.id);
  });

  it('inserts distinct rows when idempotencyKey is null (no dedup — non-idempotent fast path)', async () => {
    const a = await getOrCreateFlowRunByIdempotencyKey(db, input(null));
    const b = await getOrCreateFlowRunByIdempotencyKey(db, input(null));
    expect(a.isReplay).toBe(false);
    expect(b.isReplay).toBe(false);
    expect(a.run.id).not.toBe(b.run.id);
  });
});

// Chat → flow-run linkage is JSON-only (no FK). chats.delete relies on this lookup to
// cancel the runs a deleted chat drives (regression: lost in the local-first migration).
describe('getNewestFlowRunForSubChat — the run that currently owns a sub-chat, in any status', () => {
  const SUB_CHAT = 'sub-live';
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  /** A run linked to SUB_CHAT the way no task can express: through its trigger context alone. */
  async function tasklessRun(key: string, status: 'running' | 'completed' | 'failed') {
    const flow = await createFlow(db, { name: key });
    const version = await createFlowVersion(db, { flowId: flow.id, graph: GRAPH });
    const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: version.id,
      status: 'running',
      triggerContext: { subChatId: SUB_CHAT },
      idempotencyKey: key,
      startedAt: new Date(),
    });
    if (status !== 'running')
      await setFlowRunStatus(db, run.id, status, { completedAt: new Date() });
    return run.id;
  }
  const taskOnRun = (flowRunId: string) =>
    createTask(db, {
      description: 'step',
      source: 'flow',
      flowRunId,
      result: { subChatId: SUB_CHAT },
    });

  const statusNow = async () => (await getNewestFlowRunForSubChat(db, SUB_CHAT))?.status ?? null;

  it('is null for a sub-chat no run is linked to', async () => {
    expect(await getNewestFlowRunForSubChat(db, SUB_CHAT)).toBeNull();
    expect(await getNewestFlowRunForSubChat(db, '')).toBeNull();
  });

  it('reports the linked run with its current status, ended or not', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await taskOnRun(flowRunId);
    for (const status of ['running', 'paused', 'failed', 'completed', 'cancelled'] as const) {
      await setFlowRunStatus(db, flowRunId, status);
      expect(await getNewestFlowRunForSubChat(db, SUB_CHAT)).toEqual({ id: flowRunId, status });
    }
  });

  it('finds a run in a taskless window, when only the run itself links to the sub-chat', async () => {
    const id = await tasklessRun('taskless', 'running');
    expect(await getNewestFlowRunForSubChat(db, SUB_CHAT)).toEqual({ id, status: 'running' });
  });

  it('is null once the run row is deleted, even with a task still in a driving status', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const task = await taskOnRun(flowRunId);
    await updateTaskStatus(db, task.id, 'running');
    await db.delete(flowRuns).where(eq(flowRuns.id, flowRunId));
    expect(await getNewestFlowRunForSubChat(db, SUB_CHAT)).toBeNull();
  });

  it('follows the newest run on a reused chat, not an older one', async () => {
    await tasklessRun('older-failed', 'failed');
    await tasklessRun('newer-completed', 'completed');
    expect(await statusNow()).toBe('completed');
    await tasklessRun('newest-running', 'running');
    expect(await statusNow()).toBe('running');
  });
});

describe('listActiveFlowRunIdsForChat', () => {
  const CHAT = 'chat-abc';
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  it('finds a run whose start_task node_output carries the chatId', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { chatId: CHAT },
    });
    expect(await listActiveFlowRunIdsForChat(db, CHAT)).toEqual([flowRunId]);
  });

  it('finds a run whose trigger_context carries the chatId (post_task fan-out)', async () => {
    const flow = await createFlow(db, { name: 'F' });
    const version = await createFlowVersion(db, { flowId: flow.id, graph: GRAPH });
    const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: version.id,
      status: 'running',
      triggerContext: { chatId: CHAT },
      idempotencyKey: 'fan-1',
      startedAt: new Date(),
    });
    expect(await listActiveFlowRunIdsForChat(db, CHAT)).toEqual([run.id]);
  });

  it('finds a branch run linked only by its task result', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await createTask(db, {
      description: 'branch',
      source: 'flow',
      flowRunId,
      result: { chatId: CHAT },
    });

    expect(await listActiveFlowRunIdsForChat(db, CHAT)).toEqual([flowRunId]);
  });

  it('ignores terminal runs and unrelated chats', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { chatId: CHAT },
    });
    await setFlowRunStatus(db, flowRunId, 'completed', { completedAt: new Date() });
    expect(await listActiveFlowRunIdsForChat(db, CHAT)).toEqual([]);
    expect(await listActiveFlowRunIdsForChat(db, 'unrelated')).toEqual([]);
  });

  it('leaves a terminal run to task-scoped archive cleanup', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const task = await createTask(db, {
      description: 'review',
      source: 'flow',
      flowRunId,
      result: { chatId: CHAT },
    });
    await updateTaskStatus(db, task.id, 'needs_attention');
    await setFlowRunStatus(db, flowRunId, 'failed', { completedAt: new Date() });

    expect(await listActiveFlowRunIdsForChat(db, CHAT)).toEqual([]);
  });

  it("does not borrow another chat's driving task to revive a terminal link", async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { chatId: CHAT },
    });
    const task = await createTask(db, {
      description: 'other branch',
      source: 'flow',
      flowRunId,
      result: { chatId: 'branch-chat' },
    });
    await updateTaskStatus(db, task.id, 'running');
    await setFlowRunStatus(db, flowRunId, 'failed', { completedAt: new Date() });

    expect(await listActiveFlowRunIdsForChat(db, CHAT)).toEqual([]);
    expect(await listActiveFlowRunIdsForChat(db, 'branch-chat')).toEqual([]);
  });

  it('returns each linked run once despite multiple matching node_runs', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { chatId: CHAT },
    });
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'ag',
      blockType: 'agent',
      outputs: { chatId: CHAT },
    });
    expect(await listActiveFlowRunIdsForChat(db, CHAT)).toEqual([flowRunId]);
  });
});

// Deleting a chat drops its flow tasks OUT of the work queue while the flow_run records stay for
// Flows → Runs history — otherwise an interrupted run's residual cancelled+marker rows would linger
// in Needs Attention pointing at a chat that no longer exists. Scoped by the task's OWN result.chatId
// (how a flow agent task records its chat), so a batched run's sibling-chat tasks are never wiped.
describe('deleteFlowQueueTasksForChats', () => {
  const CHAT = 'chat-del';
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  // A flow agent task carrying its driving chat in result.chatId.
  const flowTask = async (flowRunId: string, chatId: string, status: TaskStatus) => {
    const t = await createTask(db, {
      description: status,
      source: 'flow',
      flowRunId,
      result: { chatId },
    });
    if (status !== 'pending') await updateTaskStatus(db, t.id, status);
    return t;
  };

  it('refuses to delete a chat until its driving task is cancelled', async () => {
    const chat = await createChat(db, { name: 'C' });
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const task = await flowTask(flowRunId, chat.id, 'needs_attention');

    expect(deleteChatWithFlowQueueTasks(db, chat.id)).toEqual({
      deleted: false,
      unsettledRunIds: [flowRunId],
      chatIds: [chat.id],
    });
    expect(await getChatById(db, chat.id)).not.toBeNull();
    expect(await getTaskById(db, task.id)).not.toBeNull();

    cancelFlowTaskRows(db, flowRunId, true);
    await setFlowRunStatus(db, flowRunId, 'cancelled');
    expect(deleteChatWithFlowQueueTasks(db, chat.id)).toEqual({ deleted: true });
    expect(await getChatById(db, chat.id)).toBeNull();
    expect(await getTaskById(db, task.id)).toBeNull();
  });

  it('refuses deletion while a linked run is pending before its task row exists', async () => {
    const chat = await createChat(db, { name: 'C' });
    const flow = await createFlow(db, { name: 'F' });
    const version = await createFlowVersion(db, { flowId: flow.id, graph: GRAPH });
    const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: version.id,
      status: 'pending',
      triggerContext: { chatId: chat.id },
      idempotencyKey: 'pending-delete-race',
    });

    expect(deleteChatWithFlowQueueTasks(db, chat.id)).toEqual({
      deleted: false,
      unsettledRunIds: [run.id],
      chatIds: [chat.id],
    });
    expect(await getChatById(db, chat.id)).not.toBeNull();
  });

  it('refuses deletion while a linked terminal run still has a live admission', async () => {
    const chat = await createChat(db, { name: 'C' });
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'cancelled');
    db.insert(flowRunAdmissions)
      .values({
        flowRunId,
        priorityClass: 'start',
        intentVersion: 1,
        intentJson: { version: 1, action: 'start', flow_run_id: flowRunId },
      })
      .run();
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { chatId: chat.id },
    });

    expect(deleteChatWithFlowQueueTasks(db, chat.id)).toEqual({
      deleted: false,
      unsettledRunIds: [flowRunId],
      chatIds: [chat.id],
    });
    expect(await getChatById(db, chat.id)).not.toBeNull();
  });

  it('deletes an unclaimed task through its terminal run chat linkage', async () => {
    const chat = await createChat(db, { name: 'C' });
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { chatId: chat.id },
    });
    const task = await createTask(db, {
      description: 'not claimed yet',
      source: 'flow',
      flowRunId,
    });
    await setFlowRunStatus(db, flowRunId, 'cancelled');

    expect(deleteChatWithFlowQueueTasks(db, chat.id)).toEqual({ deleted: true });
    expect(await getChatById(db, chat.id)).toBeNull();
    expect(await getTaskById(db, task.id)).toBeNull();
  });

  it("deletes the chat's flow tasks but leaves the flow_run record", async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await flowTask(flowRunId, CHAT, 'done');
    await flowTask(flowRunId, CHAT, 'cancelled');
    await setFlowRunStatus(db, flowRunId, 'cancelled');

    expect(deleteFlowQueueTasksForChats(db, [CHAT])).toBe(2);
    // Gone from the work queue (no task rows to collapse)...
    const remaining = await listTasksWithProjectPaginated(db, {
      collapseByFlow: true,
    }).then((r) => r.items);
    expect(remaining).toHaveLength(0);
    // ...but the flow_run record survives for Flows → Runs history.
    expect(await db.select().from(flowRuns).where(eq(flowRuns.id, flowRunId))).toHaveLength(1);
  });

  // The correctness-review scenario: a batched/fan-out run hosts tasks for multiple chats. Deleting
  // the anchor chat must NOT wipe a still-live branch chat's task that happens to share the flow_run.
  it("spares a sibling chat's task sharing the same flow_run", async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const anchorTask = await flowTask(flowRunId, CHAT, 'cancelled');
    // Terminal, so only result.chatId (not the live-task guard) keeps it from being deleted.
    const branchTask = await flowTask(flowRunId, 'branch-chat', 'done');
    await setFlowRunStatus(db, flowRunId, 'cancelled');

    expect(deleteFlowQueueTasksForChats(db, [CHAT])).toBe(1);
    expect(await getTaskById(db, anchorTask.id)).toBeNull();
    expect(await getTaskById(db, branchTask.id)).not.toBeNull();
  });

  it('spares an unclaimed task while a sibling chat keeps the run alive', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { chatId: CHAT },
    });
    const anchorTask = await flowTask(flowRunId, CHAT, 'cancelled');
    const unclaimedTask = await createTask(db, {
      description: 'not claimed yet',
      source: 'flow',
      flowRunId,
    });
    const branchTask = await flowTask(flowRunId, 'branch-chat', 'running');

    expect(deleteFlowQueueTasksForChats(db, [CHAT])).toBe(1);
    expect(await getTaskById(db, anchorTask.id)).toBeNull();
    expect(await getTaskById(db, unclaimedTask.id)).not.toBeNull();
    expect(await getTaskById(db, branchTask.id)).not.toBeNull();
  });

  it("leaves an unrelated chat's task untouched", async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const task = await flowTask(flowRunId, CHAT, 'done');

    expect(deleteFlowQueueTasksForChats(db, ['unrelated'])).toBe(0);
    expect(await getTaskById(db, task.id)).not.toBeNull();
  });

  it('deletes a parked task only after cancellation terminalizes it', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const task = await flowTask(flowRunId, CHAT, 'needs_attention');
    const pending = await flowTask(flowRunId, CHAT, 'pending');
    await setFlowRunStatus(db, flowRunId, 'failed');
    cancelFlowTaskRows(db, flowRunId, true);

    expect(deleteFlowQueueTasksForChats(db, [CHAT])).toBe(2);
    expect(await getTaskById(db, task.id)).toBeNull();
    expect(await getTaskById(db, pending.id)).toBeNull();
  });

  it('leaves a LIVE task alone — its run may still be going for other branches', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const live = await flowTask(flowRunId, CHAT, 'running');

    expect(deleteFlowQueueTasksForChats(db, [CHAT])).toBe(0);
    expect(await getTaskById(db, live.id)).not.toBeNull();
  });

  it('deletes a detached flow task but never a manual task', async () => {
    const orphan = await createTask(db, {
      description: 'orphan',
      source: 'flow',
      result: { chatId: CHAT },
    });
    await updateTaskStatus(db, orphan.id, 'needs_attention');
    const manual = await createTask(db, {
      description: 'manual',
      source: 'manual',
      result: { chatId: CHAT },
    });

    expect(deleteFlowQueueTasksForChats(db, [CHAT])).toBe(1);
    expect(await getTaskById(db, orphan.id)).toBeNull();
    expect(await getTaskById(db, manual.id)).not.toBeNull();
  });
});

// Backs the rollback flow-completion gate: rollback stays suppressed for ANY non-completed run
// (in-progress AND terminally failed/cancelled — a failed run leaves node_runs desynced, recover
// by re-running the flow). Only a 'completed' run re-enables rollback.
describe('listIncompleteFlowRunIdsForChat', () => {
  const CHAT = 'chat-abc';
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  async function seedLinkedRun(
    status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled',
    link: 'node-output' | 'task-result' = 'node-output',
  ) {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    if (link === 'task-result') {
      await createTask(db, {
        description: 'branch',
        source: 'flow',
        flowRunId,
        result: { chatId: CHAT },
      });
    } else {
      await seedCompletedNodeRun(db, {
        flowRunId,
        nodeId: 'st',
        blockType: 'start_task',
        outputs: { chatId: CHAT },
      });
    }
    await setFlowRunStatus(db, flowRunId, status, {
      completedAt: status === 'running' || status === 'paused' ? undefined : new Date(),
    });
    return flowRunId;
  }

  it('blocks (returns the run) while in progress — running / paused', async () => {
    const running = await seedLinkedRun('running');
    expect(await listIncompleteFlowRunIdsForChat(db, CHAT)).toEqual([running]);
    db = freshDb();
    const paused = await seedLinkedRun('paused');
    expect(await listIncompleteFlowRunIdsForChat(db, CHAT)).toEqual([paused]);
  });

  it('blocks (returns the run) for a terminally failed run — by design, not auto-recovered', async () => {
    const failed = await seedLinkedRun('failed');
    expect(await listIncompleteFlowRunIdsForChat(db, CHAT)).toEqual([failed]);
  });

  it('blocks (returns the run) for a cancelled run', async () => {
    const cancelled = await seedLinkedRun('cancelled');
    expect(await listIncompleteFlowRunIdsForChat(db, CHAT)).toEqual([cancelled]);
  });

  it('re-enables (returns empty) only once the run is completed', async () => {
    await seedLinkedRun('completed');
    expect(await listIncompleteFlowRunIdsForChat(db, CHAT)).toEqual([]);
  });

  it('returns empty for a chat with no linked flow run', async () => {
    await seedLinkedRun('running');
    expect(await listIncompleteFlowRunIdsForChat(db, 'unrelated')).toEqual([]);
  });

  // A branch chat in a multi-agent run is linked only by its task result, never by a node output.
  it.each(['running', 'paused', 'failed', 'cancelled'] as const)(
    'blocks a branch chat linked only by its task result while the run is %s',
    async (status) => {
      const run = await seedLinkedRun(status, 'task-result');
      expect(await listIncompleteFlowRunIdsForChat(db, CHAT)).toEqual([run]);
    },
  );

  it('re-enables a branch chat linked only by its task result once the run is completed', async () => {
    await seedLinkedRun('completed', 'task-result');
    expect(await listIncompleteFlowRunIdsForChat(db, CHAT)).toEqual([]);
  });

  it('never blocks an ordinary chat whose task has no flow run', async () => {
    await seedLinkedRun('running');
    await createTask(db, { description: 'manual', source: 'manual', result: { chatId: 'plain' } });

    expect(await listIncompleteFlowRunIdsForChat(db, 'plain')).toEqual([]);
    expect(await listActiveFlowRunIdsForChat(db, 'plain')).toEqual([]);
    expect(await getLatestFlowRunForChat(db, 'plain')).toBeNull();
  });

  it('still blocks on a task-linked run after an older node-linked run completed', async () => {
    const completed = await seedLinkedRun('completed');
    const [{ flowVersionId }] = await db
      .select({ flowVersionId: flowRuns.flowVersionId })
      .from(flowRuns)
      .where(eq(flowRuns.id, completed));
    const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId,
      status: 'running',
      triggerContext: null,
      idempotencyKey: 'second-run',
      startedAt: new Date(),
    });
    await createTask(db, {
      description: 'branch',
      source: 'flow',
      flowRunId: run.id,
      result: { chatId: CHAT },
    });

    expect(await listIncompleteFlowRunIdsForChat(db, CHAT)).toEqual([run.id]);
  });
});

// Backs the flow-chat bottom surface's LIVENESS half: it must stay resolvable through the taskless
// windows a task row cannot represent, or the composer reappears mid-run (the node-2 regression).
describe('getActiveFlowRunForSubChat', () => {
  const SUB = 'sub-abc';
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  it('resolves the run via the start_task node_output when NO task exists yet', async () => {
    // The load-bearing case: between two agent nodes (and before the first task, and while a
    // non-agent node runs) there is no task row at all — only the start_task node_output links the
    // run to the sub-chat, and it does so for the run's whole life.
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { chatId: 'chat-1', subChatId: SUB },
    });
    expect(await getActiveFlowRunForSubChat(db, SUB)).toEqual({ id: flowRunId });
  });

  it('resolves the run via a TERMINAL task’s result (superset of getFlowDriveInfoForSubChat)', async () => {
    // getFlowDriveInfoForSubChat matches on tasks.result.$.subChatId; this resolver must cover that
    // link too, or a driving task could resolve with no run and hand the composer back that way.
    const { flowRunId, projectId } = await seedFlowRun(db, GRAPH);
    const task = await createTask(db, {
      projectId,
      description: 'node 1',
      source: 'flow',
      flowRunId,
      result: { subChatId: SUB },
    });
    await updateTaskStatus(db, task.id, 'done');
    expect(await getActiveFlowRunForSubChat(db, SUB)).toEqual({ id: flowRunId });
  });

  it('resolves the run via trigger_context (the chat_reply fast path)', async () => {
    const { versionId } = await seedFlowRun(db, GRAPH);
    const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: versionId,
      status: 'running',
      triggerContext: { chatId: 'chat-1', subChatId: SUB },
      idempotencyKey: 'k-trigger',
      startedAt: new Date(),
    });
    expect(await getActiveFlowRunForSubChat(db, SUB)).toEqual({ id: run.id });
  });

  it('returns null once the run is terminal — a finished flow hands the composer back', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { subChatId: SUB },
    });
    await setFlowRunStatus(db, flowRunId, 'completed', { completedAt: new Date() });
    expect(await getActiveFlowRunForSubChat(db, SUB)).toBeNull();
  });

  it('returns the NEWEST live run for a sub-chat reused across runs', async () => {
    // A flow chat reused per worktree links to several runs; the surface must report the CURRENT
    // one, never a previous run whose status would read terminal.
    const { versionId, flowRunId: first } = await seedFlowRun(db, GRAPH);
    await seedCompletedNodeRun(db, {
      flowRunId: first,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { subChatId: SUB },
    });
    await db
      .update(flowRuns)
      .set({ createdAt: new Date(1000) })
      .where(eq(flowRuns.id, first));

    const { run: second } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: versionId,
      status: 'running',
      triggerContext: null,
      idempotencyKey: 'k-second',
      startedAt: new Date(),
    });
    await seedCompletedNodeRun(db, {
      flowRunId: second.id,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { subChatId: SUB },
    });
    await db
      .update(flowRuns)
      .set({ createdAt: new Date(2000) })
      .where(eq(flowRuns.id, second.id));

    expect((await getActiveFlowRunForSubChat(db, SUB))?.id).toBe(second.id);
  });

  it('breaks a createdAt tie by insertion order (two runs stamped the same millisecond)', async () => {
    // The sibling reader added a rowid tie-break after a real millisecond collision; without one the
    // winner here is whatever the scan happens to yield, so a re-run could report the OLD run.
    const { versionId, flowRunId: first } = await seedFlowRun(db, GRAPH);
    await seedCompletedNodeRun(db, {
      flowRunId: first,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { subChatId: SUB },
    });
    const { run: second } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: versionId,
      status: 'running',
      triggerContext: null,
      idempotencyKey: 'k-tie',
      startedAt: new Date(),
    });
    await seedCompletedNodeRun(db, {
      flowRunId: second.id,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { subChatId: SUB },
    });
    const sameMs = new Date(5_000);
    await db.update(flowRuns).set({ createdAt: sameMs }).where(eq(flowRuns.id, first));
    await db.update(flowRuns).set({ createdAt: sameMs }).where(eq(flowRuns.id, second.id));

    expect((await getActiveFlowRunForSubChat(db, SUB))?.id).toBe(second.id);
  });

  it('returns ONE row despite the node_runs × tasks join fan-out', async () => {
    const { flowRunId, projectId } = await seedFlowRun(db, GRAPH);
    for (const nodeId of ['st', 'st2']) {
      await seedCompletedNodeRun(db, {
        flowRunId,
        nodeId,
        blockType: 'start_task',
        outputs: { subChatId: SUB },
      });
    }
    for (const description of ['n1', 'n2']) {
      await createTask(db, {
        projectId,
        description,
        source: 'flow',
        flowRunId,
        result: { subChatId: SUB },
      });
    }
    expect(await getActiveFlowRunForSubChat(db, SUB)).toEqual({ id: flowRunId });
  });

  it('does not resolve a SIBLING sub-chat of the same chat', async () => {
    // Sub-chat-scoped, not chat-scoped: a user-added sub-chat on a flow chat keeps its composer.
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { chatId: 'chat-1', subChatId: SUB },
    });
    expect(await getActiveFlowRunForSubChat(db, 'sub-user-added')).toBeNull();
  });

  it('returns null for an empty sub-chat id', async () => {
    expect(await getActiveFlowRunForSubChat(db, '')).toBeNull();
  });
});

// Backs the in-chat InterruptedRunControls: must surface the newest run EVEN when terminal
// (cancelled), which listIncompleteFlowRunIdsForChat filters by status but does not order.
describe('getLatestFlowRunForChat', () => {
  const CHAT = 'chat-abc';
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  // Creates a NEW flow_run on `versionId` (distinct idempotencyKey ⇒ no replay), links it to CHAT
  // via a start_task node_output, and pins createdAt so ordering is deterministic. seedFlowRun can
  // only run once per db (projects.path is unique), so extra runs are created on its version.
  async function linkedRun(
    versionId: string,
    opts: { key: string; status: 'running' | 'completed' | 'cancelled'; createdAt: Date },
  ): Promise<string> {
    const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: versionId,
      status: 'running',
      triggerContext: null,
      idempotencyKey: opts.key,
      startedAt: new Date(),
    });
    await db.update(flowRuns).set({ createdAt: opts.createdAt }).where(eq(flowRuns.id, run.id));
    await seedCompletedNodeRun(db, {
      flowRunId: run.id,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { chatId: CHAT },
    });
    await setFlowRunStatus(db, run.id, opts.status, {
      completedAt: opts.status === 'running' ? undefined : new Date(),
    });
    return run.id;
  }

  it('returns a cancelled run linked to the chat (unlike the active/incomplete lists)', async () => {
    const { versionId } = await seedFlowRun(db, GRAPH);
    const cancelled = await linkedRun(versionId, {
      key: 'k-a',
      status: 'cancelled',
      createdAt: new Date(1000),
    });
    expect((await getLatestFlowRunForChat(db, CHAT))?.id).toBe(cancelled);
  });

  it('returns the NEWEST run when the chat has several', async () => {
    const { versionId } = await seedFlowRun(db, GRAPH);
    await linkedRun(versionId, { key: 'k-old', status: 'completed', createdAt: new Date(1000) });
    const newest = await linkedRun(versionId, {
      key: 'k-new',
      status: 'cancelled',
      createdAt: new Date(2000),
    });
    expect((await getLatestFlowRunForChat(db, CHAT))?.id).toBe(newest);
  });

  it('returns null for a chat with no linked flow run', async () => {
    const { versionId } = await seedFlowRun(db, GRAPH);
    await linkedRun(versionId, { key: 'k-x', status: 'cancelled', createdAt: new Date(1000) });
    expect(await getLatestFlowRunForChat(db, 'unrelated')).toBeNull();
  });

  it('returns a cancelled run a branch chat is linked to only by its task result', async () => {
    const { versionId, flowRunId } = await seedFlowRun(db, GRAPH);
    await linkedRun(versionId, { key: 'k-anchor', status: 'completed', createdAt: new Date(500) });
    await db
      .update(flowRuns)
      .set({ createdAt: new Date(1000) })
      .where(eq(flowRuns.id, flowRunId));
    await createTask(db, {
      description: 'branch',
      source: 'flow',
      flowRunId,
      result: { chatId: 'branch-chat' },
    });
    await setFlowRunStatus(db, flowRunId, 'cancelled', { completedAt: new Date() });

    expect((await getLatestFlowRunForChat(db, 'branch-chat'))?.id).toBe(flowRunId);
  });

  it('picks the newest run across link sources for one chat', async () => {
    const { versionId, flowRunId } = await seedFlowRun(db, GRAPH);
    await linkedRun(versionId, { key: 'k-node', status: 'completed', createdAt: new Date(1000) });
    await db
      .update(flowRuns)
      .set({ createdAt: new Date(2000) })
      .where(eq(flowRuns.id, flowRunId));
    await createTask(db, {
      description: 'branch',
      source: 'flow',
      flowRunId,
      result: { chatId: CHAT },
    });

    expect((await getLatestFlowRunForChat(db, CHAT))?.id).toBe(flowRunId);
  });
});

// Powers the flow-runs panel relabel: the engine parks a run at `paused` on every awaiting_input
// agent hand-off, so the panel needs the run's active task status to show "Running" vs "Paused".
describe('getActiveFlowDrivingStatusByRun', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  it('returns the highest-priority active driving status per run; ignores terminal tasks', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const running = await createTask(db, {
      description: 'r',
      source: 'flow',
      flowRunId,
    });
    await updateTaskStatus(db, running.id, 'running');
    const attention = await createTask(db, {
      description: 'n',
      source: 'flow',
      flowRunId,
    });
    await updateTaskStatus(db, attention.id, 'needs_attention');
    const done = await createTask(db, {
      description: 'd',
      source: 'flow',
      flowRunId,
    });
    await updateTaskStatus(db, done.id, 'completed');

    const map = await getActiveFlowDrivingStatusByRun(db, [flowRunId]);
    // needs_attention (priority 4) wins over running (2); completed is not a driving status.
    expect(map.get(flowRunId)).toBe('needs_attention');
  });

  it('is empty for no ids and absent for a run with only terminal tasks', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const done = await createTask(db, {
      description: 'd',
      source: 'flow',
      flowRunId,
    });
    await updateTaskStatus(db, done.id, 'completed');
    expect((await getActiveFlowDrivingStatusByRun(db, [])).size).toBe(0);
    expect((await getActiveFlowDrivingStatusByRun(db, [flowRunId])).has(flowRunId)).toBe(false);
  });

  it('keys per-run across a batch of ids — no cross-run bleed (the real listRuns call shape)', async () => {
    // listRuns passes every run id at once; status must map to the OWN run, and a terminal-only
    // run must stay absent even when batched alongside an active one. One flow, three runs.
    const flow = await createFlow(db, { name: 'F' });
    const version = await createFlowVersion(db, { flowId: flow.id, graph: GRAPH });
    const mkRun = async (key: string): Promise<string> => {
      const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
        flowVersionId: version.id,
        status: 'running',
        triggerContext: null,
        idempotencyKey: key,
        startedAt: new Date(),
      });
      return run.id;
    };
    const seedTask = async (flowRunId: string, status: 'running' | 'plan_ready' | 'completed') => {
      const task = await createTask(db, {
        description: status,
        source: 'flow',
        flowRunId,
      });
      await updateTaskStatus(db, task.id, status);
    };
    const aId = await mkRun('run-a');
    const bId = await mkRun('run-b');
    const cId = await mkRun('run-c');
    await seedTask(aId, 'running');
    await seedTask(bId, 'plan_ready');
    await seedTask(cId, 'completed'); // terminal — should not appear

    const map = await getActiveFlowDrivingStatusByRun(db, [aId, bId, cId]);
    expect(map.get(aId)).toBe('running');
    expect(map.get(bId)).toBe('plan_ready');
    expect(map.has(cId)).toBe(false);
  });
});

// Powers the flows-dashboard "Running" indicator: the newest ACTIVE run per flow, batched to avoid
// an N+1. Active = running|paused|pending (the renderer's live set); a newer completed run must not
// mask an older still-running one (concurrent runs are possible — no single-active-run guard).
describe('listFlowRunsForFlow', () => {
  it('orders runs created in the same second by id so pages stay stable between reads', async () => {
    const db = freshDb();
    const flow = await createFlow(db, { name: 'F' });
    const version = await createFlowVersion(db, { flowId: flow.id, graph: GRAPH });
    const second = new Date('2026-09-28T08:00:00Z');
    await db.insert(flowRuns).values(
      ['run-b', 'run-c', 'run-a'].map((id) => ({
        id,
        flowVersionId: version.id,
        createdAt: second,
      })),
    );
    await db.insert(flowRuns).values({
      id: 'run-0',
      flowVersionId: version.id,
      createdAt: new Date('2026-09-28T08:00:01Z'),
    });
    const runs = await listFlowRunsForFlow(db, flow.id, 3);
    expect(runs.map((run) => run.id)).toEqual(['run-0', 'run-c', 'run-b']);
  });
});

describe('getLatestRunsForFlows', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  /** One flow with N runs (distinct idempotency keys); returns flowId + run ids in creation order. */
  async function seedFlowWithRuns(
    statuses: Array<'running' | 'paused' | 'pending' | 'completed' | 'failed' | 'cancelled'>,
  ): Promise<{ flowId: string; runIds: string[] }> {
    const flow = await createFlow(db, { name: 'F' });
    const version = await createFlowVersion(db, { flowId: flow.id, graph: GRAPH });
    const runIds: string[] = [];
    for (let i = 0; i < statuses.length; i++) {
      const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
        flowVersionId: version.id,
        status: 'running',
        triggerContext: null,
        // Key must be globally unique (getOrCreate dedups across flows) — scope by flow + index,
        // else a second flow's run replays the first flow's run instead of creating its own.
        idempotencyKey: `${flow.id}-r${i}`,
        startedAt: new Date(),
      });
      if (statuses[i] !== 'running') {
        await setFlowRunStatus(db, run.id, statuses[i], {
          completedAt:
            statuses[i] === 'paused' || statuses[i] === 'pending' ? undefined : new Date(),
        });
      }
      runIds.push(run.id);
    }
    return { flowId: flow.id, runIds };
  }

  it('returns the active run per flow and omits flows whose only run is terminal', async () => {
    const active = await seedFlowWithRuns(['running']);
    const finished = await seedFlowWithRuns(['completed']);

    const map = await getLatestRunsForFlows(db, [active.flowId, finished.flowId]);
    expect(map.get(active.flowId)).toEqual({
      id: active.runIds[0],
      status: 'running',
      activeTaskStatus: null,
    });
    expect(map.has(finished.flowId)).toBe(false);
  });

  it('returns the ACTIVE run even when a newer completed run exists (active beats latest-by-date)', async () => {
    // run0 running (older), run1 completed (newer). The completed run must not mask the running one.
    const { flowId, runIds } = await seedFlowWithRuns(['running', 'completed']);
    const map = await getLatestRunsForFlows(db, [flowId]);
    expect(map.get(flowId)).toEqual({ id: runIds[0], status: 'running', activeTaskStatus: null });
  });

  it('picks the newest among multiple active runs (by createdAt)', async () => {
    const { flowId, runIds } = await seedFlowWithRuns(['running', 'paused']);
    // Force deterministic ordering: run1 (paused) is newer than run0 (running).
    await db
      .update(flowRuns)
      .set({ createdAt: new Date(1000) })
      .where(eq(flowRuns.id, runIds[0]));
    await db
      .update(flowRuns)
      .set({ createdAt: new Date(2000) })
      .where(eq(flowRuns.id, runIds[1]));

    const map = await getLatestRunsForFlows(db, [flowId]);
    expect(map.get(flowId)).toEqual({ id: runIds[1], status: 'paused', activeTaskStatus: null });
  });

  it('includes a pending run (renderer shows "Starting" — active set must stay running|paused|pending)', async () => {
    // Guards against narrowing the active filter to {running, paused} (the canvas-rehydrate set):
    // the dashboard's "Starting" indicator depends on pending runs surfacing here.
    const { flowId, runIds } = await seedFlowWithRuns(['pending']);
    const map = await getLatestRunsForFlows(db, [flowId]);
    expect(map.get(flowId)).toEqual({ id: runIds[0], status: 'pending', activeTaskStatus: null });
  });

  it('returns a run created under an older flow version after a newer version is saved (join is flowId)', async () => {
    // User runs the flow, then edits + saves it (new version) while it is still running. The run is
    // pinned to v1; the dashboard must still show it because the join is on flow_versions.flowId.
    const flow = await createFlow(db, { name: 'F' });
    const v1 = await createFlowVersion(db, { flowId: flow.id, graph: GRAPH });
    const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: v1.id,
      status: 'running',
      triggerContext: null,
      idempotencyKey: 'v1-run',
      startedAt: new Date(),
    });
    await createFlowVersion(db, { flowId: flow.id, graph: GRAPH }); // v2, no run

    const map = await getLatestRunsForFlows(db, [flow.id]);
    expect(map.get(flow.id)).toEqual({ id: run.id, status: 'running', activeTaskStatus: null });
  });

  it('carries activeTaskStatus so a paused-but-working run can be relabelled Running (dashboard fix)', async () => {
    // The engine parks a run at `paused` during an async agent hand-off while the agent is actively
    // running. The dashboard must show "Running", not "Paused run" — it relabels via the run's
    // active driving-task status (flowRunDisplayStatus), exactly like the Run History panel.
    const flow = await createFlow(db, { name: 'F' });
    const version = await createFlowVersion(db, { flowId: flow.id, graph: GRAPH });
    const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: version.id,
      status: 'running',
      triggerContext: null,
      idempotencyKey: 'paused-working',
      startedAt: new Date(),
    });
    await setFlowRunStatus(db, run.id, 'paused');
    const task = await createTask(db, {
      description: 'agent',
      source: 'flow',
      flowRunId: run.id,
    });
    await updateTaskStatus(db, task.id, 'running');

    const map = await getLatestRunsForFlows(db, [flow.id]);
    expect(map.get(flow.id)).toEqual({ id: run.id, status: 'paused', activeTaskStatus: 'running' });
  });

  it('returns an empty map for no flow ids', async () => {
    expect((await getLatestRunsForFlows(db, [])).size).toBe(0);
  });
});

// A local flow reuses ONE chat across a multi-agent chain, but linkChatToTask is first-agent-wins
// (chats.task_id pinned to the first task). Once that task completes, the running 2nd-agent task has
// no direct chat link — the sidebar badge would vanish mid-run. listTasksWithProjectPaginated
// resolves linkedChatId per-task via result.chatId so each running agent task surfaces its own chat.
describe('listTasksWithProjectPaginated — linkedChatId per-task resolution', () => {
  let db: TestDb;
  let flowRunId: string;

  beforeEach(async () => {
    db = freshDb();
    ({ flowRunId } = await seedFlowRun(db, GRAPH));
  });

  it('resolves a non-anchor running task to its OWN chat via result.chatId (orphan fix)', async () => {
    const chat = await createChat(db, { name: 'Flow chat' });
    // Anchor: first agent task; chat is pinned to it, then it completes.
    const anchor = await createTask(db, {
      description: 'a1',
      source: 'flow',
      flowRunId,
      result: { chatId: chat.id },
    });
    await linkChatToTask(db, chat.id, anchor.id);
    await updateTaskStatus(db, anchor.id, 'completed');
    // Second agent: running, NOT linked to the chat (first-agent-wins guard), but result.chatId set.
    const running = await createTask(db, {
      description: 'a2',
      source: 'flow',
      flowRunId,
      result: { chatId: chat.id },
    });
    await updateTaskStatus(db, running.id, 'running');

    const { items } = await listTasksWithProjectPaginated(db, {
      statuses: ['running', 'completed'],
    });
    const byId = new Map(items.map((t) => [t.id, t.linkedChatId]));
    expect(byId.get(running.id)).toBe(chat.id); // per-task path (direct link is null)
    expect(byId.get(anchor.id)).toBe(chat.id); // direct path (chats.task_id)
  });

  it('EC2: a flow_run with two chats resolves each running task to its OWN chat (no collapse)', async () => {
    const c1 = await createChat(db, { name: 'branch 1' });
    const c2 = await createChat(db, { name: 'branch 2' });
    const t1 = await createTask(db, {
      description: 'b1',
      source: 'flow',
      flowRunId,
      result: { chatId: c1.id },
    });
    const t2 = await createTask(db, {
      description: 'b2',
      source: 'flow',
      flowRunId,
      result: { chatId: c2.id },
    });
    await updateTaskStatus(db, t1.id, 'running');
    await updateTaskStatus(db, t2.id, 'running');

    const { items } = await listTasksWithProjectPaginated(db, { statuses: ['running'] });
    const byId = new Map(items.map((t) => [t.id, t.linkedChatId]));
    expect(byId.get(t1.id)).toBe(c1.id);
    expect(byId.get(t2.id)).toBe(c2.id);
  });

  it('falls back to the direct chats.taskId link for a non-flow task (result has no chatId)', async () => {
    const chat = await createChat(db, { name: 'manual' });
    const manual = await createTask(db, { description: 'm', source: 'manual' });
    await linkChatToTask(db, chat.id, manual.id);
    await updateTaskStatus(db, manual.id, 'running');

    const { items } = await listTasksWithProjectPaginated(db, { statuses: ['running'] });
    expect(items.find((t) => t.id === manual.id)?.linkedChatId).toBe(chat.id);
  });

  it('yields linkedChatId=null (no dangling id) when result.chatId points to a deleted chat', async () => {
    // User deletes the chat while the flow task is still running — the task row keeps the stale
    // result.chatId, but the join must resolve to null, not a dangling reference.
    const chat = await createChat(db, { name: 'doomed' });
    const running = await createTask(db, {
      description: 'r',
      source: 'flow',
      flowRunId,
      result: { chatId: chat.id },
    });
    await updateTaskStatus(db, running.id, 'running');
    await db.delete(chats).where(eq(chats.id, chat.id));

    const { items } = await listTasksWithProjectPaginated(db, { statuses: ['running'] });
    expect(items.find((t) => t.id === running.id)?.linkedChatId).toBeNull();
  });
});

// Flow-run authority for the sidebar: each task row carries its flow_run's status so the renderer
// can suppress a stale terminal `done` while the run is still non-terminal (premature-Done fix #1).
describe('listTasksWithProjectPaginated — flowRunStatus', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  it('carries the run status for a flow task (non-terminal) and null for a non-flow task', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH); // run = 'running'
    const flowTask = await createTask(db, { description: 'a', source: 'flow', flowRunId });
    await updateTaskStatus(db, flowTask.id, 'done');
    const manual = await createTask(db, { description: 'm', source: 'manual' });
    await updateTaskStatus(db, manual.id, 'done');

    const { items } = await listTasksWithProjectPaginated(db, { statuses: ['done'] });
    const byId = new Map(items.map((t) => [t.id, t.flowRunStatus]));
    expect(byId.get(flowTask.id)).toBe('running');
    expect(byId.get(manual.id)).toBeNull();
  });

  it('reflects a completed flow_run (so the sidebar lets `done` stand)', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const t = await createTask(db, { description: 'a', source: 'flow', flowRunId });
    await updateTaskStatus(db, t.id, 'done');
    await setFlowRunStatus(db, flowRunId, 'completed', { completedAt: new Date() });
    const { items } = await listTasksWithProjectPaginated(db, { statuses: ['done'] });
    expect(items.find((x) => x.id === t.id)?.flowRunStatus).toBe('completed');
  });
});

// Crash-residue cleanup (#2): a terminal flow_run must leave no node_run stranded mid-state, and a
// legitimately awaiting_input node on an ACTIVE/paused run must never be touched.
describe('node_run cleanup on terminal flow_runs', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  it('cancelRemainingNodeRunsForRun cancels active node_runs, leaves terminal ones', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const awaiting = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'awaiting_input',
    });
    const pending = await createNodeRun(db, {
      flowRunId,
      nodeId: 'b',
      blockType: 'agent',
      status: 'pending',
    });
    const done = await createNodeRun(db, {
      flowRunId,
      nodeId: 'c',
      blockType: 'agent',
      status: 'completed',
    });
    const retried = await createNodeRun(db, {
      flowRunId,
      nodeId: 'd',
      blockType: 'agent',
      status: 'superseded',
    });

    expect(await cancelRemainingNodeRunsForRun(db, flowRunId)).toBe(2);
    const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.flowRunId, flowRunId));
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    expect(byId.get(awaiting.id)).toBe('cancelled');
    expect(byId.get(pending.id)).toBe('cancelled');
    expect(byId.get(done.id)).toBe('completed');
    expect(byId.get(retried.id)).toBe('superseded');
  });

  it('cleanupNodeRunsForTerminalFlows sweeps a failed run but leaves an active run untouched', async () => {
    // Two runs under ONE flow (seedFlowRun hardcodes the project path, so it can't run twice).
    const flow = await createFlow(db, { name: 'F' });
    const version = await createFlowVersion(db, { flowId: flow.id, graph: GRAPH });
    const mkRun = async (key: string): Promise<string> => {
      const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
        flowVersionId: version.id,
        status: 'running',
        triggerContext: null,
        idempotencyKey: key,
        startedAt: new Date(),
      });
      return run.id;
    };
    const failedId = await mkRun('rf');
    await setFlowRunStatus(db, failedId, 'failed', { completedAt: new Date() });
    const residue = await createNodeRun(db, {
      flowRunId: failedId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'awaiting_input',
    });
    const activeId = await mkRun('ra'); // stays 'running'
    const legit = await createNodeRun(db, {
      flowRunId: activeId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'awaiting_input',
    });

    expect(await cleanupNodeRunsForTerminalFlows(db)).toBe(1);
    const failedNode = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, residue.id)))[0];
    const activeNode = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, legit.id)))[0];
    expect(failedNode.status).toBe('cancelled');
    expect(activeNode.status).toBe('awaiting_input'); // regression guard
  });

  it('boot sequence: orphan running run recovered to cancelled, then its awaiting_input node swept', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH); // running
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'awaiting_input',
    });
    // Mirror scheduler.recoverOrphans ordering: cancel orphan runs FIRST, then sweep their residue.
    // A restart interruption is neutral (cancelled), not a flow error (failed).
    await recoverOrphanedFlowRuns(db, new Date(Date.now() + 1000));
    await cleanupNodeRunsForTerminalFlows(db);
    const runRow = (await db.select().from(flowRuns).where(eq(flowRuns.id, flowRunId)))[0];
    expect(runRow.status).toBe('cancelled');
    const row = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, node.id)))[0];
    expect(row.status).toBe('cancelled');
  });
});

// Powers sidebar badge persistence through taskless windows: chats with a non-terminal flow_run.
describe('listChatIdsWithActiveFlowRun', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  it('includes a chat resolved via task result.chatId — even when the only task is terminal (gap)', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH); // run = running
    const t = await createTask(db, {
      description: 'a',
      source: 'flow',
      flowRunId,
      result: { chatId: 'chat-1' },
    });
    await updateTaskStatus(db, t.id, 'completed'); // a completed/done task still carries result.chatId
    expect(await listChatIdsWithActiveFlowRun(db)).toContain('chat-1');
  });

  it('includes a chat resolved via node_output (no task yet — pre-first-agent)', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { chatId: 'chat-2' },
    });
    expect(await listChatIdsWithActiveFlowRun(db)).toContain('chat-2');
  });

  it('excludes a chat whose flow_run is terminal', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const t = await createTask(db, {
      description: 'a',
      source: 'flow',
      flowRunId,
      result: { chatId: 'chat-3' },
    });
    await updateTaskStatus(db, t.id, 'done');
    await setFlowRunStatus(db, flowRunId, 'completed', { completedAt: new Date() });
    expect(await listChatIdsWithActiveFlowRun(db)).not.toContain('chat-3');
  });

  it('scopes by userId', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'completed');
    const t = await createTask(db, {
      description: 'a',
      source: 'flow',
      flowRunId,
      result: { chatId: 'chat-4' },
    });
    await updateTaskStatus(db, t.id, 'running');
    expect(await listChatIdsWithActiveFlowRun(db)).not.toContain('chat-4');
  });

  it('includes a chat resolved via trigger_context.chatId (post_task fan-out)', async () => {
    const flow = await createFlow(db, { name: 'F' });
    const version = await createFlowVersion(db, { flowId: flow.id, graph: GRAPH });
    await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: version.id,
      status: 'running',
      triggerContext: { chatId: 'chat-trig' },
      idempotencyKey: 'ft-1',
      startedAt: new Date(),
    });
    expect(await listChatIdsWithActiveFlowRun(db)).toContain('chat-trig');
  });

  it('returns every distinct chatId a run links to (multi-start_task fan-out), deduped', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'st1',
      blockType: 'start_task',
      outputs: { chatId: 'chat-a' },
    });
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'st2',
      blockType: 'start_task',
      outputs: { chatId: 'chat-b' },
    });
    const ids = await listChatIdsWithActiveFlowRun(db);
    expect(ids).toContain('chat-a');
    expect(ids).toContain('chat-b');
    expect(ids.filter((c) => c === 'chat-a')).toHaveLength(1); // cartesian leftJoin deduped by the Set
  });
});

describe('batch ↔ chat linkage (sidebar grouping)', () => {
  let db: TestDb;
  let versionId: string;

  beforeEach(async () => {
    db = freshDb();
    const flow = await createFlow(db, { name: 'F' });
    const version = await createFlowVersion(db, { flowId: flow.id, graph: GRAPH });
    versionId = version.id;
  });

  /** A flow_run (optionally in a batch) plus a chat linked via a start_task node_output. */
  async function seedRunWithChat(opts: {
    batchId: string | null;
    status?: 'running' | 'completed' | 'failed';
    chatName: string;
    archived?: boolean;
  }): Promise<string> {
    const chat = await createChat(db, {
      name: opts.chatName,
      archivedAt: opts.archived ? new Date() : null,
    });
    const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: versionId,
      status: opts.status ?? 'running',
      triggerContext: null,
      idempotencyKey: null,
      batchId: opts.batchId,
      startedAt: new Date(),
    });
    await seedCompletedNodeRun(db, {
      flowRunId: run.id,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { chatId: chat.id },
    });
    return chat.id;
  }

  describe('getBatchIdByChatId', () => {
    it('maps batched chats to their batchId and omits non-batch chats', async () => {
      const chatA = await seedRunWithChat({ batchId: 'b1', chatName: 'A' });
      const chatB = await seedRunWithChat({ batchId: 'b1', chatName: 'B' });
      const chatC = await seedRunWithChat({ batchId: null, chatName: 'C' });

      const map = await getBatchIdByChatId(db);

      expect(map.get(chatA)).toBe('b1');
      expect(map.get(chatB)).toBe('b1');
      expect(map.has(chatC)).toBe(false);
      expect(map.size).toBe(2);
    });

    it('resolves the link via trigger_context.$.chatId too', async () => {
      const chat = await createChat(db, { name: 'T' });
      await getOrCreateFlowRunByIdempotencyKey(db, {
        flowVersionId: versionId,
        status: 'running',
        triggerContext: { chatId: chat.id },
        idempotencyKey: null,
        batchId: 'b9',
        startedAt: new Date(),
      });

      const map = await getBatchIdByChatId(db);

      expect(map.get(chat.id)).toBe('b9');
    });

    it('maps a chat reused across batches to its NEWEST batch (deterministic, not row-order)', async () => {
      const chat = await createChat(db, { name: 'reused' });
      const seedBatchRun = async (batchId: string, createdAt: Date) => {
        const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
          flowVersionId: versionId,
          status: 'running',
          triggerContext: null,
          idempotencyKey: null,
          batchId,
          startedAt: new Date(),
          createdAt,
        });
        await seedCompletedNodeRun(db, {
          flowRunId: run.id,
          nodeId: 'st',
          blockType: 'start_task',
          outputs: { chatId: chat.id },
        });
      };
      await seedBatchRun('old-batch', new Date('2026-01-01T00:00:00.000Z'));
      await seedBatchRun('new-batch', new Date('2026-06-01T00:00:00.000Z'));

      expect((await getBatchIdByChatId(db)).get(chat.id)).toBe('new-batch');
    });
  });

  describe('listChatsByBatch', () => {
    it('returns the non-archived chats of a batch and nothing from other batches', async () => {
      const chatA = await seedRunWithChat({ batchId: 'b1', chatName: 'A' });
      const chatB = await seedRunWithChat({ batchId: 'b1', chatName: 'B' });
      await seedRunWithChat({ batchId: 'b2', chatName: 'C' });
      await seedRunWithChat({ batchId: 'b1', chatName: 'D', archived: true });

      const rows = await listChatsByBatch(db, 'b1');
      const ids = rows.map((r) => r.id).sort();

      expect(ids).toEqual([chatA, chatB].sort());
    });

    it('returns [] for a batch with no linked chats', async () => {
      await seedRunWithChat({ batchId: 'b1', chatName: 'A' });
      await expect(listChatsByBatch(db, 'unknown-batch')).resolves.toEqual([]);
    });
  });

  // A multi-agent batched run pins its anchor chat via the start_task node_output, but a
  // NON-anchor (branch) chat's only link is tasks.result.chatId (linkChatToTask is
  // first-agent-wins). Such a chat still belongs to the batch and MUST group + expand —
  // the same third link source listChatIdsWithActiveFlowRun covers.
  it('resolves a batched chat linked ONLY via tasks.result.chatId', async () => {
    const chat = await createChat(db, { name: 'branch' });
    const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: versionId,
      status: 'running',
      triggerContext: null,
      idempotencyKey: null,
      batchId: 'b1',
      startedAt: new Date(),
    });
    await createTask(db, {
      description: 'branch agent',
      source: 'flow',
      flowRunId: run.id,
      result: { chatId: chat.id },
    });

    expect((await getBatchIdByChatId(db)).get(chat.id)).toBe('b1');
    expect((await listChatsByBatch(db, 'b1')).map((r) => r.id)).toContain(chat.id);
  });
});
