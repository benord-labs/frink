// sc-3263: a Cancel landing while a claimed task is still being prepared must survive the
// executor's `running` stamp and must not be dispatched (no live session existed to abort).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDatabase } from '../db';
import { RESTART_INTERRUPTION_REASON } from '../../../shared/types/flow';
import { createNodeRun, getNodeRun } from '../db/repos/node-runs';
import { type Task as DbTask, chats, flowRuns, tasks } from '../db/schema';
import { getOrCreateFlowRunByIdempotencyKey } from '../db/repos/flow-runs';
import { createFlowVersion } from '../db/repos/flow-versions';
import { createFlow } from '../db/repos/flows';
import { seedActiveAdmission } from '../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const {
  getCloudProjectByIdMock,
  updateChatMock,
  updateTaskStatusMock,
  getTaskByIdMock,
  createChatMock,
  createSubChatMock,
  getProjectAiAccountMock,
  getSubChatsForChatMock,
  getDefaultClaudeCodeTokenMock,
  sendMock,
} = vi.hoisted(() => ({
  getCloudProjectByIdMock: vi.fn(),
  updateChatMock: vi.fn(),
  updateTaskStatusMock: vi.fn(),
  getTaskByIdMock: vi.fn(),
  createChatMock: vi.fn(),
  createSubChatMock: vi.fn(),
  getProjectAiAccountMock: vi.fn(),
  getSubChatsForChatMock: vi.fn(),
  getDefaultClaudeCodeTokenMock: vi.fn(),
  sendMock: vi.fn(),
}));

// ── Module mocks ───────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{ isDestroyed: () => false, webContents: { send: sendMock } }]),
  },
  app: { isPackaged: false, getAppPath: () => '/mock/app', getPath: () => '/mock/home' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (v: string) => Buffer.from(v),
    decryptString: (v: Buffer) => v.toString(),
  },
}));

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getDatabase: vi.fn(() => ({})),
}));

vi.mock('../db/repos/projects', () => ({ getProjectById: getCloudProjectByIdMock }));
vi.mock('../db/repos/chats', () => ({ updateChat: updateChatMock, createChat: createChatMock }));
vi.mock('../db/repos/tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/repos/tasks')>()),
  updateTaskStatus: updateTaskStatusMock,
  getTaskById: getTaskByIdMock,
}));
vi.mock('../db/repos/project-ai-accounts', () => ({
  getProjectAiAccount: getProjectAiAccountMock,
}));
vi.mock('../db/repos/sub-chats', () => ({
  createSubChat: createSubChatMock,
  listSubChatsByChat: getSubChatsForChatMock,
}));

vi.mock('../git/worktree', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../git/worktree')>()),
  createWorktreeForBranch: vi.fn(),
  createWorktreeForChat: vi.fn(),
}));
vi.mock('../git/worktree-converge', () => ({ createWorktreeWithMergedBases: vi.fn() }));
vi.mock('../git/worktree-validation', () => ({ validateWorktreeForReuse: vi.fn() }));
vi.mock('../shell-executor', () => ({
  isShellExecutionMode: vi.fn(() => false),
  executeShellTask: vi.fn(),
}));
vi.mock('../task-poller', () => ({ getTaskPoller: vi.fn(() => ({ on: vi.fn() })) }));
vi.mock('../credentials', () => ({
  getClaudeCodeTokenById: vi.fn(),
  getDefaultClaudeCodeToken: getDefaultClaudeCodeTokenMock,
  isResolvedCredential: (cred: { token?: string | null; passthrough?: boolean } | null) =>
    !!cred?.token || cred?.passthrough === true,
}));

// ── Import after mocks ─────────────────────────────────────────────────────────

import { handleClaimedTask } from './index';

// ── Helpers ────────────────────────────────────────────────────────────────────

function claimedTask(): DbTask {
  return {
    id: 'task-cancel-1',
    projectId: null,
    title: 'Cancelled mid-claim',
    description: 'Do the thing',
    source: 'manual',
    sourceId: null,
    executionTarget: 'local',
    requiresFilesystem: true,
    status: 'running',
    result: null,
    triggerContext: { _config: { startMode: 'execute' } } as unknown as DbTask['triggerContext'],
    flowRunId: null,
    nodeRunId: null,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    startedAt: new Date('2025-01-01T00:00:01.000Z'),
    completedAt: null,
    executedBy: null,
  };
}

function chatReadySent(): boolean {
  return sendMock.mock.calls.some(([channel]) => channel === 'task:chat-ready');
}

