/**
 * Regression: deleting a project cascade-deletes its chats, but flow_runs link to chats
 * only via JSON (no FK), so a chat-driven flow would keep running after the project is gone
 * (same class as the chat delete/archive bug). projects.delete must cancel those runs too.
 */

import { eq } from 'drizzle-orm';
import log from 'electron-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as analyticsModule from '../../analytics';
import { createChat, getChatById, moveChatToProjectLocal } from '../../db/repos/chats';
import { getFlowRun, setFlowRunStatus } from '../../db/repos/flow-runs';
import * as projectsRepo from '../../db/repos/projects';
import { createTask, getTaskById } from '../../db/repos/tasks';
import { chats } from '../../db/schema';
import { seedCompletedNodeRun, seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import { gitCache } from '../../git/cache';
import * as executorModule from '../../socket/executor';
import * as teardown from './chats/teardown-worktree';

const { h } = vi.hoisted(() => ({ h: { db: null as unknown } }));

vi.mock('../../db', async (orig) => ({
  ...(await orig<typeof import('../../db')>()),
  getDatabase: () => h.db,
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
}));
vi.mock('../../cli', () => ({ getLaunchDirectory: vi.fn() }));
vi.mock('../../git', () => ({ getGitRemoteInfo: vi.fn() }));
vi.mock('../../project-scaffold', () => ({
  removeManagedBuildFolder: vi.fn().mockResolvedValue(undefined),
  scaffoldBuild: vi.fn(),
}));

import { projectsRouter } from './projects';

const GRAPH = { nodes: [{ id: 'st', blockType: 'start_task' }], edges: [] };
const { createProject, getProjectById } = projectsRepo;
const realDeleteProject = projectsRepo.deleteProject;

/** The per-chat cleanup projects.delete runs after the cascade. */
function spyOnChatCleanup() {
  return {
    clearCodexSession: vi.spyOn(executorModule, 'clearCodexSession').mockImplementation(() => {}),
    trackWorkspaceDeleted: vi
      .spyOn(analyticsModule, 'trackWorkspaceDeleted')
      .mockImplementation(() => {}),
    invalidateStatus: vi.spyOn(gitCache, 'invalidateStatus'),
    invalidateParsedDiff: vi.spyOn(gitCache, 'invalidateParsedDiff'),
  };
}

/** Runs `hook` inside the delete, after the router's snapshot and before the transaction. */
function beforeDeleting(hook: () => void) {
  vi.spyOn(projectsRepo, 'deleteProject').mockImplementation(async (...args) => {
    hook();
    return realDeleteProject(...args);
  });
}

/** The transactional delete fails the way a WAL lock or a full disk would. */
function failDeleting() {
  vi.spyOn(projectsRepo, 'deleteProject').mockRejectedValue(new Error('database is locked'));
}

let db: TestDb;
let cleanup: ReturnType<typeof spyOnChatCleanup>;
beforeEach(() => {
  db = freshDb();
  h.db = db;
  vi.spyOn(executorModule, 'abortActiveExecutionsForSubChats').mockImplementation(() => {});
  // Worktree removal shells out to git; these tests only seed fake worktree paths.
  vi.spyOn(teardown, 'removeProjectWorktrees').mockResolvedValue(undefined);
  cleanup = spyOnChatCleanup();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const caller = () => projectsRouter.createCaller({ getWindow: () => null });

describe('projectsRouter.delete', () => {
  it('cancels the flow runs driven by the project chats it cascade-deletes', async () => {
    const { projectId, flowRunId } = await seedFlowRun(db, GRAPH);
    const chat = await createChat(db, { name: 'C', projectId });
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { chatId: chat.id },
    });
    await setFlowRunStatus(db, flowRunId, 'paused');
    const task = await createTask(db, {
      projectId,
      description: 'agent work',
      source: 'flow',
      flowRunId,
      result: { chatId: chat.id },
    });

    await caller().delete({ id: projectId });

    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
    expect(await getTaskById(db, task.id)).toBeNull();
  });

  it('deletes nothing when the transactional delete fails, so no half-deleted project (sc-3279)', async () => {
    const project = await createProject(db, { name: 'P', path: '/tmp/p-fail' });
    const chat = await createChat(db, { name: 'C', projectId: project.id });
    failDeleting();

    await expect(caller().delete({ id: project.id })).rejects.toThrow('database is locked');

    expect(await getProjectById(db, project.id)).not.toBeNull();
    expect(await getChatById(db, chat.id)).not.toBeNull();
    expect(cleanup.clearCodexSession).not.toHaveBeenCalled();
    expect(cleanup.trackWorkspaceDeleted).not.toHaveBeenCalled();
  });

  it('cascades the chats and runs the per-chat cleanup chats.delete would', async () => {
    const project = await createProject(db, { name: 'P', path: '/tmp/p-ok' });
    const a = await createChat(db, { name: 'A', projectId: project.id });
    const b = await createChat(db, { name: 'B', projectId: project.id });

    await caller().delete({ id: project.id });

    expect(await getProjectById(db, project.id)).toBeNull();
    expect(await getChatById(db, a.id)).toBeNull();
    expect(await getChatById(db, b.id)).toBeNull();
    expect(cleanup.clearCodexSession.mock.calls.map(([id]) => id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(cleanup.trackWorkspaceDeleted).toHaveBeenCalledTimes(2);
  });

  it('invalidates git caches only for chats that have a worktree', async () => {
    const project = await createProject(db, { name: 'P', path: '/tmp/p-wt' });
    await createChat(db, {
      name: 'W',
      projectId: project.id,
      worktreePath: '/tmp/wt-1',
      branch: 'b1',
    });
    await createChat(db, { name: 'Local', projectId: project.id });

    await caller().delete({ id: project.id });

    expect(cleanup.invalidateStatus.mock.calls).toEqual([['/tmp/wt-1']]);
    expect(cleanup.invalidateParsedDiff.mock.calls).toEqual([['/tmp/wt-1']]);
  });

  it('runs per-chat cleanup once when two deletes of the same project race', async () => {
    const project = await createProject(db, { name: 'P', path: '/tmp/p-race' });
    const chat = await createChat(db, { name: 'C', projectId: project.id });

    await Promise.all([caller().delete({ id: project.id }), caller().delete({ id: project.id })]);

    expect(await getProjectById(db, project.id)).toBeNull();
    expect(cleanup.trackWorkspaceDeleted.mock.calls).toEqual([[chat.id]]);
    expect(cleanup.clearCodexSession.mock.calls).toEqual([[chat.id]]);
  });

  it('spares a chat moved to another project between the snapshot and the delete', async () => {
    const project = await createProject(db, { name: 'P', path: '/tmp/p-move' });
    const other = await createProject(db, { name: 'Q', path: '/tmp/q-move' });
    const stays = await createChat(db, { name: 'Stay', projectId: project.id });
    const moved = await createChat(db, { name: 'Move', projectId: project.id });
    beforeDeleting(() => {
      db.update(chats).set({ projectId: other.id }).where(eq(chats.id, moved.id)).run();
    });

    const result = await caller().delete({ id: project.id });

    expect(result.deletedChatIds).toEqual([stays.id]);
    expect(await getChatById(db, moved.id)).not.toBeNull();
    expect(cleanup.clearCodexSession.mock.calls).toEqual([[stays.id]]);
    expect(cleanup.trackWorkspaceDeleted.mock.calls).toEqual([[stays.id]]);
  });

  it('answers from the caller snapshot when a concurrent delete already took the project', async () => {
    const other = await createProject(db, { name: 'Q', path: '/tmp/q-lost' });
    const movedAway = await createChat(db, { name: 'Moved', projectId: other.id });

    const result = await caller().delete({
      id: 'gone-project',
      chatIds: [movedAway.id, 'gone-chat'],
    });

    expect(result).toEqual({ project: null, deletedChatIds: ['gone-chat'] });
    expect(cleanup.clearCodexSession).not.toHaveBeenCalled();
  });

  it('also reports a snapshot chat another window deleted on its own meanwhile', async () => {
    const project = await createProject(db, { name: 'P', path: '/tmp/p-snap' });
    const chat = await createChat(db, { name: 'C', projectId: project.id });

    const result = await caller().delete({
      id: project.id,
      chatIds: [chat.id, 'deleted-elsewhere'],
    });

    expect(result.project?.id).toBe(project.id);
    expect(result.deletedChatIds).toEqual([chat.id, 'deleted-elsewhere']);
    expect(cleanup.clearCodexSession.mock.calls).toEqual([[chat.id]]);
  });

  const moveTo = (chatId: string, projectId: string | null) =>
    moveChatToProjectLocal(db, chatId, {
      projectId,
      worktreePath: null,
      branch: null,
      baseBranch: null,
      stalePrunedProjectId: null,
    });

  it('refuses to move a chat out of, or into, a project while its delete is in flight', async () => {
    const project = await createProject(db, { name: 'P', path: '/tmp/p-lock' });
    const other = await createProject(db, { name: 'Q', path: '/tmp/q-lock' });
    const inside = await createChat(db, { name: 'In', projectId: project.id });
    const outside = await createChat(db, { name: 'Out', projectId: other.id });
    const attempts: Array<Promise<unknown>> = [];
    beforeDeleting(() => {
      attempts.push(moveTo(inside.id, other.id), moveTo(outside.id, project.id));
    });

    const result = await caller().delete({ id: project.id });
    const settled = await Promise.allSettled(attempts);

    expect(settled.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(result.deletedChatIds).toEqual([inside.id]);
    expect((await getChatById(db, outside.id))?.projectId).toBe(other.id);
  });

  it('lets chats move again once a failed delete has settled', async () => {
    const project = await createProject(db, { name: 'P', path: '/tmp/p-unlock' });
    const other = await createProject(db, { name: 'Q', path: '/tmp/q-unlock' });
    const chat = await createChat(db, { name: 'C', projectId: project.id });
    failDeleting();

    await expect(caller().delete({ id: project.id })).rejects.toThrow('database is locked');

    expect((await moveTo(chat.id, other.id)).updated?.projectId).toBe(other.id);
  });

  it('logs, rather than leaks, a rejection from the background worktree cleanup', async () => {
    const failure = new Error('git env failed');
    vi.spyOn(teardown, 'removeProjectWorktrees').mockRejectedValue(failure);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const project = await createProject(db, { name: 'P', path: '/tmp/p-wt-reject' });
    const chat = await createChat(db, { name: 'C', projectId: project.id });

    const result = await caller().delete({ id: project.id });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    expect(result.deletedChatIds).toEqual([chat.id]);
    expect(warn).toHaveBeenCalledWith(
      '[projects.delete] worktree cleanup failed; boot sweep will reclaim',
      failure,
    );
  });
});
