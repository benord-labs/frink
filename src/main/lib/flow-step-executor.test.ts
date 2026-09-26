/** Tests for flow-step-executor.ts — the local executor the flow engine calls per step. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getProjectByIdMock = vi.hoisted(() => vi.fn());
const runShellCommandMock = vi.hoisted(() => vi.fn());
const runCustomNodeProcessMock = vi.hoisted(() => vi.fn());
const discoverCustomNodesMock = vi.hoisted(() => vi.fn());
const resolveNodeCredentialEnvVarsMock = vi.hoisted(() => vi.fn());
const validateWorktreeForReuseMock = vi.hoisted(() => vi.fn());
const createWorktreeForBranchMock = vi.hoisted(() => vi.fn());
const createWorktreeWithMergedBasesMock = vi.hoisted(() => vi.fn());

vi.mock('./db', () => ({
  getDatabase: vi.fn(() => ({})),
}));

vi.mock('./db/repos/projects', () => ({
  getProjectById: getProjectByIdMock,
}));

vi.mock('./shell-executor', () => ({
  runShellCommand: runShellCommandMock,
  SHELL_TASK_MAX_BUFFER: 1_048_576,
}));

vi.mock('./custom-nodes/discovery', () => ({
  discoverCustomNodes: discoverCustomNodesMock,
  CUSTOM_NODES_DIR: '/home/.frink/nodes',
}));

vi.mock('./custom-nodes/credentials', () => ({
  resolveNodeCredentialEnvVars: resolveNodeCredentialEnvVarsMock,
}));

vi.mock('./custom-nodes/process-runner', () => ({
  runCustomNodeProcess: runCustomNodeProcessMock,
}));

vi.mock('./git/worktree-validation', () => ({
  validateWorktreeForReuse: validateWorktreeForReuseMock,
}));

vi.mock('./git/worktree', () => ({
  createWorktreeForBranch: createWorktreeForBranchMock,
}));

vi.mock('./git/worktree-converge', () => ({
  createWorktreeWithMergedBases: createWorktreeWithMergedBasesMock,
}));

import {
  beginCustomNodeInstall,
  waitForCustomNodeReaders,
} from './custom-nodes/installation-coordinator';
import type { FlowExecuteStepPayload, ParsedStepOutput } from './flow-step-executor';
import { executeFlowStepLocal } from './flow-step-executor';

const PROJECT = { id: 'p1', path: '/repo', machine_id: 'm1', name: 'test', git_remote: null };

function makeOkShellResult(stdout = '') {
  return { stdout, stderr: '', exitCode: 0, timedOut: false, spawnMessage: undefined };
}

type StepRecord = { nodeRunId: string } & ParsedStepOutput;
type RecordedEvent = [string, StepRecord];

/**
 * Drives one step the way the flow engine does: run it under an AbortSignal, record the result,
 * and let `cancel` abort an in-flight step the way cancel-registry does.
 */
function makeStepDriver() {
  const recorded: RecordedEvent[] = [];
  const inFlight = new Map<string, AbortController>();
  return {
    _trigger: async (
      event: string,
      payload: Partial<FlowExecuteStepPayload> & { nodeRunId: string },
    ) => {
      const { nodeRunId } = payload;
      if (event === 'cancel') {
        inFlight.get(nodeRunId)?.abort();
        return;
      }
      const abort = new AbortController();
      inFlight.set(nodeRunId, abort);
      try {
        // SAFETY: each test supplies the FlowExecuteStepPayload fields its block type reads.
        const parsed = await executeFlowStepLocal(payload as FlowExecuteStepPayload, abort.signal);
        recorded.push(['result', { nodeRunId, ...parsed }]);
      } finally {
        inFlight.delete(nodeRunId);
      }
    },
    _emitted: recorded,
  };
}

let _counter = 0;
function nid() {
  return `nr-exec-${++_counter}`;
}

