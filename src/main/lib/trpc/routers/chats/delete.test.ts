/**
 * Phase 1 local-first migration: delete writes to local SQLite directly AND cancels the
 * flow runs the chat drives (regression fix — the local migration dropped that, so flows
 * kept running after their chat was deleted). Exercised against a real in-memory DB so the
 * lookup + cancelFlowRun + task-cancel + anti-resurrection path is covered end-to-end.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChat, getChatById } from '../../../db/repos/chats';
import {
  getFlowRun,
  getOrCreateFlowRunByIdempotencyKey,
  setFlowRunStatus,
} from '../../../db/repos/flow-runs';
import { createNodeRun } from '../../../db/repos/node-runs';
import { createTask, getTaskById, updateTaskStatus } from '../../../db/repos/tasks';
import { seedCompletedNodeRun, seedFlowRun } from '../../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../../db/test-utils/fresh-db';
import { getActiveFlowTaskForChat, setActiveFlowTaskForChat } from '../../../task-executor';

const { h, trackWorkspaceDeletedMock } = vi.hoisted(() => ({
  h: { db: null as unknown },
  trackWorkspaceDeletedMock: vi.fn(),
}));

vi.mock('../../../db', async (orig) => ({
  ...(await orig<typeof import('../../../db')>()),
  getDatabase: () => h.db,
}));
// Engine → advance → dispatch chain reaches Electron + analytics + git on the delete path.
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../../analytics', () => ({ trackWorkspaceDeleted: trackWorkspaceDeletedMock }));
vi.mock('../../../git', () => ({ removeWorktree: vi.fn() }));
vi.mock('../../../git/cache', () => ({
  gitCache: { invalidateStatus: vi.fn(), invalidateParsedDiff: vi.fn() },
}));
vi.mock('../../../socket/executor', () => ({
  clearCodexSession: vi.fn(),
  abortActiveExecutionsForSubChats: vi.fn(),
  collectLiveSubChatIdsForChat: vi.fn(() => []),
}));

import { advanceFlowRun } from '../../../flows/advance';
import { cancelFlowRun } from '../../../flows/engine';
import { createSubChat, listSubChatsByChat } from '../../../db/repos/sub-chats';
import {
  abortActiveExecutionsForSubChats,
  collectLiveSubChatIdsForChat,
} from '../../../socket/executor';
import { deleteRouter } from './delete';

const GRAPH = { nodes: [{ id: 'st', blockType: 'start_task' }], edges: [] };

let db: TestDb;
beforeEach(() => {
  db = freshDb();
  h.db = db;
  vi.clearAllMocks();
});

const caller = () => deleteRouter.createCaller({ getWindow: () => null });

describe('deleteRouter (local-first)', () => {
  it('deletes the chat locally and tracks analytics', async () => {
    const chat = await createChat(db, { name: 'C' });

    const result = await caller().delete({ id: chat.id });

    expect(result?.id).toBe(chat.id);
    expect(await getChatById(db, chat.id)).toBeNull();
    expect(trackWorkspaceDeletedMock).toHaveBeenCalledWith(chat.id);
  });

  it("aborts the chat's live turns even when its sub-chat lookup fails", async () => {
    const chat = await createChat(db, { name: 'C' });
    // A real read failure: the sub-chat table is gone, so listSubChatsByChat throws.
    db.run(sql`ALTER TABLE sub_chats RENAME TO sub_chats_unreadable`);
    await expect(listSubChatsByChat(db, chat.id)).rejects.toThrow();
    vi.mocked(collectLiveSubChatIdsForChat).mockReturnValueOnce(['sub-live']);

    await caller().delete({ id: chat.id });

    expect(collectLiveSubChatIdsForChat).toHaveBeenCalledWith(chat.id);
    expect(abortActiveExecutionsForSubChats).toHaveBeenCalledWith(['sub-live'], 'chat deleted');
    // The abort lands before the row goes, so nothing streams into a deleted chat.
    expect(vi.mocked(abortActiveExecutionsForSubChats).mock.invocationCallOrder[0]).toBeLessThan(
      trackWorkspaceDeletedMock.mock.invocationCallOrder[0],
    );
    expect(await getChatById(db, chat.id)).toBeNull();
  });

  it('still aborts the listed sub-chats, alongside the live ones, when the lookup succeeds', async () => {
    const chat = await createChat(db, { name: 'C' });
    const sub = await createSubChat(db, { chatId: chat.id });
    vi.mocked(collectLiveSubChatIdsForChat).mockReturnValueOnce([sub.id, 'sub-live']);

    await caller().delete({ id: chat.id });

    expect(abortActiveExecutionsForSubChats).toHaveBeenCalledWith(
      [sub.id, 'sub-live'],
      'chat deleted',
    );
  });

  it('returns null when the chat is missing', async () => {
    const result = await caller().delete({ id: 'does-not-exist' });
    expect(result).toBeNull();
    expect(trackWorkspaceDeletedMock).not.toHaveBeenCalled();
  });

  it('deletes a chat with no linked flow run without cancelling anything', async () => {
    const chat = await createChat(db, { name: 'C' });
    // Unrelated active run for a different chat must survive.
    const { flowRunId: otherRunId } = await seedFlowRun(db, GRAPH);
    await seedCompletedNodeRun(db, {
      flowRunId: otherRunId,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { chatId: 'other-chat' },
    });

    await caller().delete({ id: chat.id });

    expect((await getFlowRun(db, otherRunId))?.status).toBe('running');
  });

  it('cancels a task-linked branch run, and a later watcher tick cannot resurrect it', async () => {
    const chat = await createChat(db, { name: 'C' });
    const { projectId, flowRunId } = await seedFlowRun(db, GRAPH);
    // This branch chat is linked only through the task result, not the run or a start_task output.
    await setFlowRunStatus(db, flowRunId, 'paused');
    const agentNode = await createNodeRun(db, {
      flowRunId,
      nodeId: 'ag',
      blockType: 'agent',
      status: 'awaiting_input',
    });
    const task = await createTask(db, {
      projectId,
      description: 'agent work',
      source: 'flow',
      flowRunId,
      nodeRunId: agentNode.id,
      result: { chatId: chat.id },
    });
    setActiveFlowTaskForChat(chat.id, task.id);

    await caller().delete({ id: chat.id });

    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
    // Cancellation settles the run first; the atomic chat delete can then remove its owned task.
    expect(await getTaskById(db, task.id)).toBeNull();
    expect(getActiveFlowTaskForChat(chat.id)).toBeNull();

    // task-completion-watcher fires the (now cancelled) task's completion — must NOT resume.
    await advanceFlowRun(flowRunId, agentNode.id, {
      status: 'completed',
      outputs: {},
      artifacts: [],
      durationMs: 0,
    });
    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
  });

  it('cancelFlowRun is idempotent — a concurrent second removal of the same chat is a no-op', async () => {
    // Two panes deleting the same chat can both fetch the run id before either cancels,
    // then both call cancelFlowRun on it. The terminal guard must make the second a no-op.
    const { projectId, flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'paused');
    const task = await createTask(db, {
      projectId,
      description: 'agent work',
      source: 'flow',
      flowRunId,
    });

    await cancelFlowRun(flowRunId);
    const second = await cancelFlowRun(flowRunId);

    expect(second?.status).toBe('cancelled');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
    expect((await getTaskById(db, task.id))?.status).toBe('cancelled');
  });

  it('cancels EVERY active run the chat drives (mixed node_output + trigger_context linkage)', async () => {
    const chat = await createChat(db, { name: 'C' });
    // run1: linked via start_task node_output.outputs.chatId
    const { flowRunId: run1, versionId } = await seedFlowRun(db, GRAPH, { idempotencyKey: 'r1' });
    await seedCompletedNodeRun(db, {
      flowRunId: run1,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { chatId: chat.id },
    });
    // run2 (same version): linked via trigger_context.chatId (post_task fan-out shape)
    const { run: run2 } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: versionId,
      status: 'running',
      triggerContext: { chatId: chat.id },
      idempotencyKey: 'r2',
      startedAt: new Date(),
    });

    await caller().delete({ id: chat.id });

    expect((await getFlowRun(db, run1))?.status).toBe('cancelled');
    expect((await getFlowRun(db, run2.id))?.status).toBe('cancelled');
  });

  it("cancels the chat run's live task, deletes its terminal task, never touches another run", async () => {
    const chat = await createChat(db, { name: 'C' });
    const { projectId, flowRunId, versionId } = await seedFlowRun(db, GRAPH);
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { chatId: chat.id },
    });
    const pendingTask = await createTask(db, {
      projectId,
      description: 'pending',
      source: 'flow',
      flowRunId,
      result: { chatId: chat.id },
    });
    const doneTask = await createTask(db, {
      projectId,
      description: 'done',
      source: 'flow',
      flowRunId,
      result: { chatId: chat.id },
    });
    await updateTaskStatus(db, doneTask.id, 'done');
    // Unrelated run (same version, NOT linked to the chat) + its running task — must survive.
    const { run: otherRunRow } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: versionId,
      status: 'running',
      triggerContext: null,
      idempotencyKey: 'other',
      startedAt: new Date(),
    });
    const otherRun = otherRunRow.id;
    const otherTask = await createTask(db, {
      projectId,
      description: 'other',
      source: 'flow',
      flowRunId: otherRun,
    });
    await updateTaskStatus(db, otherTask.id, 'running');

    await caller().delete({ id: chat.id });

    // Both owned rows leave the queue after the run is cancelled; the run history remains.
    expect(await getTaskById(db, pendingTask.id)).toBeNull();
    expect(await getTaskById(db, doneTask.id)).toBeNull();
    // The unrelated run the chat does not drive is untouched — the key scoping invariant.
    expect((await getTaskById(db, otherTask.id))?.status).toBe('running');
    expect((await getFlowRun(db, otherRun))?.status).toBe('running');
  });

  it("preserves a sibling chat's parked task on the same terminal run", async () => {
    const chat = await createChat(db, { name: 'Deleted chat' });
    const sibling = await createChat(db, { name: 'Sibling chat' });
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'failed');
    const deletedTask = await createTask(db, {
      description: 'deleted review',
      source: 'flow',
      flowRunId,
      result: { chatId: chat.id },
    });
    const siblingTask = await createTask(db, {
      description: 'sibling review',
      source: 'flow',
      flowRunId,
      result: { chatId: sibling.id },
    });
    await updateTaskStatus(db, deletedTask.id, 'needs_attention');
    await updateTaskStatus(db, siblingTask.id, 'needs_attention');

    await caller().delete({ id: chat.id });

    expect(await getTaskById(db, deletedTask.id)).toBeNull();
    expect(await getTaskById(db, siblingTask.id)).toMatchObject({ status: 'needs_attention' });
    expect(await getChatById(db, sibling.id)).not.toBeNull();
  });

  it("keeps a shared active run alive for the sibling chat's task", async () => {
    const chat = await createChat(db, { name: 'Deleted chat' });
    const sibling = await createChat(db, { name: 'Sibling chat' });
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const deletedTask = await createTask(db, {
      description: 'deleted active task',
      source: 'flow',
      flowRunId,
      result: { chatId: chat.id },
    });
    const siblingTask = await createTask(db, {
      description: 'sibling active task',
      source: 'flow',
      flowRunId,
      result: { chatId: sibling.id },
    });
    await updateTaskStatus(db, deletedTask.id, 'running');
    await updateTaskStatus(db, siblingTask.id, 'running');

    await caller().delete({ id: chat.id });

    expect(await getChatById(db, chat.id)).toBeNull();
    expect(await getTaskById(db, deletedTask.id)).toBeNull();
    expect(await getTaskById(db, siblingTask.id)).toMatchObject({ status: 'running' });
    expect(await getFlowRun(db, flowRunId)).toMatchObject({ status: 'running' });
  });

  it('rolls the task cleanup back when the chat row cannot be deleted', async () => {
    const chat = await createChat(db, { name: 'C' });
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'failed');
    const task = await createTask(db, {
      description: 'review failure',
      source: 'flow',
      flowRunId,
      result: { chatId: chat.id },
    });
    await updateTaskStatus(db, task.id, 'needs_attention');
    db.run(
      sql.raw(`
      CREATE TRIGGER fail_chat_delete BEFORE DELETE ON chats
      BEGIN SELECT RAISE(ABORT, 'forced chat delete failure'); END
    `),
    );

    await expect(caller().delete({ id: chat.id })).rejects.toThrow('forced chat delete failure');

    expect(await getChatById(db, chat.id)).not.toBeNull();
    expect(await getTaskById(db, task.id)).not.toBeNull();
  });
});
