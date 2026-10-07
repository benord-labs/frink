import { beforeEach, describe, expect, it, vi } from 'vitest';

const reconcileFlowAdmission = vi.hoisted(() => vi.fn(async () => {}));
const providerPreflightMocks = vi.hoisted(() => ({
  getTaskById: vi.fn(),
  getFlowRun: vi.fn(),
  liveAdmissionForRun: vi.fn(),
  registerNodeAbort: vi.fn(),
  unregisterNodeAbort: vi.fn(),
}));
const conversionMocks = vi.hoisted(() => ({
  resolveTerminalResumeTarget: vi.fn(),
  resolveSessionResumeSeed: vi.fn(),
}));
const testDb = vi.hoisted(() => ({}));

vi.mock('../../flows/admission/terminal-resume/dispatcher', () => ({
  resolveTerminalResumeTarget: conversionMocks.resolveTerminalResumeTarget,
}));
vi.mock('../../flows/rerun/session-resume', () => ({
  resolveSessionResumeSeed: conversionMocks.resolveSessionResumeSeed,
}));

vi.mock('./claude-provider-cleanup', () => ({ disposeClaudeSessionAndWait: vi.fn() }));
vi.mock('../../db', () => ({ getDatabase: vi.fn(() => testDb) }));
vi.mock('../../db/repos/tasks', () => ({
  getTaskById: providerPreflightMocks.getTaskById,
}));
vi.mock('../../db/repos/flow-runs', () => ({ getFlowRun: providerPreflightMocks.getFlowRun }));
vi.mock('../../flows/admission/store', () => ({
  liveAdmissionForRun: providerPreflightMocks.liveAdmissionForRun,
}));
vi.mock('../../flows/cancel-registry', () => ({
  registerNodeAbort: providerPreflightMocks.registerNodeAbort,
  unregisterNodeAbort: providerPreflightMocks.unregisterNodeAbort,
}));

import {
  hasFlowResourceActivity,
  setFlowAdmissionLifecycleHooks,
} from '../../flows/admission/activity';
import { registerFlowProviderExecution, resolveFlowResourceRunId } from './flow-resource-cleanup';

beforeEach(() => {
  vi.clearAllMocks();
  setFlowAdmissionLifecycleHooks({
    reconcile: reconcileFlowAdmission,
    requestRelease: vi.fn(async () => {}),
  });
  providerPreflightMocks.getTaskById.mockResolvedValue({
    id: 'flow-task',
    source: 'flow',
    flowRunId: 'flow-run',
    status: 'running',
  });
  providerPreflightMocks.getFlowRun.mockResolvedValue({ id: 'flow-run', status: 'running' });
  providerPreflightMocks.liveAdmissionForRun.mockReturnValue({
    flowRunId: 'flow-run',
    state: 'active',
  });
});

