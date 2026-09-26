import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskResultRecord } from './db/repos/tasks';
import type { Task as DbTask } from './db/schema';

/** Mirrors Node exec callback errors (code may be exit status or symbolic string). */
type MockExecError = Error & {
  code?: string | number;
  killed?: boolean;
  signal?: NodeJS.Signals;
};

type ExecCb = (error: Error | null, stdout?: string | string[], stderr?: string | string[]) => void;

const execMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    exec: (...args: unknown[]) => execMock(...args),
  };
});

const resolveNodeCredentialEnvVarsMock = vi.hoisted(() =>
  vi.fn().mockReturnValue({ ok: true as const, envVars: {} }),
);
vi.mock('./custom-nodes/credentials', () => ({
  resolveNodeCredentialEnvVars: (...args: unknown[]) => resolveNodeCredentialEnvVarsMock(...args),
}));

const discoverCustomNodesMock = vi.hoisted(() =>
  vi.fn().mockReturnValue({ valid: [], errors: [] }),
);
vi.mock('./custom-nodes/discovery', () => ({
  CUSTOM_NODES_DIR: '/mock/nodes',
  discoverCustomNodes: (...args: unknown[]) => discoverCustomNodesMock(...args),
}));

const getProjectByIdMock = vi.hoisted(() => vi.fn());
const updateTaskStatusMock = vi.hoisted(() => vi.fn());

vi.mock('./db', () => ({
  getDatabase: vi.fn(() => ({})),
}));

vi.mock('./db/repos/projects', () => ({
  getProjectById: (...args: unknown[]) => getProjectByIdMock(...args),
}));

vi.mock('./db/repos/tasks', () => ({
  parseResultRecord: (result: TaskResultRecord | null | undefined) => result ?? {},
  updateTaskStatus: (...args: unknown[]) => updateTaskStatusMock(...args),
}));

const validateWorktreeForReuseMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ valid: true as const }),
);

vi.mock('./git/worktree-validation', () => ({
  validateWorktreeForReuse: (...args: unknown[]) => validateWorktreeForReuseMock(...args),
}));

import {
  executeShellTask,
  isShellExecutionMode,
  resolveShellTaskCwd,
  resolveShellTaskTimeoutMs,
  runShellCommand,
  SHELL_TASK_TIMEOUT_MS,
} from './shell-executor';

function shellTask(overrides: Partial<DbTask> = {}): DbTask {
  return {
    id: 'task-shell-1',
    projectId: 'proj-1',
    title: null,
    description: 'echo hello',
    source: 'flow',
    sourceId: null,
    executionTarget: 'local',
    requiresFilesystem: true,
    status: 'running',
    result: null,
    triggerContext: {
      _config: { executionMode: 'shell', blockType: 'run_command' },
    } as unknown as DbTask['triggerContext'],
    flowRunId: null,
    nodeRunId: null,
    createdAt: new Date('2020-01-01T00:00:00.000Z'),
    startedAt: null,
    completedAt: null,
    executedBy: 'machine-1',
    ...overrides,
  };
}

describe('isShellExecutionMode', () => {
  it('is true when _config.executionMode is shell', () => {
    expect(isShellExecutionMode(shellTask().triggerContext)).toBe(true);
  });

  it('is false without shell mode', () => {
    expect(isShellExecutionMode(null)).toBe(false);
    expect(
      isShellExecutionMode({ _config: { model: 'x' } } as unknown as DbTask['triggerContext']),
    ).toBe(false);
  });
});

