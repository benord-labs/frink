/**
 * Integration tests for handleClaimedTask → createChatForTask model forwarding.
 *
 * The pure gate `shouldForwardTaskModel` is unit-tested in index.test.ts; here we cover the
 * INTEGRATION seam it feeds: a configured `_config.model` is carried into the `task:chat-ready`
 * IPC payload for a compatible account, and DROPPED (with a fallback reason + account-default
 * activeModel persisted to task.result) for an incompatible one. Account type is driven by the
 * default credential since these tasks carry no project (null-project shortcut keeps the executor
 * off the worktree / project-account paths).
 */
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

/** A claimed non-fallback task with no project (skips worktree / project-account resolution). */
function modelTask(model: string): DbTask {
  return {
    id: 'task-model-1',
    projectId: null,
    title: 'Model task',
    description: 'Do the thing',
    source: 'flow',
    sourceId: null,
    executionTarget: 'local',
    requiresFilesystem: true,
    status: 'running',
    result: null,
    triggerContext: {
      _config: { startMode: 'execute', model },
    } as unknown as DbTask['triggerContext'],
    flowRunId: null,
    nodeRunId: null,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    startedAt: new Date('2025-01-01T00:00:01.000Z'),
    completedAt: null,
    executedBy: null,
  };
}

/** Same claimed task but with no model configured (only startMode in _config). */
function noModelTask(): DbTask {
  const task = modelTask('sonnet');
  return {
    ...task,
    triggerContext: { _config: { startMode: 'execute' } } as unknown as DbTask['triggerContext'],
  };
}

/** The payload broadcast on the `task:chat-ready` channel, or undefined if none was sent. */
function sentChatReadyPayload(): { model?: string } | undefined {
  const call = sendMock.mock.calls.find(([channel]) => channel === 'task:chat-ready');
  return call?.[1] as { model?: string } | undefined;
}

/** The result object persisted by the `running`-status task update. */
function runningResult(): Record<string, unknown> | undefined {
  const call = updateTaskStatusMock.mock.calls.find(([, , status]) => status === 'running');
  return (call?.[3] as { result?: Record<string, unknown> } | undefined)?.result;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('handleClaimedTask — model forwarding into task:chat-ready', () => {
  beforeEach(() => {
    createChatMock.mockResolvedValue({ id: 'chat-1' });
    createSubChatMock.mockResolvedValue({ id: 'sub-1' });
    updateTaskStatusMock.mockResolvedValue({ id: 'task-model-1', status: 'running' });
    getTaskByIdMock.mockResolvedValue({ id: 'task-model-1', status: 'running' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('claude-code account + compatible model: payload carries the model, no fallback reason', async () => {
    getDefaultClaudeCodeTokenMock.mockResolvedValue({ type: 'claude-code', token: 't' });

    await handleClaimedTask(modelTask('sonnet'));

    expect(sentChatReadyPayload()?.model).toBe('sonnet');
    expect(runningResult()?.activeModel).toBe('sonnet');
    expect(runningResult()?.modelFallbackReason).toBeUndefined();
  });

  it('codex account + incompatible claude model: model dropped, account-default fallback persisted', async () => {
    getDefaultClaudeCodeTokenMock.mockResolvedValue({ type: 'codex', token: 't' });

    await handleClaimedTask(modelTask('sonnet'));

    // Incompatible model must NOT reach the renderer transport (would run the wrong CLI).
    expect(sentChatReadyPayload()?.model).toBeUndefined();
    expect(runningResult()?.activeModel).toBe('account-default');
    expect(runningResult()?.modelFallbackReason).toEqual(expect.stringContaining('OpenAI'));
    // The user's original choice is still recorded (surfaces "you asked for X, ran Y" in the UI).
    expect(runningResult()?.requestedModel).toBe('sonnet');
  });

  it('claude-code account + incompatible codex model: dropped with account-default fallback', async () => {
    // The other fallback branch: a codex picker id routed to a Claude account.
    getDefaultClaudeCodeTokenMock.mockResolvedValue({ type: 'claude-code', token: 't' });

    await handleClaimedTask(modelTask('codex-gpt-5.3-codex-high'));

    expect(sentChatReadyPayload()?.model).toBeUndefined();
    expect(runningResult()?.activeModel).toBe('account-default');
    expect(runningResult()?.modelFallbackReason).toEqual(expect.stringContaining('Claude'));
    expect(runningResult()?.requestedModel).toBe('codex-gpt-5.3-codex-high');
  });

  it('no configured model: payload omits model and the fallback machinery never fires', async () => {
    // Guards against the model block firing spuriously — a task with no _config.model must not
    // stamp an activeModel/fallbackReason (which would surface a phantom "fell back" notice).
    getDefaultClaudeCodeTokenMock.mockResolvedValue({ type: 'codex', token: 't' });

    await handleClaimedTask(noModelTask());

    expect(sentChatReadyPayload()).toBeDefined();
    expect(sentChatReadyPayload()?.model).toBeUndefined();
    expect(runningResult()?.activeModel).toBeUndefined();
    expect(runningResult()?.modelFallbackReason).toBeUndefined();
    expect(runningResult()?.requestedModel).toBeUndefined();
  });

  it('codex account + compatible codex model: payload forwards the codex picker id', async () => {
    getDefaultClaudeCodeTokenMock.mockResolvedValue({ type: 'codex', token: 't' });

    await handleClaimedTask(modelTask('codex-gpt-5.2'));

    expect(sentChatReadyPayload()?.model).toBe('codex-gpt-5.2');
    expect(runningResult()?.modelFallbackReason).toBeUndefined();
  });
});
