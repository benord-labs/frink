/**
 * Integration tests for handleClaimedTask → executeStartTaskFallback.
 *
 * Covers edge cases identified for the start_task offline fallback path:
 * - Happy path (medium-critical): worktree provisioned, chat updated BEFORE task status, task marked done
 * - Call order invariant: updateChat must precede updateTaskStatus (signal-bridge reads chat JOIN)
 * - Worktree failure: task marked failed, updateChat NOT called
 * - Project not found: task marked failed, no worktree or updateChat
 * - updateChat throws → outer catch resets to 'pending' (loop risk documented)
 * - Branch absent: createWorktreeForBranch called with undefined (uses default branch)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task as DbTask } from '../db/schema';

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const {
  getCloudProjectByIdMock,
  updateChatMock,
  updateTaskStatusMock,
  createChatMock,
  createSubChatMock,
  getProjectAiAccountMock,
  getSubChatsForChatMock,
} = vi.hoisted(() => ({
  getCloudProjectByIdMock: vi.fn(),
  updateChatMock: vi.fn(),
  updateTaskStatusMock: vi.fn(),
  createChatMock: vi.fn(),
  createSubChatMock: vi.fn(),
  getProjectAiAccountMock: vi.fn(),
  getSubChatsForChatMock: vi.fn(),
}));

const { createWorktreeForBranchMock, createWorktreeForChatMock } = vi.hoisted(() => ({
  createWorktreeForBranchMock: vi.fn(),
  createWorktreeForChatMock: vi.fn(),
}));

const { createWorktreeWithMergedBasesMock } = vi.hoisted(() => ({
  createWorktreeWithMergedBasesMock: vi.fn(),
}));

// ── Module mocks ───────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  app: { isPackaged: false, getAppPath: () => '/mock/app', getPath: () => '/mock/home' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (v: string) => Buffer.from(v),
    decryptString: (v: Buffer) => v.toString(),
  },
}));

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getDatabase: vi.fn(() => ({})),
}));

vi.mock('../db/repos/projects', () => ({
  getProjectById: getCloudProjectByIdMock,
}));

vi.mock('../db/repos/chats', () => ({
  updateChat: updateChatMock,
  createChat: createChatMock,
}));

vi.mock('../db/repos/tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/repos/tasks')>()),
  updateTaskStatus: updateTaskStatusMock,
}));

vi.mock('../db/repos/project-ai-accounts', () => ({
  getProjectAiAccount: getProjectAiAccountMock,
}));

vi.mock('../db/repos/sub-chats', () => ({
  createSubChat: createSubChatMock,
  listSubChatsByChat: getSubChatsForChatMock,
}));

vi.mock('../git/worktree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git/worktree')>();
  return {
    ...actual,
    createWorktreeForBranch: createWorktreeForBranchMock,
    createWorktreeForChat: createWorktreeForChatMock,
  };
});

vi.mock('../git/worktree-converge', () => ({
  createWorktreeWithMergedBases: createWorktreeWithMergedBasesMock,
}));

vi.mock('../git/worktree-validation', () => ({ validateWorktreeForReuse: vi.fn() }));
vi.mock('../shell-executor', () => ({
  isShellExecutionMode: vi.fn(() => false),
  executeShellTask: vi.fn(),
}));
vi.mock('../task-poller', () => ({ getTaskPoller: vi.fn(() => ({ on: vi.fn() })) }));
vi.mock('../credentials', () => ({
  getClaudeCodeTokenByLabel: vi.fn(),
  getDefaultClaudeCodeToken: vi.fn(),
  // Mirrors the real predicate (credentials.ts): passthrough rows are token-null by design,
  // so `passthrough` — not token presence — is what the spawn pre-flight gates on.
  isResolvedCredential: (
    cred: { token?: string | null; passthrough?: boolean } | null | undefined,
  ) => !!cred?.token || cred?.passthrough === true,
}));

// ── Import after mocks ─────────────────────────────────────────────────────────

import { getTaskPoller } from '../task-poller';
import { handleClaimedTask, initTaskExecutor } from './index';

// ── Helpers ────────────────────────────────────────────────────────────────────

const BASE_TASK: DbTask = {
  id: 'task-st-1',
  projectId: 'proj-1',
  title: 'Provision worktree',
  description: 'Provision worktree',
  source: 'flow',
  sourceId: null,
  executionTarget: 'local',
  requiresFilesystem: true,
  status: 'running',
  result: null,
  triggerContext: {
    _config: {
      executionMode: 'start_task',
      flowStartTaskChatId: 'chat-flow-1',
      flowStartTaskSubChatId: 'sub-flow-1',
      branch: 'feat/pr-42',
    },
  } as unknown as DbTask['triggerContext'],
  flowRunId: null,
  nodeRunId: null,
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  startedAt: new Date('2025-01-01T00:00:01.000Z'),
  completedAt: null,
  executedBy: null,
};

const SUCCESS_WORKTREE = {
  success: true as const,
  worktreePath: '/repos/.frink-worktrees/owners-web/feat-pr-42',
  branch: 'feat/pr-42',
  baseBranch: 'main',
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('handleClaimedTask — start_task offline fallback', () => {
  beforeEach(() => {
    getCloudProjectByIdMock.mockResolvedValue({
      id: 'proj-1',
      path: '/repos/owners-web',
      name: 'owners-web',
    });
    updateChatMock.mockResolvedValue({ id: 'chat-flow-1' });
    updateTaskStatusMock.mockResolvedValue({ id: 'task-st-1', status: 'done' });
    createWorktreeForBranchMock.mockResolvedValue(SUCCESS_WORKTREE);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: provisions worktree, updates chat with all worktree fields, marks task done', async () => {
    await handleClaimedTask(BASE_TASK);

    expect(createWorktreeForBranchMock).toHaveBeenCalledWith(
      '/repos/owners-web',
      expect.any(String),
      'feat/pr-42',
    );

    expect(updateChatMock).toHaveBeenCalledWith(expect.anything(), 'chat-flow-1', {
      worktreePath: '/repos/.frink-worktrees/owners-web/feat-pr-42',
      branch: 'feat/pr-42',
      baseBranch: 'main',
    });

    expect(updateTaskStatusMock).toHaveBeenCalledWith(expect.anything(), 'task-st-1', 'done', {
      result: { configured: true, exitCode: 0 },
    });
  });

  it('initTaskExecutor runs a task the poller emits as task:claimed', async () => {
    initTaskExecutor();

    const onClaimed = vi
      .mocked(getTaskPoller)
      .mock.results.flatMap((result) => vi.mocked(result.value.on).mock.calls)
      .find(([event]) => event === 'task:claimed')?.[1];
    expect(onClaimed).toBeTypeOf('function');
    onClaimed?.(BASE_TASK);

    await vi.waitFor(() =>
      expect(updateTaskStatusMock).toHaveBeenCalledWith(expect.anything(), 'task-st-1', 'done', {
        result: { configured: true, exitCode: 0 },
      }),
    );
  });

  it('updateChat is called BEFORE updateTaskStatus (signal-bridge reads worktree from chat JOIN)', async () => {
    const callOrder: string[] = [];
    updateChatMock.mockImplementation(async () => {
      callOrder.push('updateChat');
      return { id: 'chat-flow-1' };
    });
    updateTaskStatusMock.mockImplementation(async () => {
      callOrder.push('updateTaskStatus');
      return { id: 'task-st-1' };
    });

    await handleClaimedTask(BASE_TASK);

    const chatIdx = callOrder.indexOf('updateChat');
    const statusIdx = callOrder.indexOf('updateTaskStatus');
    expect(chatIdx).toBeGreaterThanOrEqual(0);
    expect(chatIdx).toBeLessThan(statusIdx);
  });

  it('worktree failure: marks task failed with error message, does NOT call updateChat', async () => {
    createWorktreeForBranchMock.mockResolvedValue({
      success: false,
      error: 'git: could not lock ref',
    });

    await handleClaimedTask(BASE_TASK);

    expect(updateChatMock).not.toHaveBeenCalled();
    expect(updateTaskStatusMock).toHaveBeenCalledWith(expect.anything(), 'task-st-1', 'failed', {
      result: { error: 'git: could not lock ref' },
    });
  });

  it('worktree failure with no error string: uses fallback error message', async () => {
    createWorktreeForBranchMock.mockResolvedValue({ success: false });

    await handleClaimedTask(BASE_TASK);

    expect(updateTaskStatusMock).toHaveBeenCalledWith(expect.anything(), 'task-st-1', 'failed', {
      result: { error: 'Failed to create worktree' },
    });
  });

  it('project not found (null): marks task failed, no worktree provisioned, no updateChat', async () => {
    getCloudProjectByIdMock.mockResolvedValue(null);

    await handleClaimedTask(BASE_TASK);

    expect(createWorktreeForBranchMock).not.toHaveBeenCalled();
    expect(updateChatMock).not.toHaveBeenCalled();
    expect(updateTaskStatusMock).toHaveBeenCalledWith(expect.anything(), 'task-st-1', 'failed', {
      result: { error: expect.stringContaining('no project path') },
    });
  });

  it('updateChat throws: outer catch resets task to pending with a bounded attempt counter', async () => {
    updateChatMock.mockRejectedValue(new Error('Network timeout'));

    await handleClaimedTask(BASE_TASK);

    // 'done' was never written — the throw short-circuited before updateTaskStatus('done')
    expect(updateTaskStatusMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'task-st-1',
      'done',
      expect.anything(),
    );
    // Outer catch resets to 'pending' (transient error, below the dispatch-attempt cap) so the
    // task can be reclaimed; CAS on 'running' so a concurrent cancel wins.
    expect(updateTaskStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      'task-st-1',
      'pending',
      expect.objectContaining({
        expectStatuses: ['running'],
        result: expect.objectContaining({ error: 'Network timeout', dispatchAttempts: 1 }),
      }),
    );
  });

  it('branch absent in config: passes undefined to createWorktreeForBranch (uses default branch)', async () => {
    const task: DbTask = {
      ...BASE_TASK,
      triggerContext: {
        _config: {
          executionMode: 'start_task',
          flowStartTaskChatId: 'chat-flow-1',
          // no branch field
        },
      } as unknown as DbTask['triggerContext'],
    };

    await handleClaimedTask(task);

    expect(createWorktreeForBranchMock).toHaveBeenCalledWith(
      '/repos/owners-web',
      expect.any(String),
      undefined,
    );
  });

  it('flowStartTaskChatId absent: task still completes but updateChat is skipped', async () => {
    const task: DbTask = {
      ...BASE_TASK,
      triggerContext: {
        _config: {
          executionMode: 'start_task',
          // flowStartTaskChatId intentionally absent
          branch: 'feat/pr-42',
        },
      } as unknown as DbTask['triggerContext'],
    };

    await handleClaimedTask(task);

    expect(createWorktreeForBranchMock).toHaveBeenCalled();
    expect(updateChatMock).not.toHaveBeenCalled();
    expect(updateTaskStatusMock).toHaveBeenCalledWith(expect.anything(), 'task-st-1', 'done', {
      result: { configured: true, exitCode: 0 },
    });
  });
});

// ── sc-612: converging merge offline fallback tests ─────────────────────────

/**
 * Task shape for converging merge: baseBranches at trigger_context ROOT (not _config).
 * This mirrors what updateStartTaskFallback in node-dispatch.ts writes:
 *   { ...(flowTriggerContext ?? {}),  <- baseBranches land here
 *     _config: { executionMode: 'start_task', ... } }
 */