describe('resolveShellTaskCwd', () => {
  it('uses project path when no executionOverride cwd', async () => {
    const r = await resolveShellTaskCwd(shellTask(), '/repo/root');
    expect(r).toEqual({ ok: true, cwd: '/repo/root' });
  });

  it('uses customPath when set', async () => {
    const r = await resolveShellTaskCwd(
      shellTask({
        triggerContext: {
          _config: {
            executionMode: 'shell',
            executionOverride: { customPath: '/custom/dir' },
          },
        } as unknown as DbTask['triggerContext'],
      }),
      '/repo/root',
    );
    expect(r).toEqual({ ok: true, cwd: '/custom/dir' });
  });

  it('returns error when project path missing and no custom override', async () => {
    const r = await resolveShellTaskCwd(shellTask(), null);
    expect(r).toEqual({ ok: false, error: 'No project path resolved for shell task' });
  });

  it('returns error when reuse worktree validation fails', async () => {
    validateWorktreeForReuseMock.mockResolvedValueOnce({
      valid: false,
      reason: 'not a git worktree',
    });
    const r = await resolveShellTaskCwd(
      shellTask({
        triggerContext: {
          _config: {
            executionMode: 'shell',
            executionOverride: { reuseWorktree: true, worktreePath: '/stale/wt' },
          },
        } as unknown as DbTask['triggerContext'],
      }),
      '/repo',
    );
    expect(r).toEqual({
      ok: false,
      error: 'Cannot reuse trigger worktree: not a git worktree',
    });
  });
});