describe('Flow provider execution preflight', () => {
  it('uses only live durable task or restart provenance', () => {
    const provenance = {
      prefetchedSignalTask: { flowRunId: 'run-task', source: 'flow' },
      taskSignalDisarmed: false,
      provenanceLookupError: null,
      restartInterruptedFlowRunId: null,
    };
    expect(resolveFlowResourceRunId(provenance)).toBe('run-task');
    expect(
      resolveFlowResourceRunId({
        ...provenance,
        prefetchedSignalTask: null,
        restartInterruptedFlowRunId: 'run-restart',
      }),
    ).toBe('run-restart');
    expect(resolveFlowResourceRunId({ ...provenance, prefetchedSignalTask: null })).toBeNull();
    expect(
      resolveFlowResourceRunId({
        ...provenance,
        prefetchedSignalTask: { flowRunId: 'run-task', source: 'chat' },
      }),
    ).toBeNull();
    expect(resolveFlowResourceRunId({ ...provenance, taskSignalDisarmed: true })).toBeNull();
  });

  it('registers an expected Flow provider before canonical cancellation preflight', async () => {
    const controller = new AbortController();
    const registration = await registerFlowProviderExecution({
      provenance: {
        prefetchedSignalTask: {
          id: 'flow-task',
          source: 'flow',
          flowRunId: 'flow-run',
          status: 'running',
        },
        taskSignalDisarmed: false,
        provenanceLookupError: null,
        restartInterruptedFlowRunId: null,
      },
      expectedFlowTaskId: 'flow-task',
      controller,
    });

    expect(providerPreflightMocks.registerNodeAbort).toHaveBeenCalledWith('flow-run', controller);
    expect(providerPreflightMocks.getTaskById).not.toHaveBeenCalled();
    await registration?.prepareAndValidate(async () => {});
    expect(providerPreflightMocks.registerNodeAbort.mock.invocationCallOrder[0]).toBeLessThan(
      providerPreflightMocks.getTaskById.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(providerPreflightMocks.getTaskById).toHaveBeenCalledOnce();
    expect(hasFlowResourceActivity('flow-run')).toBe(true);

    registration?.unregisterAbort();
    registration?.release();
    expect(providerPreflightMocks.unregisterNodeAbort).toHaveBeenCalledWith('flow-run', controller);
    await vi.waitFor(() => expect(hasFlowResourceActivity('flow-run')).toBe(false));
  });

  it('registers restart recovery before revival, then validates the revived task and run', async () => {
    let revived = false;
    providerPreflightMocks.getTaskById.mockImplementation(async () => ({
      id: 'flow-task',
      source: 'flow',
      flowRunId: 'flow-run',
      status: revived ? 'running' : 'cancelled',
    }));
    providerPreflightMocks.getFlowRun.mockImplementation(async () => ({
      id: 'flow-run',
      status: revived ? 'running' : 'cancelled',
    }));
    const prepareForExecution = vi.fn(async () => {
      expect(providerPreflightMocks.registerNodeAbort).toHaveBeenCalledOnce();
      revived = true;
    });

    const registration = await registerFlowProviderExecution({
      provenance: {
        prefetchedSignalTask: null,
        taskSignalDisarmed: false,
        provenanceLookupError: null,
        restartInterruptedFlowRunId: 'flow-run',
        effectiveSignalTaskId: 'flow-task',
      },
      controller: new AbortController(),
    });

    expect(prepareForExecution).not.toHaveBeenCalled();
    await registration?.prepareAndValidate(prepareForExecution);
    expect(prepareForExecution).toHaveBeenCalledOnce();
    expect(providerPreflightMocks.getTaskById).toHaveBeenCalledOnce();
    expect(providerPreflightMocks.getFlowRun).toHaveBeenCalledOnce();
    registration?.unregisterAbort();
    registration?.release();
    await vi.waitFor(() => expect(hasFlowResourceActivity('flow-run')).toBe(false));
  });

  it('never revives restart work after cancellation wins registration', async () => {
    const controller = new AbortController();
    providerPreflightMocks.registerNodeAbort.mockImplementationOnce(() => controller.abort());
    const prepareForExecution = vi.fn(async () => {});
    const registration = await registerFlowProviderExecution({
      provenance: {
        prefetchedSignalTask: null,
        taskSignalDisarmed: false,
        provenanceLookupError: null,
        restartInterruptedFlowRunId: 'flow-run',
        effectiveSignalTaskId: 'flow-task',
      },
      controller,
    });

    await expect(registration?.prepareAndValidate(prepareForExecution)).rejects.toThrow(
      'cancelled before provider preparation',
    );
    expect(prepareForExecution).not.toHaveBeenCalled();
    registration?.unregisterAbort();
    registration?.release();
  });

  it('moves cancellation ownership when the provider replaces its controller', async () => {
    const controller = new AbortController();
    const replacement = new AbortController();
    const registration = await registerFlowProviderExecution({
      provenance: {
        prefetchedSignalTask: {
          id: 'flow-task',
          source: 'flow',
          flowRunId: 'flow-run',
          status: 'running',
        },
        taskSignalDisarmed: false,
        provenanceLookupError: null,
        restartInterruptedFlowRunId: null,
      },
      expectedFlowTaskId: 'flow-task',
      controller,
    });

    registration?.rebindAbort(replacement);
    expect(providerPreflightMocks.registerNodeAbort).toHaveBeenLastCalledWith(
      'flow-run',
      replacement,
    );
    expect(providerPreflightMocks.unregisterNodeAbort).toHaveBeenCalledWith('flow-run', controller);

    registration?.unregisterAbort();
    expect(providerPreflightMocks.unregisterNodeAbort).toHaveBeenLastCalledWith(
      'flow-run',
      replacement,
    );
    registration?.release();
  });

  it('keeps a replacement controller cancelled once the old one was aborted', async () => {
    const controller = new AbortController();
    const replacement = new AbortController();
    const registration = await registerFlowProviderExecution({
      provenance: {
        prefetchedSignalTask: {
          id: 'flow-task',
          source: 'flow',
          flowRunId: 'flow-run',
          status: 'running',
        },
        taskSignalDisarmed: false,
        provenanceLookupError: null,
        restartInterruptedFlowRunId: null,
      },
      expectedFlowTaskId: 'flow-task',
      controller,
    });

    controller.abort();
    registration?.rebindAbort(replacement);

    expect(replacement.signal.aborted).toBe(true);
    registration?.unregisterAbort();
    registration?.release();
  });

  it('bypasses registration for canonically ordinary chat work', async () => {
    await expect(
      registerFlowProviderExecution({
        provenance: {
          prefetchedSignalTask: {
            id: 'chat-task',
            source: 'chat',
            flowRunId: null,
            status: 'running',
          },
          taskSignalDisarmed: false,
          provenanceLookupError: null,
          restartInterruptedFlowRunId: null,
        },
        controller: new AbortController(),
      }),
    ).resolves.toBeNull();
    expect(providerPreflightMocks.registerNodeAbort).not.toHaveBeenCalled();
  });

  it('bypasses registration when an accepted task id is durably ordinary chat work', async () => {
    await expect(
      registerFlowProviderExecution({
        provenance: {
          prefetchedSignalTask: {
            id: 'chat-task',
            source: 'chat',
            flowRunId: null,
            status: 'running',
          },
          taskSignalDisarmed: false,
          provenanceLookupError: null,
          restartInterruptedFlowRunId: null,
        },
        expectedFlowTaskId: 'chat-task',
        controller: new AbortController(),
      }),
    ).resolves.toBeNull();
    expect(providerPreflightMocks.getTaskById).not.toHaveBeenCalled();
    expect(providerPreflightMocks.registerNodeAbort).not.toHaveBeenCalled();
  });

  it('unwinds activity when cancellation wins after provider registration', async () => {
    const controller = new AbortController();
    providerPreflightMocks.getFlowRun.mockImplementationOnce(async () => {
      controller.abort();
      return { id: 'flow-run', status: 'cancelled' };
    });

    const registration = await registerFlowProviderExecution({
      provenance: {
        prefetchedSignalTask: {
          id: 'flow-task',
          source: 'flow',
          flowRunId: 'flow-run',
          status: 'running',
        },
        taskSignalDisarmed: false,
        provenanceLookupError: null,
        restartInterruptedFlowRunId: null,
      },
      expectedFlowTaskId: 'flow-task',
      controller,
    });
    await expect(registration?.prepareAndValidate(async () => {})).rejects.toThrow(
      'cancelled before provider preflight',
    );

    registration?.unregisterAbort();
    registration?.release();
    expect(providerPreflightMocks.unregisterNodeAbort).toHaveBeenCalledWith('flow-run', controller);
    await vi.waitFor(() => expect(hasFlowResourceActivity('flow-run')).toBe(false));
  });

  it('blocks a stale cancelled expected Flow task before provider work', async () => {
    providerPreflightMocks.getTaskById.mockResolvedValue({
      id: 'flow-task',
      source: 'flow',
      flowRunId: 'flow-run',
      status: 'cancelled',
    });

    const registration = await registerFlowProviderExecution({
      provenance: {
        prefetchedSignalTask: null,
        taskSignalDisarmed: true,
        provenanceLookupError: null,
        restartInterruptedFlowRunId: null,
      },
      expectedFlowTaskId: 'flow-task',
      controller: new AbortController(),
    });
    await expect(registration?.prepareAndValidate(async () => {})).rejects.toMatchObject({
      message: expect.stringContaining('no longer execution-eligible'),
      // Expected decline, not a defect: the stamped category rides the socket ErrorPayload so the
      // renderer classifies it (actionable toast, no transcript rollback, no doomed retry).
      category: 'FLOW_RUN_ENDED',
    });
    registration?.unregisterAbort();
    registration?.release();
    expect(providerPreflightMocks.unregisterNodeAbort).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(hasFlowResourceActivity('flow-run')).toBe(false));
  });
});