function runningStampOptions(): Record<string, unknown> | undefined {
  const call = updateTaskStatusMock.mock.calls.find(([, , status]) => status === 'running');
  return call?.[3] as Record<string, unknown> | undefined;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('handleClaimedTask — cancel during the claim window', () => {
  beforeEach(() => {
    createChatMock.mockResolvedValue({ id: 'chat-1' });
    createSubChatMock.mockResolvedValue({ id: 'sub-1' });
    getDefaultClaudeCodeTokenMock.mockResolvedValue({ type: 'claude-code', token: 't' });
    updateTaskStatusMock.mockResolvedValue({ id: 'task-cancel-1', status: 'running' });
    getTaskByIdMock.mockResolvedValue({ id: 'task-cancel-1', status: 'running' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('guards the running stamp on status=running so it cannot overwrite a cancel', async () => {
    await handleClaimedTask(claimedTask());

    expect(runningStampOptions()?.expectStatuses).toEqual(['running']);
    expect(chatReadySent()).toBe(true);
  });

  it('does not dispatch when the task was cancelled before the stamp (stamp misses)', async () => {
    updateTaskStatusMock.mockResolvedValue(null);
    getTaskByIdMock.mockResolvedValue({ id: 'task-cancel-1', status: 'cancelled' });

    await handleClaimedTask(claimedTask());

    expect(chatReadySent()).toBe(false);
    // Nothing else may rewrite the cancelled row (no dispatch-failure `failed`/retry write).
    expect(updateTaskStatusMock.mock.calls.filter(([, , status]) => status !== 'running')).toEqual(
      [],
    );
  });

  it('does not dispatch when the cancel landed after the stamp but before dispatch', async () => {
    // Stamp succeeded (still running then); the Cancel lands during attachment/prompt prep.
    getTaskByIdMock.mockResolvedValue({ id: 'task-cancel-1', status: 'cancelled' });

    await handleClaimedTask(claimedTask());

    expect(chatReadySent()).toBe(false);
    expect(getTaskByIdMock).toHaveBeenCalledWith(expect.anything(), 'task-cancel-1');
  });

  it('does not dispatch when the task row was deleted mid-prep', async () => {
    getTaskByIdMock.mockResolvedValue(null);

    await handleClaimedTask(claimedTask());

    expect(chatReadySent()).toBe(false);
  });

  it('still dispatches when the stamp write itself throws (non-critical, row untouched)', async () => {
    updateTaskStatusMock.mockRejectedValue(new Error('SQLITE_BUSY'));

    await handleClaimedTask(claimedTask());

    expect(chatReadySent()).toBe(true);
  });

  describe('linked chat archived after the task was parked', () => {
    let db: TestDb;
    const storedStatus = () => db.select().from(tasks).where(eq(tasks.id, 'task-cancel-1')).get();

    beforeEach(() => {
      db = freshDb();
      vi.mocked(getDatabase).mockReturnValue(db);
      db.insert(chats).values({ id: 'chat-1', name: 'archived', archivedAt: new Date() }).run();
    });

    afterEach(() => {
      vi.mocked(getDatabase).mockReset();
    });

    it('cancels the claimed task instead of dispatching into the archived chat', async () => {
      db.insert(tasks)
        .values({ ...claimedTask(), triggerContext: null })
        .run();

      await handleClaimedTask(claimedTask());

      expect(chatReadySent()).toBe(false);
      expect(storedStatus()?.status).toBe('cancelled');
    });

    it('leaves a flow task to its run', async () => {
      // The guard reads only the task's own flowRunId, so the run row itself is not needed.
      db.$client.pragma('foreign_keys = OFF');
      const flowTask = { ...claimedTask(), source: 'flow', flowRunId: 'run-1' };
      db.insert(tasks)
        .values({ ...flowTask, triggerContext: null })
        .run();

      await handleClaimedTask(flowTask);

      expect(storedStatus()?.status).toBe('running');
    });

    // A Retry claimed after a restart interrupted its run must not revive the cancelled step in
    // place: it fails loud and leaves the run to the resume ticket its next Retry goes through.
    it('fails a Retry claim on a restart-interrupted run without reviving or dispatching it', async () => {
      // seedFlowRun also creates a project, whose repo this harness mocks; a run needs none.
      const flow = await createFlow(db, { name: 'F' });
      const version = await createFlowVersion(db, {
        flowId: flow.id,
        graph: { nodes: [{ id: 'a', blockType: 'agent', position: { x: 0, y: 0 } }], edges: [] },
      });
      const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
        flowVersionId: version.id,
        status: 'running',
        triggerContext: null,
        idempotencyKey: 'retry-claim',
        startedAt: new Date(),
      });
      const flowRunId = run.id;
      seedActiveAdmission(db, flowRunId);
      const marked = await createNodeRun(db, {
        flowRunId,
        nodeId: 'a',
        blockType: 'agent',
        status: 'cancelled',
        nodeOutput: {
          status: 'cancelled',
          outputs: {},
          artifacts: [],
          durationMs: 0,
          error: { message: RESTART_INTERRUPTION_REASON, retryable: true },
        },
      });
      db.update(flowRuns).set({ status: 'cancelled' }).where(eq(flowRuns.id, flowRunId)).run();
      const retryTask: DbTask = {
        ...claimedTask(),
        source: 'flow',
        flowRunId,
        nodeRunId: marked.id,
        result: { retryMode: 'continue' },
      };

      await handleClaimedTask(retryTask);

      expect(chatReadySent()).toBe(false);
      expect(updateTaskStatusMock).toHaveBeenCalledWith(
        expect.anything(),
        'task-cancel-1',
        'failed',
        expect.objectContaining({
          result: expect.objectContaining({
            error: expect.stringMatching(/Use Retry on it again/),
          }),
        }),
      );
      expect((await getNodeRun(db, marked.id))?.status).toBe('cancelled');
      expect(db.select().from(flowRuns).where(eq(flowRuns.id, flowRunId)).get()?.status).toBe(
        'cancelled',
      );
      // The claim's first dynamic import of the flows layer is slow to transform cold.
    }, 30_000);

    it('still dispatches when the chat is live', async () => {
      db.update(chats).set({ archivedAt: null }).where(eq(chats.id, 'chat-1')).run();
      db.insert(tasks)
        .values({ ...claimedTask(), triggerContext: null })
        .run();

      await handleClaimedTask(claimedTask());

      expect(chatReadySent()).toBe(true);
      expect(storedStatus()?.status).toBe('running');
    });
  });
});