describe('runShellCommand', () => {
  it('returns exitCode 0 on success', async () => {
    execMock.mockImplementation((_cmd: string, _opts: object, cb: ExecCb) => {
      cb(null, 'out', '');
    });
    const r = await runShellCommand('echo hi', '/tmp', {
      timeoutMs: 1000,
      maxBuffer: 4096,
    });
    expect(r).toEqual({
      stdout: 'out',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });
  });

  it('returns non-zero exitCode when process fails', async () => {
    const err = new Error('failed') as MockExecError;
    err.code = 2;
    execMock.mockImplementation((_cmd: string, _opts: object, cb: ExecCb) => {
      cb(err, 'partial', 'errout');
    });
    const r = await runShellCommand('false', '/tmp', {
      timeoutMs: 1000,
      maxBuffer: 4096,
    });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe('partial');
    expect(r.stderr).toBe('errout');
    expect(r.timedOut).toBe(false);
  });

  it('detects timeout via SIGTERM kill', async () => {
    const err = new Error('killed') as MockExecError;
    err.killed = true;
    err.signal = 'SIGTERM';
    execMock.mockImplementation((_cmd: string, _opts: object, cb: ExecCb) => {
      cb(err, 'out', 'err');
    });
    const r = await runShellCommand('sleep 999', '/tmp', {
      timeoutMs: 1000,
      maxBuffer: 4096,
    });
    expect(r).toMatchObject({
      exitCode: null,
      timedOut: true,
      stdout: 'out',
      stderr: 'err',
    });
  });

  it('distinguishes maxBuffer kill from timeout (SIGTERM)', async () => {
    const err = new Error('stdout maxBuffer length exceeded') as MockExecError;
    err.killed = true;
    err.signal = 'SIGTERM';
    err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    execMock.mockImplementation((_cmd: string, _opts: object, cb: ExecCb) => {
      cb(err, 'big', '');
    });
    const r = await runShellCommand('x', '/tmp', {
      timeoutMs: 1000,
      maxBuffer: 100,
    });
    expect(r.timedOut).toBe(false);
    expect(r.spawnMessage).toBe('Output exceeded 1MB buffer limit');
    expect(r.exitCode).toBeNull();
  });

  it('treats SIGTERM + maxBuffer in message as buffer exceeded when code is missing', async () => {
    const err = new Error('something maxBuffer exceeded') as MockExecError;
    err.killed = true;
    err.signal = 'SIGTERM';
    execMock.mockImplementation((_cmd: string, _opts: object, cb: ExecCb) => {
      cb(err, 'out', '');
    });
    const r = await runShellCommand('x', '/tmp', { timeoutMs: 1000, maxBuffer: 100 });
    expect(r.timedOut).toBe(false);
    expect(r.spawnMessage).toBe('Output exceeded 1MB buffer limit');
  });

  // AbortSignal: aborting the controller kills the child process
  it('kills the child process when AbortSignal is aborted', async () => {
    const killSpy = vi.fn();
    const closeListeners: Array<() => void> = [];

    const mockChild = {
      kill: killSpy,
      once: (event: string, cb: () => void) => {
        if (event === 'close') closeListeners.push(cb);
      },
    };

    const err = new Error('killed') as MockExecError;
    err.killed = true;
    err.signal = 'SIGTERM';

    execMock.mockImplementation((_cmd: string, _opts: object, cb: ExecCb) => {
      // Simulate the SIGTERM kill response when kill() is called
      killSpy.mockImplementation(() => {
        // After kill is called, fire the exec callback as if the process was killed
        cb(err, '', '');
        // Notify close listeners
        for (const l of closeListeners) l();
      });
      return mockChild;
    });

    const controller = new AbortController();
    const resultPromise = runShellCommand('sleep 999', '/tmp', {
      timeoutMs: 30_000,
      maxBuffer: 4096,
      signal: controller.signal,
    });

    controller.abort();
    const r = await resultPromise;

    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    // timedOut is true here because the mock produces a SIGTERM kill — the caller
    // distinguishes cancel vs timeout by checking signal.aborted (as in flow-step-executor)
    expect(r.exitCode).toBeNull();
  });

  it('kills immediately when AbortSignal is already aborted (skips addEventListener / close cleanup)', async () => {
    const killSpy = vi.fn();
    const onceSpy = vi.fn();
    const mockChild = {
      kill: killSpy,
      once: onceSpy,
    };

    const err = new Error('killed') as MockExecError;
    err.killed = true;
    err.signal = 'SIGTERM';

    execMock.mockImplementation((_cmd: string, _opts: object, cb: ExecCb) => {
      killSpy.mockImplementation(() => {
        cb(err, '', '');
      });
      return mockChild;
    });

    const r = await runShellCommand('sleep 999', '/tmp', {
      timeoutMs: 30_000,
      maxBuffer: 4096,
      signal: AbortSignal.abort(),
    });

    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(onceSpy).not.toHaveBeenCalled();
    expect(r.exitCode).toBeNull();
  });

  // AbortSignal: aborting after process exits normally does not call kill (listener cleaned up)
  it('does not kill a process that already exited when signal is later aborted', async () => {
    const killSpy = vi.fn();
    const closeListeners: Array<() => void> = [];

    const mockChild = {
      kill: killSpy,
      once: (event: string, cb: () => void) => {
        if (event === 'close') closeListeners.push(cb);
      },
    };

    execMock.mockImplementation((_cmd: string, _opts: object, cb: ExecCb) => {
      // Defer callback to a microtask so child.once('close', cleanup) is registered first.
      // If we called cb() synchronously here, closeListeners would be empty (not yet registered).
      void Promise.resolve().then(() => {
        cb(null, 'done', '');
        for (const l of closeListeners) l();
      });
      return mockChild;
    });

    const controller = new AbortController();
    await runShellCommand('echo done', '/tmp', {
      timeoutMs: 1000,
      maxBuffer: 4096,
      signal: controller.signal,
    });

    // Abort after completion — kill should NOT be called (listener was removed by cleanup)
    controller.abort();
    expect(killSpy).not.toHaveBeenCalled();
  });
});