// Typed-reply decline-and-convert: a decline on a failed/cancelled run whose
// surviving session holds the resume target's turn converts into a recorded continuation
// re-admission (fired by the executor AFTER settle) and a FLOW_RUN_RESUMING category.
describe('typed-reply decline-and-convert', () => {
  const TERMINAL_PROVENANCE = {
    prefetchedSignalTask: {
      id: 'flow-task',
      source: 'flow',
      flowRunId: 'flow-run',
      status: 'cancelled',
    },
    taskSignalDisarmed: false,
    provenanceLookupError: null,
    restartInterruptedFlowRunId: null,
  };

  async function declineWith(chatId: string | undefined) {
    const registration = await registerFlowProviderExecution({
      provenance: TERMINAL_PROVENANCE,
      controller: new AbortController(),
      chatId,
    });
    const outcome = await registration
      ?.prepareAndValidate(async () => {})
      .then(() => null)
      .catch((error: Error & { category?: string }) => error);
    return { registration, outcome };
  }

  beforeEach(() => {
    providerPreflightMocks.getTaskById.mockResolvedValue({
      id: 'flow-task',
      source: 'flow',
      flowRunId: 'flow-run',
      status: 'cancelled',
    });
    providerPreflightMocks.getFlowRun.mockResolvedValue({ id: 'flow-run', status: 'failed' });
    providerPreflightMocks.liveAdmissionForRun.mockReturnValue(null);
    conversionMocks.resolveTerminalResumeTarget.mockResolvedValue({
      ctx: {},
      node: { id: 'work', blockType: 'agent' },
      nodeRunId: 'node-run-1',
      continues: true,
    });
    conversionMocks.resolveSessionResumeSeed.mockResolvedValue({
      config: { resumeSession: true, resumeSubChatId: 'sub-1' },
    });
  });

  it('records the continuation and declines as FLOW_RUN_RESUMING when the session gate passes', async () => {
    const { registration, outcome } = await declineWith('chat-1');
    expect(outcome?.category).toBe('FLOW_RUN_RESUMING');
    expect(registration?.takePendingContinuationResume()).toEqual({
      flowRunId: 'flow-run',
      nodeRunId: 'node-run-1',
    });
    // One-shot: the executor's post-settle fire consumes it exactly once.
    expect(registration?.takePendingContinuationResume()).toBeNull();
    registration?.unregisterAbort();
    registration?.release();
  });

  it('declines as FLOW_RUN_ENDED when the session gate fails, recording nothing', async () => {
    conversionMocks.resolveSessionResumeSeed.mockResolvedValue(null);
    const { registration, outcome } = await declineWith('chat-1');
    expect(outcome?.category).toBe('FLOW_RUN_ENDED');
    expect(registration?.takePendingContinuationResume()).toBeNull();
    registration?.unregisterAbort();
    registration?.release();
  });

  // The session answered an earlier attempt of the node, but not the step's own prompt.
  it('declines as FLOW_RUN_ENDED on a Retry step even when a seed exists', async () => {
    conversionMocks.resolveTerminalResumeTarget.mockResolvedValue({
      node: { id: 'work', blockType: 'agent' },
      nodeRunId: 'node-run-1',
      continues: false,
    });
    const { registration, outcome } = await declineWith('chat-1');
    expect(outcome?.category).toBe('FLOW_RUN_ENDED');
    expect(registration?.takePendingContinuationResume()).toBeNull();
    registration?.unregisterAbort();
    registration?.release();
  });

  it('never converts a COMPLETED run (shape-dependent anchor) — the gate is not even consulted', async () => {
    providerPreflightMocks.getFlowRun.mockResolvedValue({ id: 'flow-run', status: 'completed' });
    const { registration, outcome } = await declineWith('chat-1');
    expect(outcome?.category).toBe('FLOW_RUN_ENDED');
    expect(conversionMocks.resolveSessionResumeSeed).not.toHaveBeenCalled();
    expect(registration?.takePendingContinuationResume()).toBeNull();
    registration?.unregisterAbort();
    registration?.release();
  });

  it('never converts without a chatId (no gate input)', async () => {
    const { registration, outcome } = await declineWith(undefined);
    expect(outcome?.category).toBe('FLOW_RUN_ENDED');
    expect(conversionMocks.resolveTerminalResumeTarget).not.toHaveBeenCalled();
    registration?.unregisterAbort();
    registration?.release();
  });
});