describe('flow-step-executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProjectByIdMock.mockResolvedValue(PROJECT);
    runShellCommandMock.mockResolvedValue(makeOkShellResult('hello'));
    runCustomNodeProcessMock.mockResolvedValue({
      ...makeOkShellResult('hello'),
      cancelled: false,
    });
    validateWorktreeForReuseMock.mockResolvedValue({ valid: true });
    discoverCustomNodesMock.mockReturnValue({ valid: [], manifestWarnings: [], errors: [] });
    resolveNodeCredentialEnvVarsMock.mockReturnValue({ ok: true, envVars: {} });
    createWorktreeForBranchMock.mockResolvedValue({
      success: true,
      worktreePath: '/repo/worktrees/flow-test',
      branch: 'flow/feature-x',
      baseBranch: 'feature-x',
    });
  });

  it('executes start_task: creates worktree and emits structured outputs', async () => {
    const nodeRunId = nid();
    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId,
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'start_task',
      branch: 'feature-x',
      timeoutMs: 5000,
    });

    expect(createWorktreeForBranchMock).toHaveBeenCalledOnce();
    expect(createWorktreeForBranchMock.mock.calls[0][0]).toBe('/repo');
    expect(createWorktreeForBranchMock.mock.calls[0][1]).toBe('test');
    expect(createWorktreeForBranchMock.mock.calls[0][2]).toBe('feature-x');
    expect(runShellCommandMock).not.toHaveBeenCalled();

    const result = driver._emitted.find(([e]) => e === 'result');
    expect(result).toBeDefined();
    const p = result?.[1] as Record<string, unknown>;
    expect(p.nodeRunId).toBe(nodeRunId);
    expect(p.status).toBe('completed');
    const outputs = p.outputs as Record<string, unknown>;
    expect(outputs.worktreePath).toBe('/repo/worktrees/flow-test');
    expect(outputs.branch).toBe('flow/feature-x');
    expect(outputs.baseBranch).toBe('feature-x');
    expect(outputs.configured).toBe(true);
    expect(outputs.exitCode).toBe(0);
  });

  it('merges chatId, subChatId, and taskId from payload into start_task step outputs', async () => {
    const nodeRunId = nid();
    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId,
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'start_task',
      branch: 'feature-x',
      chatId: 'flow-chat-id',
      subChatId: 'flow-sub-id',
      taskId: 'flow-task-id',
      timeoutMs: 5000,
    });

    const result = driver._emitted.find(([e]) => e === 'result');
    expect(result).toBeDefined();
    const out = (result?.[1] as Record<string, unknown>).outputs as Record<string, unknown>;
    expect(out.chatId).toBe('flow-chat-id');
    expect(out.subChatId).toBe('flow-sub-id');
    expect(out.taskId).toBe('flow-task-id');
    expect(out.projectId).toBe('p1');
  });

  it('executes start_task without branch: passes undefined to createWorktreeForBranch (default base branch)', async () => {
    const nodeRunId = nid();
    createWorktreeForBranchMock.mockResolvedValueOnce({
      success: true,
      worktreePath: '/repo/worktrees/flow-default',
      branch: 'clever-fox-a1b2c3',
      baseBranch: 'main',
    });

    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId,
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'start_task',
      timeoutMs: 5000,
    });

    expect(createWorktreeForBranchMock).toHaveBeenCalledOnce();
    expect(createWorktreeForBranchMock.mock.calls[0][0]).toBe('/repo');
    expect(createWorktreeForBranchMock.mock.calls[0][1]).toBe('test');
    expect(createWorktreeForBranchMock.mock.calls[0][2]).toBeUndefined();

    const result = driver._emitted.find(([e]) => e === 'result');
    expect(result).toBeDefined();
    const p = result?.[1] as Record<string, unknown>;
    expect(p.status).toBe('completed');
    const outputs = p.outputs as Record<string, unknown>;
    expect(outputs.worktreePath).toBe('/repo/worktrees/flow-default');
    expect(outputs.branch).toBe('clever-fox-a1b2c3');
    expect(outputs.baseBranch).toBe('main');
  });

  it('emits failed flow:step-result when start_task worktree creation fails', async () => {
    createWorktreeForBranchMock.mockResolvedValueOnce({
      success: false,
      error: 'git worktree add failed',
    });

    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'start_task',
      branch: 'bad-branch',
      timeoutMs: 5000,
    });

    expect(runShellCommandMock).not.toHaveBeenCalled();
    const result = driver._emitted.find(([e]) => e === 'result');
    const p = result?.[1] as Record<string, unknown>;
    expect(p.status).toBe('failed');
    expect(String(p.error)).toContain('git worktree add failed');
  });

  // Worktree setup is interruptible, so a cancel surfaces as a setup FAILURE. Reporting that as
  // a plain failure would mark the step retryable and let a cancelled run re-run it.
  it('reports a cancelled start_task as cancelled, not as a retryable failure', async () => {
    const nodeRunId = nid();
    let release: (() => void) | undefined;
    createWorktreeForBranchMock.mockImplementationOnce(
      (_path: unknown, _slug: unknown, _branch: unknown, signal: AbortSignal) =>
        new Promise((resolve) => {
          release = () =>
            resolve(
              signal.aborted
                ? { success: false, error: 'Worktree setup failed: Cancelled before: bun install' }
                : { success: true, worktreePath: '/wt', branch: 'b', baseBranch: 'main' },
            );
        }),
    );

    const driver = makeStepDriver();
    const stepDone = driver._trigger('execute', {
      nodeRunId,
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'start_task',
      branch: 'feature-x',
      timeoutMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 10));

    await driver._trigger('cancel', { nodeRunId });
    release?.();
    await stepDone;

    const p = driver._emitted.find(([e]) => e === 'result')?.[1];
    expect(p?.status).toBe('cancelled');
  });

  it('executes run_command and emits flow:step-result', async () => {
    const nodeRunId = nid();
    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId,
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'run_command',
      command: 'echo test',
      workingDirectory: 'project_root',
      timeoutMs: 5000,
    });

    expect(runShellCommandMock).toHaveBeenCalledOnce();
    expect(runShellCommandMock.mock.calls[0][0]).toBe('echo test');
    expect(runShellCommandMock.mock.calls[0][1]).toBe('/repo');

    const result = driver._emitted.find(([e]) => e === 'result');
    expect(result).toBeDefined();
    const p = result?.[1] as Record<string, unknown>;
    expect(p.nodeRunId).toBe(nodeRunId);
    expect(p.status).toBe('completed');
  });

  it('emits error result when project not found', async () => {
    getProjectByIdMock.mockResolvedValue(null);

    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-1',
      projectId: 'p-missing',
      blockType: 'run_command',
      command: 'echo',
      workingDirectory: 'project_root',
      timeoutMs: 5000,
    });

    expect(runShellCommandMock).not.toHaveBeenCalled();
    const result = driver._emitted.find(([e]) => e === 'result');
    expect(result).toBeDefined();
    const p = result?.[1] as Record<string, unknown>;
    expect(p.status).toBe('failed');
    expect(typeof p.error).toBe('string');
  });

  it('cancels an in-flight step', async () => {
    const nodeRunId = nid();
    let capturedSignal: AbortSignal | undefined;
    runShellCommandMock.mockImplementation(
      (_cmd: unknown, _cwd: unknown, opts: { signal?: AbortSignal }) => {
        capturedSignal = opts.signal;
        return new Promise<never>(() => {});
      },
    );

    const driver = makeStepDriver();

    void driver._trigger('execute', {
      nodeRunId,
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'run_command',
      command: 'sleep',
      workingDirectory: 'project_root',
      timeoutMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    await driver._trigger('cancel', { nodeRunId });
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('uses trigger_worktree cwd when workingDirectory=trigger_worktree', async () => {
    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'run_command',
      command: 'echo',
      workingDirectory: 'trigger_worktree',
      triggerWorktreePath: '/repo/worktrees/branch-x',
      timeoutMs: 5000,
    });

    expect(runShellCommandMock.mock.calls[0][1]).toBe('/repo/worktrees/branch-x');
  });

  it('returns error when trigger_worktree path is invalid', async () => {
    validateWorktreeForReuseMock.mockResolvedValue({ valid: false, reason: 'no such dir' });

    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'run_command',
      command: 'echo',
      workingDirectory: 'trigger_worktree',
      triggerWorktreePath: '/bad/path',
      timeoutMs: 5000,
    });

    expect(runShellCommandMock).not.toHaveBeenCalled();
    const result = driver._emitted.find(([e]) => e === 'result');
    expect(result).toBeDefined();
    const p = result?.[1] as Record<string, unknown>;
  });

  it('names the upstream Start Task setting when trigger_worktree has no path', async () => {
    // Reachable now that a no-worktree start_task can legitimately complete; the message must
    // be actionable, not read like an internal assertion.
    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'run_command',
      command: 'echo',
      workingDirectory: 'trigger_worktree',
      timeoutMs: 5000,
    });

    const result = driver._emitted.find(([e]) => e === 'result');
    // SAFETY: flow:step-result's payload always carries an `error` field on a failed step.
    const p = result?.[1] as { error?: unknown };
    expect(String(p.error)).toContain('Start Task');
    expect(String(p.error)).toContain('Start in worktree');
  });

  it('includes spawnMessage in error when exitCode is null alongside stderr first line', async () => {
    runShellCommandMock.mockResolvedValue({
      stdout: '',
      stderr: 'existing stderr',
      exitCode: null,
      timedOut: false,
      spawnMessage: 'Output exceeded 1MB buffer limit',
    });

    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'run_command',
      command: 'echo',
      workingDirectory: 'project_root',
      timeoutMs: 5000,
    });

    const result = driver._emitted.find(([e]) => e === 'result');
    const p = result?.[1] as Record<string, unknown>;
    expect(p.error).toBe('existing stderr — Output exceeded 1MB buffer limit');
  });

  it('uses spawnMessage in error when stderr first line is empty', async () => {
    runShellCommandMock.mockResolvedValue({
      stdout: '',
      stderr: '\n',
      exitCode: null,
      timedOut: false,
      spawnMessage: 'spawn ENOENT',
    });

    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'run_command',
      command: 'missing-bin',
      workingDirectory: 'project_root',
      timeoutMs: 5000,
    });

    const result = driver._emitted.find(([e]) => e === 'result');
    const p = result?.[1] as Record<string, unknown>;
    expect(p.error).toBe('spawn ENOENT');
  });

  it('executes a listOptions value once without a runtime picker preflight (sc-535)', async () => {
    const manifest = {
      name: 'my-node',
      entrypoint: 'run.js',
      timeout: 30,
      nodePath: '/home/.frink/nodes/my-node',
      credentials: {},
      inputs: {
        repo: { type: 'string', listOptions: true },
        state: { type: 'string', default: 'open' },
        projectId: { type: 'string', default: 'must-not-leak' },
      },
    };
    discoverCustomNodesMock.mockReturnValue({
      valid: [manifest],
      manifestWarnings: [],
      errors: [],
    });

    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'my-node',
      workingDirectory: 'project_root',
      timeoutMs: 30000,
      config: {
        repo: 'template-or-fallback-value-not-from-picker',
        state: undefined,
        projectId: 'p1',
        undeclared: 'must-not-leak',
      },
    });

    expect(runShellCommandMock).not.toHaveBeenCalled();
    expect(runCustomNodeProcessMock).toHaveBeenCalledTimes(1);
    expect(runCustomNodeProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest,
        args: [
          JSON.stringify({ repo: 'template-or-fallback-value-not-from-picker', state: 'open' }),
        ],
        cwd: '/repo',
        timeoutMs: 30_000,
        maxBuffer: 1_048_576,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(
      runCustomNodeProcessMock.mock.calls.some(
        ([options]) => (options as { args: string[] }).args[0] === '--list-options',
      ),
    ).toBe(false);
  });

  it('executes a JavaScript custom node through the direct local-engine path', async () => {
    const manifest = {
      name: 'local-node',
      entrypoint: 'run.js',
      timeout: 30,
      nodePath: '/home/.frink/nodes/local-node',
      credentials: {},
      inputs: { repo: { type: 'string' } },
    };
    discoverCustomNodesMock.mockReturnValue({
      valid: [manifest],
      manifestWarnings: [],
      errors: [],
    });
    runCustomNodeProcessMock.mockResolvedValueOnce({
      stdout: '{"count":3}',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    });
    const controller = new AbortController();

    const result = await executeFlowStepLocal(
      {
        nodeRunId: nid(),
        flowRunId: 'fr-local',
        projectId: 'p1',
        blockType: 'local-node',
        workingDirectory: 'project_root',
        timeoutMs: 30_000,
        config: { repo: 'owner/repo', projectId: 'p1', undeclared: 'must-not-leak' },
      },
      controller.signal,
    );

    expect(result).toMatchObject({ status: 'completed', outputs: { count: 3 } });
    expect(runCustomNodeProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest,
        args: [JSON.stringify({ repo: 'owner/repo' })],
        signal: controller.signal,
      }),
    );
  });

  it('holds the node read lease through process completion before an install swap', async () => {
    const manifest = {
      name: 'leased-node',
      entrypoint: 'run.js',
      timeout: 30,
      nodePath: '/home/.frink/nodes/leased-node',
      credentials: {},
      inputs: {},
    };
    discoverCustomNodesMock.mockReturnValue({
      valid: [manifest],
      manifestWarnings: [],
      errors: [],
    });
    let finishProcess: ((result: ReturnType<typeof makeOkShellResult>) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    runCustomNodeProcessMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishProcess = resolve;
          markStarted?.();
        }),
    );

    const execution = executeFlowStepLocal(
      {
        nodeRunId: nid(),
        flowRunId: 'fr-local',
        projectId: 'p1',
        blockType: 'leased-node',
        workingDirectory: 'project_root',
        timeoutMs: 30_000,
        config: {},
      },
      new AbortController().signal,
    );
    await started;

    const releaseInstall = beginCustomNodeInstall('leased-node');
    expect(releaseInstall).not.toBeNull();
    let readersDrained = false;
    const draining = waitForCustomNodeReaders('leased-node', 1_000).then((drained) => {
      readersDrained = drained;
    });
    await Promise.resolve();
    expect(readersDrained).toBe(false);

    finishProcess?.(makeOkShellResult('{"done":true}'));
    await expect(execution).resolves.toMatchObject({ status: 'completed' });
    await draining;
    expect(readersDrained).toBe(true);
    releaseInstall?.();
  });

  it('surfaces a bundled Node.js start failure as the custom-node Flow error', async () => {
    const manifest = {
      name: 'javascript-node',
      entrypoint: 'run.js',
      timeout: 30,
      nodePath: '/home/.frink/nodes/javascript-node',
      credentials: {},
      inputs: {},
    };
    discoverCustomNodesMock.mockReturnValue({
      valid: [manifest],
      manifestWarnings: [],
      errors: [],
    });
    runCustomNodeProcessMock.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      cancelled: false,
      spawnMessage: `Frink's bundled Node.js could not start custom node "javascript-node": app is not ready`,
    });

    const result = await executeFlowStepLocal(
      {
        nodeRunId: nid(),
        flowRunId: 'fr-local',
        projectId: 'p1',
        blockType: 'javascript-node',
        workingDirectory: 'project_root',
        timeoutMs: 30_000,
        config: {},
      },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      status: 'failed',
      outputs: { exitCode: null },
      error: expect.stringContaining('bundled Node.js could not start'),
    });
  });

  it('fails the step naming the input when a rendered value cannot be its declared type', async () => {
    // The coercion call site sits outside executeCustomNode's own try/catch, so this asserts the
    // failure is returned as a step result rather than thrown past the executor.
    discoverCustomNodesMock.mockReturnValue({
      valid: [
        {
          name: 'weather-node',
          entrypoint: 'run.js',
          timeout: 30,
          nodePath: '/home/.frink/nodes/weather-node',
          credentials: {},
          inputs: { temperature: { type: 'number' } },
        },
      ],
      manifestWarnings: [],
      errors: [],
    });

    const result = await executeFlowStepLocal(
      {
        nodeRunId: nid(),
        flowRunId: 'fr-local',
        projectId: 'p1',
        blockType: 'weather-node',
        workingDirectory: 'project_root',
        timeoutMs: 30_000,
        // What an unresolvable {{previous.nope}} leaves behind after rendering.
        config: { temperature: '{{previous.nope}}' },
      },
      new AbortController().signal,
    );

    expect(result).toMatchObject({ status: 'failed' });
    expect(result.error).toContain('temperature');
    expect(result.error).toContain('weather-node');
    // The script must never be spawned with a config that failed its declared type.
    expect(runCustomNodeProcessMock).not.toHaveBeenCalled();
  });

  it('cancels a JavaScript custom node through the shared AbortSignal', async () => {
    const manifest = {
      name: 'javascript-node',
      entrypoint: 'run.js',
      timeout: 30,
      nodePath: '/home/.frink/nodes/javascript-node',
      credentials: {},
      inputs: {},
    };
    discoverCustomNodesMock.mockReturnValue({
      valid: [manifest],
      manifestWarnings: [],
      errors: [],
    });

    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    runCustomNodeProcessMock.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          notifyStarted?.();
          signal.addEventListener(
            'abort',
            () =>
              resolve({
                stdout: '',
                stderr: '',
                exitCode: null,
                timedOut: false,
                cancelled: true,
              }),
            { once: true },
          );
        }),
    );

    const nodeRunId = nid();
    const driver = makeStepDriver();
    const execution = driver._trigger('execute', {
      nodeRunId,
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'javascript-node',
      workingDirectory: 'project_root',
      timeoutMs: 30_000,
      config: {},
    });
    await started;
    await driver._trigger('cancel', { nodeRunId });
    await execution;

    const result = driver._emitted.find(([event]) => event === 'result');
    expect(result?.[1]).toMatchObject({ nodeRunId, status: 'cancelled' });
  });

  it('errors when custom node manifest not found', async () => {
    discoverCustomNodesMock.mockReturnValue({ valid: [], manifestWarnings: [], errors: [] });

    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'nonexistent-node',
      workingDirectory: 'project_root',
      timeoutMs: 5000,
      config: {},
    });

    expect(runShellCommandMock).not.toHaveBeenCalled();
    const result = driver._emitted.find(([e]) => e === 'result');
    expect(result).toBeDefined();
    const p = result?.[1] as Record<string, unknown>;
    expect(p.status).toBe('failed');
    expect(String(p.error)).toContain('not found');
  });

  // EC-5 extension: flow:cancel-step on unknown nodeRunId is silently ignored
  it('flow:cancel-step with unknown nodeRunId does not throw', async () => {
    const driver = makeStepDriver();

    await expect(
      driver._trigger('cancel', { nodeRunId: 'nr-not-running' }),
    ).resolves.not.toThrow();
    // No runShellCommand call, no flow:step-result emitted
    expect(runShellCommandMock).not.toHaveBeenCalled();
    expect(driver._emitted).toHaveLength(0);
  });

  // EC-5 extension: flow:cancel-step after the step has already completed is a no-op
  it('flow:cancel-step after step completes does not throw', async () => {
    const nodeRunId = nid();
    // Resolves immediately
    runShellCommandMock.mockResolvedValueOnce(makeOkShellResult('done'));

    const driver = makeStepDriver();

    // Execute and wait for it to complete
    await driver._trigger('execute', {
      nodeRunId,
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'run_command',
      command: 'echo done',
      workingDirectory: 'project_root',
      timeoutMs: 5000,
    });

    // nodeRunId is no longer in activeFlowSteps — cancel should be a no-op
    await expect(driver._trigger('cancel', { nodeRunId })).resolves.not.toThrow();
  });

  // workingDirectory: 'custom' uses the provided customPath
  it('uses customPath cwd when workingDirectory=custom', async () => {
    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'run_command',
      command: 'echo',
      workingDirectory: 'custom',
      customPath: '/custom/path',
      timeoutMs: 5000,
    });

    expect(runShellCommandMock.mock.calls[0][1]).toBe('/custom/path');
  });

  it('names the upstream Start Task setting when custom has no customPath', async () => {
    // Reachable the same way as the trigger_worktree case above: a customPath template like
    // {{previous.worktreePath}} renders to '' when the upstream start_task ran without a worktree.
    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'run_command',
      command: 'echo',
      workingDirectory: 'custom',
      customPath: '',
      timeoutMs: 5000,
    });

    expect(runShellCommandMock).not.toHaveBeenCalled();
    const result = driver._emitted.find(([e]) => e === 'result');
    // SAFETY: flow:step-result's payload always carries an `error` field on a failed step.
    const p = result?.[1] as { error?: unknown };
    expect(String(p.error)).toContain('Start Task');
    expect(String(p.error)).toContain('Start in worktree');
  });

  // Custom node with missing required credentials emits error result
  it('errors when custom node has missing required credentials', async () => {
    const manifest = {
      name: 'secure-node',
      entrypoint: 'run.js',
      timeout: 30,
      nodePath: '/home/.frink/nodes/secure-node',
      credentials: { apiKey: { required: true, envVar: 'API_KEY' } },
      inputs: {},
    };
    discoverCustomNodesMock.mockReturnValue({
      valid: [manifest],
      manifestWarnings: [],
      errors: [],
    });
    resolveNodeCredentialEnvVarsMock.mockReturnValue({
      ok: false,
      missing: ['apiKey'],
    });

    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'secure-node',
      workingDirectory: 'project_root',
      timeoutMs: 30000,
      config: {},
    });

    expect(runShellCommandMock).not.toHaveBeenCalled();
    const result = driver._emitted.find(([e]) => e === 'result');
    expect(result).toBeDefined();
    const p = result?.[1] as Record<string, unknown>;
    expect(p.status).toBe('failed');
    expect(String(p.error)).toContain('missing required credentials');
    expect(String(p.error)).toContain('apiKey');
  });

  // Timedout step (from runShellCommand) is reported with timedOut: true and cancelled: false
  it('reports timedOut:true and cancelled:false for a timed-out step', async () => {
    runShellCommandMock.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: true,
      spawnMessage: undefined,
    });

    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'run_command',
      command: 'sleep 999',
      workingDirectory: 'project_root',
      timeoutMs: 100,
    });

    const result = driver._emitted.find(([e]) => e === 'result');
    const p = result?.[1] as Record<string, unknown>;
  });

  // Output minimization: parseNodeOutput edge cases
  it('emits structured outputs when stdout is valid JSON object', async () => {
    runShellCommandMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ hasNewPRs: true, count: 3 }),
      stderr: '',
      exitCode: 0,
      timedOut: false,
      spawnMessage: undefined,
    });

    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'run_command',
      command: 'check-prs',
      workingDirectory: 'project_root',
      timeoutMs: 5000,
    });

    const result = driver._emitted.find(([e]) => e === 'result');
    const p = result?.[1] as Record<string, unknown>;
    expect(p.status).toBe('completed');
    const outputs = p.outputs as Record<string, unknown>;
    expect(outputs.hasNewPRs).toBe(true);
    expect(outputs.count).toBe(3);
    // Raw stdout NOT in payload
    expect(outputs.stdout).toBeUndefined();
  });

  it('emits _rawStdout fallback when stdout is non-JSON plain text', async () => {
    runShellCommandMock.mockResolvedValueOnce({
      stdout: 'plain text output',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      spawnMessage: undefined,
    });

    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'run_command',
      command: 'echo plain',
      workingDirectory: 'project_root',
      timeoutMs: 5000,
    });

    const result = driver._emitted.find(([e]) => e === 'result');
    const p = result?.[1] as Record<string, unknown>;
    expect(p.status).toBe('completed');
    const outputs = p.outputs as Record<string, unknown>;
    expect(outputs._rawStdout).toBe('plain text output');
  });

  it('truncates _rawStdout to 4096 bytes for huge non-JSON stdout', async () => {
    const huge = 'x'.repeat(10_000);
    runShellCommandMock.mockResolvedValueOnce({
      stdout: huge,
      stderr: '',
      exitCode: 0,
      timedOut: false,
      spawnMessage: undefined,
    });

    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'run_command',
      command: 'cat file',
      workingDirectory: 'project_root',
      timeoutMs: 5000,
    });

    const result = driver._emitted.find(([e]) => e === 'result');
    const p = result?.[1] as Record<string, unknown>;
    const outputs = p.outputs as Record<string, unknown>;
    expect(typeof outputs._rawStdout).toBe('string');
    expect((outputs._rawStdout as string).length).toBeLessThanOrEqual(4096);
  });

  it('emits empty outputs and short error on failed non-zero exit', async () => {
    runShellCommandMock.mockResolvedValueOnce({
      stdout: '',
      stderr: 'Error: something went wrong\nmore details here',
      exitCode: 1,
      timedOut: false,
      spawnMessage: undefined,
    });

    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-1',
      projectId: 'p1',
      blockType: 'run_command',
      command: 'fail-command',
      workingDirectory: 'project_root',
      timeoutMs: 5000,
    });

    const result = driver._emitted.find(([e]) => e === 'result');
    const p = result?.[1] as Record<string, unknown>;
    expect(p.status).toBe('failed');
    // error contains first line of stderr only, not the full dump
    expect(typeof p.error).toBe('string');
    expect(p.error).toBe('Error: something went wrong');
  });

  // sc-612: converging merge tests

  it('start_task empty baseBranches falls back to payload.branch (legacy single-branch path)', async () => {
    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-empty-bb',
      projectId: 'p1',
      blockType: 'start_task',
      baseBranches: [],
      branch: 'legacy-from-payload',
      timeoutMs: 5000,
    });

    expect(createWorktreeWithMergedBasesMock).not.toHaveBeenCalled();
    expect(createWorktreeForBranchMock).toHaveBeenCalledOnce();
    expect(createWorktreeForBranchMock.mock.calls[0][2]).toBe('legacy-from-payload');
  });

  it('start_task baseBranches with empty segment skips converging; falls back to payload.branch', async () => {
    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-bb-empty-seg',
      projectId: 'p1',
      blockType: 'start_task',
      baseBranches: ['', 'feat/ticket-1'],
      branch: 'legacy-from-payload',
      timeoutMs: 5000,
    });

    expect(createWorktreeWithMergedBasesMock).not.toHaveBeenCalled();
    expect(createWorktreeForBranchMock).toHaveBeenCalledOnce();
    expect(createWorktreeForBranchMock.mock.calls[0][2]).toBe('legacy-from-payload');
  });

  it('start_task sole baseBranches empty string falls back to payload.branch', async () => {
    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-bb-sole-empty',
      projectId: 'p1',
      blockType: 'start_task',
      baseBranches: [''],
      branch: 'fallback-branch',
      timeoutMs: 5000,
    });

    expect(createWorktreeForBranchMock).toHaveBeenCalledOnce();
    expect(createWorktreeForBranchMock.mock.calls[0][2]).toBe('fallback-branch');
  });

  it('start_task sole baseBranches whitespace-only falls back to payload.branch', async () => {
    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-bb-ws',
      projectId: 'p1',
      blockType: 'start_task',
      baseBranches: [' \t '],
      branch: 'fallback-branch',
      timeoutMs: 5000,
    });

    expect(createWorktreeForBranchMock).toHaveBeenCalledOnce();
    expect(createWorktreeForBranchMock.mock.calls[0][2]).toBe('fallback-branch');
  });

  it('start_task trims sole non-empty baseBranches segment', async () => {
    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-bb-trim',
      projectId: 'p1',
      blockType: 'start_task',
      baseBranches: ['  feat/trimmed  '],
      branch: 'fallback-branch',
      timeoutMs: 5000,
    });

    expect(createWorktreeForBranchMock).toHaveBeenCalledOnce();
    expect(createWorktreeForBranchMock.mock.calls[0][2]).toBe('feat/trimmed');
  });

  it('start_task with baseBranches (2+): calls createWorktreeWithMergedBases and emits completed', async () => {
    createWorktreeWithMergedBasesMock.mockResolvedValueOnce({
      success: true,
      worktreePath: '/repo/worktrees/conv-test',
      branch: 'brave-lion-d4e5f6',
      baseBranch: 'feat/ticket-2',
      mergedBranches: ['feat/ticket-1'],
    });

    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-conv',
      projectId: 'p1',
      blockType: 'start_task',
      baseBranches: ['  feat/ticket-2  ', 'feat/ticket-1'],
      mergeStrategy: 'most-recent',
      chatId: 'chat-conv',
      timeoutMs: 5000,
    });

    expect(createWorktreeWithMergedBasesMock).toHaveBeenCalledOnce();
    expect(createWorktreeWithMergedBasesMock.mock.calls[0][0]).toBe('/repo');
    expect(createWorktreeWithMergedBasesMock.mock.calls[0][1]).toBe('test');
    expect(createWorktreeWithMergedBasesMock.mock.calls[0][2]).toEqual([
      'feat/ticket-2',
      'feat/ticket-1',
    ]);
    expect(createWorktreeForBranchMock).not.toHaveBeenCalled();

    const result = driver._emitted.find(([e]) => e === 'result');
    const p = result?.[1] as Record<string, unknown>;
    expect(p.status).toBe('completed');
    const outputs = p.outputs as Record<string, unknown>;
    expect(outputs.worktreePath).toBe('/repo/worktrees/conv-test');
    expect(outputs.baseBranch).toBe('feat/ticket-2');
    expect(outputs.mergedBranches).toEqual(['feat/ticket-1']);
    expect(outputs.configured).toBe(true);
  });

  it('start_task with baseBranches: emits awaiting_input on merge conflict', async () => {
    createWorktreeWithMergedBasesMock.mockResolvedValueOnce({
      success: false,
      conflict: true,
      conflictingBranch: 'feat/ticket-1',
      conflictedFiles: ['src/index.ts', 'src/utils.ts'],
      mergedBranches: [],
      worktreePath: '/repo/worktrees/conflict-test',
      branch: 'bold-owl-aabbcc',
      baseBranch: 'feat/ticket-2',
    });

    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-conflict',
      projectId: 'p1',
      blockType: 'start_task',
      baseBranches: ['feat/ticket-2', 'feat/ticket-1'],
      mergeStrategy: 'most-recent',
      timeoutMs: 5000,
    });

    const result = driver._emitted.find(([e]) => e === 'result');
    const p = result?.[1] as Record<string, unknown>;
    expect(p.status).toBe('awaiting_input');
    const outputs = p.outputs as Record<string, unknown>;
    expect(outputs.mergeConflict).toBe(true);
    expect(outputs.conflictingBranch).toBe('feat/ticket-1');
    expect(outputs.conflictedFiles).toEqual(['src/index.ts', 'src/utils.ts']);
    expect(outputs.configured).toBe(false);
  });

  it('start_task with baseBranches=[single]: falls through to createWorktreeForBranch with that branch', async () => {
    createWorktreeForBranchMock.mockResolvedValueOnce({
      success: true,
      worktreePath: '/repo/worktrees/single-base',
      branch: 'lazy-cat-112233',
      baseBranch: 'feat/only-dep',
    });

    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-single',
      projectId: 'p1',
      blockType: 'start_task',
      baseBranches: ['feat/only-dep'],
      timeoutMs: 5000,
    });

    expect(createWorktreeWithMergedBasesMock).not.toHaveBeenCalled();
    expect(createWorktreeForBranchMock).toHaveBeenCalledOnce();
    expect(createWorktreeForBranchMock.mock.calls[0][2]).toBe('feat/only-dep');

    const result = driver._emitted.find(([e]) => e === 'result');
    const p = result?.[1] as Record<string, unknown>;
    expect(p.status).toBe('completed');
  });

  it('start_task with baseBranches=[non-string]: falls back to payload.branch for createWorktreeForBranch', async () => {
    createWorktreeForBranchMock.mockResolvedValueOnce({
      success: true,
      worktreePath: '/repo/wt',
      branch: 'b',
      baseBranch: 'fallback',
    });

    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-bad-base',
      projectId: 'p1',
      blockType: 'start_task',
      baseBranches: [123] as unknown as string[],
      branch: 'fallback',
      timeoutMs: 5000,
    });

    expect(createWorktreeForBranchMock).toHaveBeenCalledOnce();
    expect(createWorktreeForBranchMock.mock.calls[0][2]).toBe('fallback');
  });

  it('start_task with no baseBranches: falls through to existing single-branch path', async () => {
    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-legacy',
      projectId: 'p1',
      blockType: 'start_task',
      branch: 'legacy-branch',
      timeoutMs: 5000,
    });

    expect(createWorktreeWithMergedBasesMock).not.toHaveBeenCalled();
    expect(createWorktreeForBranchMock).toHaveBeenCalledOnce();
    expect(createWorktreeForBranchMock.mock.calls[0][2]).toBe('legacy-branch');
  });

  it('start_task converging merge failure (non-conflict error): emits failed', async () => {
    createWorktreeWithMergedBasesMock.mockResolvedValueOnce({
      success: false,
      error: 'dependency_branch_not_found: Failed to fetch origin/feat/ticket-1',
    });

    const driver = makeStepDriver();
    await driver._trigger('execute', {
      nodeRunId: nid(),
      flowRunId: 'fr-err',
      projectId: 'p1',
      blockType: 'start_task',
      baseBranches: ['feat/ticket-2', 'feat/ticket-1'],
      timeoutMs: 5000,
    });

    const result = driver._emitted.find(([e]) => e === 'result');
    const p = result?.[1] as Record<string, unknown>;
    expect(p.status).toBe('failed');
    expect(String(p.error)).toContain('dependency_branch_not_found');
  });
});