describe('executeShellTask', () => {
  beforeEach(() => {
    execMock.mockReset();
    getProjectByIdMock.mockReset();
    updateTaskStatusMock.mockReset();
    validateWorktreeForReuseMock.mockReset();
    validateWorktreeForReuseMock.mockResolvedValue({ valid: true });
    getProjectByIdMock.mockResolvedValue({ path: '/repo', id: 'proj-1', name: 'p' });
    updateTaskStatusMock.mockResolvedValue(null);
  });

  it('throws when not shell execution mode', async () => {
    await expect(executeShellTask(shellTask({ triggerContext: null }))).rejects.toThrow(
      /executionMode shell/,
    );
  });

  it('marks failed when command is empty', async () => {
    await executeShellTask(shellTask({ description: '   ' }));
    expect(updateTaskStatusMock).toHaveBeenCalledTimes(1);
    expect(updateTaskStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      'task-shell-1',
      'failed',
      expect.objectContaining({
        result: expect.objectContaining({ error: 'Empty command' }),
      }),
    );
  });

  it('marks failed when project_id missing', async () => {
    await executeShellTask(shellTask({ projectId: null }));
    expect(updateTaskStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      'task-shell-1',
      'failed',
      expect.objectContaining({
        result: expect.objectContaining({ error: 'Shell task missing project_id' }),
      }),
    );
  });

  it('completes with stdout/stderr/exitCode on success', async () => {
    execMock.mockImplementation((_cmd: string, _opts: object, cb: ExecCb) => {
      cb(null, '{"ok":true}\n', '');
    });
    await executeShellTask(shellTask({ description: 'node -e "console.log(1)"' }));
    expect(updateTaskStatusMock).toHaveBeenCalledTimes(2);
    expect(updateTaskStatusMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'task-shell-1',
      'running',
      expect.objectContaining({
        result: expect.objectContaining({
          shellExecution: true,
          executionLeaseId: expect.any(String),
        }),
        executedBy: 'machine-1',
      }),
    );
    expect(updateTaskStatusMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'task-shell-1',
      'completed',
      expect.objectContaining({
        result: {
          stdout: '{"ok":true}\n',
          stderr: '',
          exitCode: 0,
        },
        executedBy: 'machine-1',
      }),
    );
  });

  it('marks failed on non-zero exit', async () => {
    const err = new Error('nz') as MockExecError;
    err.code = 1;
    execMock.mockImplementation((_cmd: string, _opts: object, cb: ExecCb) => {
      cb(err, '', 'oops');
    });
    await executeShellTask(shellTask());
    expect(updateTaskStatusMock).toHaveBeenCalledTimes(2);
    expect(updateTaskStatusMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'task-shell-1',
      'failed',
      {
        result: expect.objectContaining({
          exitCode: 1,
          stderr: 'oops',
        }),
        executedBy: 'machine-1',
      },
    );
  });

  it('marks failed on timeout', async () => {
    const err = new Error('killed') as MockExecError;
    err.killed = true;
    err.signal = 'SIGTERM';
    execMock.mockImplementation((_cmd: string, _opts: object, cb: ExecCb) => {
      cb(err, 'partial', '');
    });
    await executeShellTask(shellTask());
    expect(updateTaskStatusMock).toHaveBeenCalledTimes(2);
    expect(updateTaskStatusMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'task-shell-1',
      'failed',
      {
        result: expect.objectContaining({
          error: 'Command timed out',
          exitCode: null,
        }),
        executedBy: 'machine-1',
      },
    );
  });

  it('marks failed with buffer message when maxBuffer exceeded', async () => {
    const err = new Error('maxBuffer') as MockExecError;
    err.killed = true;
    err.signal = 'SIGTERM';
    err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    execMock.mockImplementation((_cmd: string, _opts: object, cb: ExecCb) => {
      cb(err, 'x', '');
    });
    await executeShellTask(shellTask());
    expect(updateTaskStatusMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'task-shell-1',
      'failed',
      {
        result: expect.objectContaining({
          error: 'Output exceeded 1MB buffer limit',
          exitCode: null,
        }),
        executedBy: 'machine-1',
      },
    );
  });

  it('marks failed when getCloudProjectById throws', async () => {
    getProjectByIdMock.mockRejectedValueOnce(new Error('network down'));
    execMock.mockImplementation((_cmd: string, _opts: object, cb: ExecCb) => {
      cb(null, '', '');
    });
    await executeShellTask(shellTask());
    expect(updateTaskStatusMock).toHaveBeenCalledTimes(1);
    expect(updateTaskStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      'task-shell-1',
      'failed',
      expect.objectContaining({
        result: expect.objectContaining({ error: 'network down' }),
      }),
    );
  });

  it('uses customNodeTimeout from trigger context as exec timeout (seconds → ms)', async () => {
    let capturedTimeout: number | undefined;
    execMock.mockImplementation((_cmd: string, opts: { timeout?: number }, cb: ExecCb) => {
      capturedTimeout = opts.timeout;
      cb(null, '{}', '');
    });
    getProjectByIdMock.mockResolvedValue({ id: 'proj-1', path: '/repo' });
    await executeShellTask(
      shellTask({
        triggerContext: {
          _config: { executionMode: 'shell', blockType: 'my-node', customNodeTimeout: 90 },
        } as unknown as DbTask['triggerContext'],
      }),
    );
    expect(capturedTimeout).toBe(90_000);
  });

  it('falls back to SHELL_TASK_TIMEOUT_MS when no customNodeTimeout', async () => {
    let capturedTimeout: number | undefined;
    execMock.mockImplementation((_cmd: string, opts: { timeout?: number }, cb: ExecCb) => {
      capturedTimeout = opts.timeout;
      cb(null, '{}', '');
    });
    getProjectByIdMock.mockResolvedValue({ id: 'proj-1', path: '/repo' });
    await executeShellTask(shellTask());
    expect(capturedTimeout).toBe(SHELL_TASK_TIMEOUT_MS);
  });

  it('merges prior task.result into running PATCH (lease + prior keys)', async () => {
    execMock.mockImplementation((_cmd: string, _opts: object, cb: ExecCb) => {
      cb(null, 'ok', '');
    });
    await executeShellTask(
      shellTask({
        result: { chatId: 'chat-prev', subChatId: 'sub-prev' },
      }),
    );
    expect(updateTaskStatusMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'task-shell-1',
      'running',
      expect.objectContaining({
        result: expect.objectContaining({
          chatId: 'chat-prev',
          subChatId: 'sub-prev',
          shellExecution: true,
          executionLeaseId: expect.any(String),
        }),
      }),
    );
  });
});