const CONVERGING_TASK: DbTask = {
  ...BASE_TASK,
  id: 'task-conv-1',
  triggerContext: {
    baseBranches: ['feat/ticket-2', 'feat/ticket-1'],
    mergeStrategy: 'most-recent',
    _config: {
      executionMode: 'start_task',
      flowStartTaskChatId: 'chat-conv-1',
      flowStartTaskSubChatId: 'sub-conv-1',
    },
  } as unknown as DbTask['triggerContext'],
};

const SUCCESS_CONVERGING_WORKTREE = {
  success: true as const,
  worktreePath: '/repos/.frink-worktrees/owners-web/brave-lion-aabbcc',
  branch: 'brave-lion-aabbcc',
  baseBranch: 'feat/ticket-2',
  mergedBranches: ['feat/ticket-1'],
};

const CONFLICT_CONVERGING_WORKTREE = {
  success: false as const,
  conflict: true as const,
  conflictingBranch: 'feat/ticket-1',
  conflictedFiles: ['src/index.ts', 'src/utils.ts'],
  mergedBranches: [] as string[],
  worktreePath: '/repos/.frink-worktrees/owners-web/brave-lion-aabbcc',
  branch: 'brave-lion-aabbcc',
  baseBranch: 'feat/ticket-2',
};

