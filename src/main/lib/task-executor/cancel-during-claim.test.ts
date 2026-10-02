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

// The claim's fresh delivery read (flowDispatchStamps) sees `currentRow`; nothing else reads it here.
const currentRow = vi.hoisted(() => ({ value: undefined as { result: unknown } | undefined }));
vi.mock('../db', async (importOriginal) => {
  const chain = { from: () => chain, where: () => chain, get: () => currentRow.value };
  return {
    ...(await importOriginal<typeof import('../db')>()),
    getDatabase: vi.fn(() => ({ select: () => chain })),
  };
});

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

import {
  failUnstampedFlowClaim,
  flowDispatchStamps,
  redeliverTaskDispatch,
} from './dispatch-delivery';
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

// sc-2775: a flow dispatch is stamped so the executor and the watchdog can tell whether its turn
// ever started, and a held dispatch can be re-sent once.
describe('handleClaimedTask — dispatch delivery stamp', () => {
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

  const stampedResult = () => runningStampOptions()?.result as Record<string, unknown> | undefined;

  it('stamps dispatchedAt on a flow task claim', async () => {
    await handleClaimedTask({ ...claimedTask(), flowRunId: 'run-1', nodeRunId: 'node-1' });

    expect(typeof stampedResult()?.dispatchedAt).toBe('string');
    expect(chatReadySent()).toBe(true);
  });

  it('keeps a re-claimed flow task delivered when its turn already started (heartbeat lapse)', async () => {
    const started = '2026-10-02T10:30:20.000Z';
    await handleClaimedTask({
      ...claimedTask(),
      flowRunId: 'run-1',
      nodeRunId: 'node-1',
      result: { chatId: 'chat-1', dispatchedAt: started, dispatchStartedAt: started },
    });

    expect(stampedResult()?.dispatchStartedAt).toBe(stampedResult()?.dispatchedAt);
  });

  it('starts a user retry undelivered even though its last attempt ran', async () => {
    const started = '2026-10-02T10:30:20.000Z';
    await handleClaimedTask({
      ...claimedTask(),
      flowRunId: 'run-1',
      nodeRunId: 'node-1',
      result: { retryMode: 'continue', dispatchedAt: started, dispatchStartedAt: started },
    });

    expect(typeof stampedResult()?.dispatchedAt).toBe('string');
    expect(stampedResult()).not.toHaveProperty('dispatchStartedAt');
  });

  it('never dispatches a flow task whose delivery stamp could not be written', async () => {
    updateTaskStatusMock.mockRejectedValueOnce(new Error('SQLITE_BUSY'));

    await handleClaimedTask({ ...claimedTask(), flowRunId: 'run-1', nodeRunId: 'node-1' });

    expect(chatReadySent()).toBe(false);
  });

  // The claim already created its chat: the requeued claim must reuse it, not orphan another.
  it('fails an unstamped flow claim keeping the chat it created', () => {
    const task = { ...claimedTask(), flowRunId: 'run-1', nodeRunId: 'node-1' };
    const error = new Error('SQLITE_BUSY');

    expect(() =>
      failUnstampedFlowClaim(task, { chatId: 'chat-1', subChatId: 'sub-1' }, error),
    ).toThrow(error);
    expect(task.result).toMatchObject({ chatId: 'chat-1', subChatId: 'sub-1' });
  });

  it('gives every dispatch attempt a distinct, increasing generation, even within a millisecond', () => {
    const task = { ...claimedTask(), flowRunId: 'run-1', nodeRunId: 'node-1' };
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-02T10:30:13.000Z'));
    const a = flowDispatchStamps(task, null, 'sub-1')?.dispatchedAt ?? '';
    const b = flowDispatchStamps(task, null, 'sub-1')?.dispatchedAt ?? '';
    now.mockRestore();
    expect(b > a).toBe(true);
  });

  it('leaves a non-flow task unstamped', async () => {
    await handleClaimedTask(claimedTask());

    expect(stampedResult()).not.toHaveProperty('dispatchedAt');
  });

  const flowClaim = (result: DbTask['result'] = null) =>
    handleClaimedTask({ ...claimedTask(), flowRunId: 'run-1', nodeRunId: 'node-1', result });
  const sentGeneration = () =>
    String(
      sendMock.mock.calls.find(([channel]) => channel === 'task:chat-ready')?.[1]
        ?.dispatchGeneration,
    );

  it('redeliverTaskDispatch re-broadcasts the held payload once dispatched', async () => {
    await flowClaim();
    const generation = sentGeneration();
    sendMock.mockClear();

    expect(redeliverTaskDispatch('task-cancel-1', generation)).toBe(true);
    expect(sendMock).toHaveBeenCalledWith(
      'task:chat-ready',
      expect.objectContaining({ taskId: 'task-cancel-1', subChatId: 'sub-1' }),
    );
  });

  it('never redelivers as a retry, so the renderer dedup cannot be bypassed into a second run', async () => {
    const { registerPendingDispatchMode } = await import('./dispatch-registry');
    registerPendingDispatchMode('sub-r', 'task-retry', 'execute', {
      chatId: 'chat-1',
      subChatId: 'sub-r',
      taskId: 'task-retry',
      prompt: 'Do the thing',
      projectId: null,
      projectPath: null,
      startMode: 'execute',
      skipReview: false,
      headless: true,
      isRetry: true,
      dispatchGeneration: 'gen-retry',
    });
    sendMock.mockClear();

    redeliverTaskDispatch('task-retry', 'gen-retry');

    expect(sendMock.mock.calls[0]?.[1]).toMatchObject({ taskId: 'task-retry' });
    expect(sendMock.mock.calls[0]?.[1]).not.toHaveProperty('isRetry');
  });

  it('dispatches a flow step to one window only, so a second window cannot replace its turn', async () => {
    const otherSend = vi.fn();
    const { BrowserWindow } = await import('electron');
    const two = [
      { isDestroyed: () => false, webContents: { send: sendMock } },
      { isDestroyed: () => false, webContents: { send: otherSend } },
    ] as never;
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue(two);

    await flowClaim();

    expect(chatReadySent()).toBe(true);
    expect(otherSend).not.toHaveBeenCalled();
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
      { isDestroyed: () => false, webContents: { send: sendMock } },
    ] as never);
  });

  it('redelivers to one window only, so two windows cannot both run an undelivered prompt', async () => {
    const otherSend = vi.fn();
    const { BrowserWindow } = await import('electron');
    await flowClaim();
    const generation = sentGeneration();
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValueOnce([
      { isDestroyed: () => false, webContents: { send: sendMock } },
      { isDestroyed: () => false, webContents: { send: otherSend } },
    ] as never);
    sendMock.mockClear();

    redeliverTaskDispatch('task-cancel-1', generation);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(otherSend).not.toHaveBeenCalled();
  });

  it('stamps the payload with its dispatch generation on a flow claim', async () => {
    await handleClaimedTask({ ...claimedTask(), flowRunId: 'run-1', nodeRunId: 'node-1' });

    const sent = sendMock.mock.calls.find(([channel]) => channel === 'task:chat-ready')?.[1];
    expect(sent?.dispatchGeneration).toBe(stampedResult()?.dispatchedAt);
  });

  it('never holds a redelivery it could not send (no window): a failed step must not be pulled later', async () => {
    const { BrowserWindow } = await import('electron');
    const { listUndeliveredDispatches, consumeDispatchMode } = await import('./dispatch-registry');
    await flowClaim();
    const generation = sentGeneration();
    consumeDispatchMode('sub-1', 'task-cancel-1', generation);
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValueOnce([]);

    expect(redeliverTaskDispatch('task-cancel-1', generation)).toBe(false);
    expect(listUndeliveredDispatches().map((d) => d.taskId)).not.toContain('task-cancel-1');
  });

  // An unrelated live turn on a reused chat proves nothing about THIS dispatch.
  // The claim's snapshot predates chat setup; a start stamped meanwhile is on the row, not the snapshot.
  it('a re-claim reads the start from the current row, not its stale snapshot', async () => {
    currentRow.value = {
      result: {
        dispatchedAt: '2026-10-02T10:30:13.000Z',
        dispatchStartedAt: '2026-10-02T10:30:20.000Z',
      },
    };
    await flowClaim();
    currentRow.value = undefined;

    expect(stampedResult()?.dispatchStartedAt).toBe(stampedResult()?.dispatchedAt);
  });

  it('a live turn on the chat does not mark a fresh dispatch delivered', async () => {
    const { _registerExecutionForTests, _clearActiveExecutionsForTests } =
      await import('../socket/streaming/execution-registry');
    _registerExecutionForTests('sub-1', new AbortController());

    await flowClaim();

    expect(stampedResult()).not.toHaveProperty('dispatchStartedAt');
    _clearActiveExecutionsForTests();
  });

  it('never redelivers a newer attempt than the one the watchdog stamped', async () => {
    await flowClaim();
    sendMock.mockClear();

    expect(redeliverTaskDispatch('task-cancel-1', '2026-10-02T09:00:00.000Z')).toBe(false);
    expect(chatReadySent()).toBe(false);
  });

  it('redeliverTaskDispatch reports false when nothing is held', () => {
    expect(redeliverTaskDispatch('never-dispatched', 'gen')).toBe(false);
    expect(chatReadySent()).toBe(false);
  });
});