describe('resolveShellTaskTimeoutMs', () => {
  function makeCtx(customNodeTimeout?: unknown): DbTask['triggerContext'] {
    return {
      _config: {
        executionMode: 'shell',
        ...(customNodeTimeout !== undefined ? { customNodeTimeout } : {}),
      },
    } as unknown as DbTask['triggerContext'];
  }

  it('returns SHELL_TASK_TIMEOUT_MS when customNodeTimeout is absent', () => {
    expect(resolveShellTaskTimeoutMs(makeCtx())).toBe(SHELL_TASK_TIMEOUT_MS);
  });

  it('converts seconds to ms for a valid customNodeTimeout', () => {
    expect(resolveShellTaskTimeoutMs(makeCtx(90))).toBe(90_000);
  });

  it('caps at 30 minutes (1800 seconds)', () => {
    expect(resolveShellTaskTimeoutMs(makeCtx(9999))).toBe(30 * 60 * 1000);
  });

  it('returns SHELL_TASK_TIMEOUT_MS when customNodeTimeout is 0', () => {
    expect(resolveShellTaskTimeoutMs(makeCtx(0))).toBe(SHELL_TASK_TIMEOUT_MS);
  });

  it('returns SHELL_TASK_TIMEOUT_MS when customNodeTimeout is negative', () => {
    expect(resolveShellTaskTimeoutMs(makeCtx(-30))).toBe(SHELL_TASK_TIMEOUT_MS);
  });

  it('returns SHELL_TASK_TIMEOUT_MS when customNodeTimeout is NaN', () => {
    expect(resolveShellTaskTimeoutMs(makeCtx(NaN))).toBe(SHELL_TASK_TIMEOUT_MS);
  });

  it('returns SHELL_TASK_TIMEOUT_MS when customNodeTimeout is a string', () => {
    expect(resolveShellTaskTimeoutMs(makeCtx('90'))).toBe(SHELL_TASK_TIMEOUT_MS);
  });

  it('returns SHELL_TASK_TIMEOUT_MS when trigger_context is null', () => {
    expect(resolveShellTaskTimeoutMs(null)).toBe(SHELL_TASK_TIMEOUT_MS);
  });
});
