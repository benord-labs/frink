// sc-3263: a Cancel landing while a claimed task is still being prepared must survive the
// executor's `running` stamp and must not be dispatched (no live session existed to abort).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task as DbTask } from '../db/schema';

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
});
