/**
 * Regression: deleting a project cascade-deletes its chats, but flow_runs link to chats
 * only via JSON (no FK), so a chat-driven flow would keep running after the project is gone
 * (same class as the chat delete/archive bug). projects.delete must cancel those runs too.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChat } from '../../db/repos/chats';
import { getFlowRun, setFlowRunStatus } from '../../db/repos/flow-runs';
import { createTask, getTaskById } from '../../db/repos/tasks';
import { seedCompletedNodeRun, seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';

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
vi.mock('../../socket/executor', () => ({ abortActiveExecutionsForSubChats: vi.fn() }));
vi.mock('../../cli', () => ({ getLaunchDirectory: vi.fn() }));
vi.mock('../../git', () => ({ getGitRemoteInfo: vi.fn() }));
vi.mock('../../analytics', () => ({ trackProjectOpened: vi.fn() }));
vi.mock('../../project-scaffold', () => ({
  removeManagedBuildFolder: vi.fn().mockResolvedValue(undefined),
  scaffoldBuild: vi.fn(),
}));

import { projectsRouter } from './projects';

const GRAPH = { nodes: [{ id: 'st', blockType: 'start_task' }], edges: [] };

let db: TestDb;
beforeEach(() => {
  db = freshDb();
  h.db = db;
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
});