describe('handleClaimedTask — start_task converging merge (sc-612)', () => {
  beforeEach(() => {
    getCloudProjectByIdMock.mockResolvedValue({
      id: 'proj-1',
      path: '/repos/owners-web',
      name: 'owners-web',
    });
    updateChatMock.mockResolvedValue({ id: 'chat-conv-1' });
    updateTaskStatusMock.mockResolvedValue({ id: 'task-conv-1', status: 'done' });
    createWorktreeWithMergedBasesMock.mockResolvedValue(SUCCESS_CONVERGING_WORKTREE);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('routes to createWorktreeWithMergedBases when baseBranches has 2+ entries', async () => {
    await handleClaimedTask(CONVERGING_TASK);

    expect(createWorktreeWithMergedBasesMock).toHaveBeenCalledWith(
      '/repos/owners-web',
      expect.any(String),
      ['feat/ticket-2', 'feat/ticket-1'],
    );
    expect(createWorktreeForBranchMock).not.toHaveBeenCalled();
  });

  it('root baseBranches with empty segment skips converging; uses _config.branch for single-branch path', async () => {
    const task: DbTask = {
      ...CONVERGING_TASK,
      triggerContext: {
        baseBranches: ['', 'feat/ticket-1'],
        mergeStrategy: 'most-recent',
        _config: {
          executionMode: 'start_task',
          flowStartTaskChatId: 'chat-conv-1',
          branch: 'fallback-from-config',
        },
      } as unknown as DbTask['triggerContext'],
    };

    await handleClaimedTask(task);

    expect(createWorktreeWithMergedBasesMock).not.toHaveBeenCalled();
    expect(createWorktreeForBranchMock).toHaveBeenCalledWith(
      '/repos/owners-web',
      expect.any(String),
      'fallback-from-config',
    );
  });

  it('trims root baseBranches for converging merge (offline fallback)', async () => {
    const task: DbTask = {
      ...CONVERGING_TASK,
      triggerContext: {
        baseBranches: ['  feat/ticket-2  ', 'feat/ticket-1'],
        _config: {
          executionMode: 'start_task',
          flowStartTaskChatId: 'chat-conv-1',
          flowStartTaskSubChatId: 'sub-conv-1',
        },
      } as unknown as DbTask['triggerContext'],
    };

    await handleClaimedTask(task);

    expect(createWorktreeWithMergedBasesMock).toHaveBeenCalledWith(
      '/repos/owners-web',
      expect.any(String),
      ['feat/ticket-2', 'feat/ticket-1'],
    );
  });

  it('clean converging merge: updates chat and marks task done with mergedBranches', async () => {
    await handleClaimedTask(CONVERGING_TASK);

    expect(updateChatMock).toHaveBeenCalledWith(expect.anything(), 'chat-conv-1', {
      worktreePath: '/repos/.frink-worktrees/owners-web/brave-lion-aabbcc',
      branch: 'brave-lion-aabbcc',
      baseBranch: 'feat/ticket-2',
    });
    expect(updateTaskStatusMock).toHaveBeenCalledWith(expect.anything(), 'task-conv-1', 'done', {
      result: {
        configured: true,
        exitCode: 0,
        mergedBranches: ['feat/ticket-1'],
      },
    });
  });

  /**
   * BUG TEST (sc-612 edge case): The conflict result must use a VALID task status.
   * 'awaiting_input' is NOT in DbTask['status'] — the API rejects it.
   * Correct approach: 'needs_attention' + result.agentSignal.state = 'awaiting_input'
   * so signal-bridge's mapTaskSignalToNodeOutput maps it to awaiting_input node status.
   *
   * This test will FAIL with the bug (updateTaskStatus called with 'awaiting_input')
   * and PASS once fixed to use 'needs_attention' + agentSignal.
   */
  it('merge conflict: updateTaskStatus uses needs_attention (valid) with agentSignal awaiting_input, NOT the invalid awaiting_input status', async () => {
    createWorktreeWithMergedBasesMock.mockResolvedValue(CONFLICT_CONVERGING_WORKTREE);

    await handleClaimedTask(CONVERGING_TASK);

    // Must NOT call with the invalid status 'awaiting_input'
    expect(updateTaskStatusMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'task-conv-1',
      'awaiting_input',
      expect.anything(),
    );

    // Must use a valid task status
    const [, , calledStatus, calledOptions] = updateTaskStatusMock.mock.calls[0];
    expect(calledStatus).toBe('needs_attention');

    // Result must include agentSignal.state = 'awaiting_input' so signal-bridge
    // (mapTaskSignalToNodeOutput) maps this task completion to awaiting_input node status.
    const result = (calledOptions as { result: Record<string, unknown> }).result;
    expect(result.agentSignal).toBeDefined();
    expect((result.agentSignal as Record<string, unknown>).state).toBe('awaiting_input');

    // Conflict details preserved for UI
    expect(result.mergeConflict).toBe(true);
    expect(result.conflictingBranch).toBe('feat/ticket-1');
    expect(result.conflictedFiles).toEqual(['src/index.ts', 'src/utils.ts']);
  });

  it('merge conflict: updateChat still called before updateTaskStatus (ordering invariant)', async () => {
    createWorktreeWithMergedBasesMock.mockResolvedValue(CONFLICT_CONVERGING_WORKTREE);
    const callOrder: string[] = [];
    updateChatMock.mockImplementation(async () => {
      callOrder.push('updateChat');
      return { id: 'chat-conv-1' };
    });
    updateTaskStatusMock.mockImplementation(async () => {
      callOrder.push('updateTaskStatus');
      return { id: 'task-conv-1' };
    });

    await handleClaimedTask(CONVERGING_TASK);

    expect(callOrder.indexOf('updateChat')).toBeLessThan(callOrder.indexOf('updateTaskStatus'));
  });

  it('non-conflict error (branch not found): marks task failed', async () => {
    createWorktreeWithMergedBasesMock.mockResolvedValue({
      success: false,
      error: 'dependency_branch_not_found: Failed to fetch origin/feat/ticket-1',
    });

    await handleClaimedTask(CONVERGING_TASK);

    expect(updateTaskStatusMock).toHaveBeenCalledWith(expect.anything(), 'task-conv-1', 'failed', {
      result: { error: 'dependency_branch_not_found: Failed to fetch origin/feat/ticket-1' },
    });
    expect(updateChatMock).not.toHaveBeenCalled();
  });
});
