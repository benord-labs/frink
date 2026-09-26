import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acquireExecutorRuntimeSlot: vi.fn(),
  disposeCodexAppServerSessionAndWait: vi.fn(async () => {}),
  endClaudeSession: vi.fn(),
  getClaudeSession: vi.fn(),
  hasWakeHold: vi.fn(),
  registerFlowProviderExecution: vi.fn(),
}));

vi.mock('../../agent-runner/codex/app-server-registry', () => ({
  disposeCodexAppServerSessionAndWait: mocks.disposeCodexAppServerSessionAndWait,
}));
vi.mock('../claude-session-registry', () => ({
  endSession: mocks.endClaudeSession,
  getSession: mocks.getClaudeSession,
}));
vi.mock('../claude-wake-hold', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude-wake-hold')>()),
  hasWakeHold: mocks.hasWakeHold,
  releaseWakeHold: vi.fn(),
}));
vi.mock('./wake-hold-registry-view', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./wake-hold-registry-view')>()),
  hasReusableWakeHoldRuntimeSlot: vi.fn(() => false),
}));
vi.mock('./flow-resource-cleanup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./flow-resource-cleanup')>();
  return {
    ...actual,
    acquireExecutorRuntimeSlot: mocks.acquireExecutorRuntimeSlot,
    registerFlowProviderExecution: mocks.registerFlowProviderExecution,
  };
});

import { FlowExecutorResourceScope } from './flow-executor-resource-scope';
import type { FlowProviderExecutionInput } from './flow-resource-cleanup';

type Settlement = Parameters<FlowExecutorResourceScope['settle']>[0];

const flowInput = (): FlowProviderExecutionInput => ({
  provenance: {
    prefetchedSignalTask: {
      id: 'flow-task',
      flowRunId: 'flow-run',
      source: 'flow',
      status: 'running',
    },
    provenanceLookupError: null,
    restartInterruptedFlowRunId: null,
    taskSignalDisarmed: false,
  },
  controller: new AbortController(),
});

const settlement = (overrides: Partial<Settlement> = {}): Settlement => {
  const executionController = overrides.executionController ?? new AbortController();
  return {
    subChatId: 'flow-chat',
    resourcesTransferredToWakeHold: false,
    session: null,
    executionContextId: undefined,
    clearExecutionContext: vi.fn(),
    executionController,
    getActiveController: () => executionController,
    deleteAbortSource: vi.fn(),
    clearPendingApprovals: vi.fn(),
    finalizeLinkedTaskSignal: vi.fn(async () => {}),
    deleteActiveExecution: vi.fn(),
    chatId: undefined,
    flowContinuationClearId: null,
    clearFlowContinuation: vi.fn(),
    ...overrides,
  };
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const prepareForExecution = vi.fn(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.registerFlowProviderExecution.mockResolvedValue(null);
  mocks.hasWakeHold.mockReturnValue(false);
  mocks.getClaudeSession.mockReturnValue(undefined);
});

describe('FlowExecutorResourceScope', () => {
  it('records admitted registration and rebinds cancellation ownership', async () => {
    const release = vi.fn();
    const rebindAbort = vi.fn();
    const prepareAndValidate = vi.fn(async (prepare: () => Promise<void>) => prepare());
    mocks.registerFlowProviderExecution.mockResolvedValue({
      release,
      rebindAbort,
      unregisterAbort: vi.fn(),
      prepareAndValidate,
    });
    const scope = new FlowExecutorResourceScope();
    const input = flowInput();

    expect(scope.admitted).toBe(false);
    await scope.admit(input.provenance, 'flow-task', input.controller);
    expect(mocks.registerFlowProviderExecution).toHaveBeenCalledWith({
      provenance: input.provenance,
      expectedFlowTaskId: 'flow-task',
      controller: input.controller,
    });
    expect(scope.admitted).toBe(true);
    await scope.prepareProviderExecution(prepareForExecution);
    expect(prepareAndValidate).toHaveBeenCalledWith(prepareForExecution);

    const replacement = new AbortController();
    scope.rebindAbort(replacement);
    expect(rebindAbort).toHaveBeenCalledWith(replacement);
  });

  it('retains every provider settlement before releasing gated resources', async () => {
    const release = vi.fn();
    const unregisterAbort = vi.fn();
    const runtimeRelease = vi.fn();
    mocks.registerFlowProviderExecution.mockResolvedValue({
      release,
      rebindAbort: vi.fn(),
      unregisterAbort,
      prepareAndValidate: vi.fn(),
    });
    const scope = new FlowExecutorResourceScope();
    const input = flowInput();
    await scope.admit(input.provenance, 'flow-task', input.controller);
    await scope.ensureRuntimeSlot(async () => runtimeRelease);

    const first = deferred();
    const second = deferred();
    scope.onProcessSettled(first.promise);
    scope.onProcessSettled(second.promise);
    const params = settlement();
    const settling = scope.settle(params);

    await Promise.resolve();
    expect(params.finalizeLinkedTaskSignal).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();

    first.resolve();
    await Promise.resolve();
    expect(params.finalizeLinkedTaskSignal).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();

    second.resolve();
    await settling;
    expect(params.finalizeLinkedTaskSignal).toHaveBeenCalledOnce();
    expect(runtimeRelease).toHaveBeenCalledOnce();
    expect(unregisterAbort).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(undefined);
    expect(scope.admitted).toBe(false);
  });

  it('keeps foreground ownership until wake-hold arming succeeds', async () => {
    const release = vi.fn();
    const rebindAbort = vi.fn();
    const unregisterAbort = vi.fn();
    const runtimeRelease = vi.fn();
    mocks.registerFlowProviderExecution.mockResolvedValue({
      release,
      rebindAbort,
      unregisterAbort,
      prepareAndValidate: vi.fn(),
    });
    const scope = new FlowExecutorResourceScope();
    const input = flowInput();
    await scope.admit(input.provenance, 'flow-task', input.controller);
    await scope.ensureRuntimeSlot(async () => runtimeRelease);

    const armError = new Error('hold publication failed');
    expect(() =>
      scope.armWakeHold(() => {
        expect(scope.admitted).toBe(true);
        throw armError;
      }),
    ).toThrow(armError);
    expect(scope.admitted).toBe(true);
    expect(scope.hasArmedWakeHold).toBe(false);

    const replacement = new AbortController();
    scope.rebindAbort(replacement);
    expect(rebindAbort).toHaveBeenCalledWith(replacement);

    let finishWakeSettlement: ((error?: unknown) => void) | undefined;
    expect(
      scope.armWakeHold((resources) => {
        expect(scope.admitted).toBe(true);
        expect(resources).toEqual(
          expect.objectContaining({
            releaseFlowResourceActivity: release,
            releaseRuntimeSlot: runtimeRelease,
            unregisterFlowRunAbort: unregisterAbort,
            executionSettlement: expect.any(Object),
          }),
        );
        finishWakeSettlement = resources.executionSettlement.retain().finish;
        return 'armed';
      }),
    ).toBe('armed');
    expect(scope.admitted).toBe(false);
    expect(scope.hasArmedWakeHold).toBe(true);

    let fullySettled = false;
    void scope.waitUntilSettled().then(() => {
      fullySettled = true;
    });
    await scope.settle(settlement({ resourcesTransferredToWakeHold: true }));
    await Promise.resolve();
    expect(fullySettled).toBe(false);
    finishWakeSettlement?.();
    await scope.waitUntilSettled();
    expect(fullySettled).toBe(true);
  });

  it('performs legacy settlement and releases its runtime slot', async () => {
    const order: string[] = [];
    const session = { subChatId: 'legacy-chat' } as never;
    const runtimeRelease = vi.fn(() => order.push('runtime'));
    mocks.getClaudeSession.mockReturnValue(session);
    mocks.endClaudeSession.mockImplementation(() => order.push('session'));
    const scope = new FlowExecutorResourceScope();
    await scope.ensureRuntimeSlot(async () => runtimeRelease);

    await scope.settle(
      settlement({
        subChatId: 'legacy-chat',
        session,
        executionContextId: 'ctx-legacy',
        clearExecutionContext: () => order.push('mcp'),
        chatId: 'chat',
        flowContinuationClearId: 'task',
        clearFlowContinuation: () => order.push('continuation'),
        clearPendingApprovals: () => order.push('approvals'),
        deleteAbortSource: () => order.push('abort'),
        finalizeLinkedTaskSignal: async () => {
          order.push('signal');
        },
        deleteActiveExecution: () => order.push('active'),
      }),
    );

    expect(order).toEqual([
      'approvals',
      'abort',
      'signal',
      'session',
      'mcp',
      'continuation',
      'active',
      'runtime',
    ]);
    expect(runtimeRelease).toHaveBeenCalledOnce();
  });

  it('preserves keyed legacy state owned by a replacement execution', async () => {
    const owner = new AbortController();
    const replacement = new AbortController();
    const clearPendingApprovals = vi.fn();
    const deleteAbortSource = vi.fn();
    const deleteActiveExecution = vi.fn();
    const finalizeLinkedTaskSignal = vi.fn(async () => {});
    const scope = new FlowExecutorResourceScope();

    await scope.settle(
      settlement({
        executionController: owner,
        getActiveController: () => replacement,
        clearPendingApprovals,
        deleteAbortSource,
        deleteActiveExecution,
        finalizeLinkedTaskSignal,
      }),
    );

    expect(clearPendingApprovals).not.toHaveBeenCalled();
    expect(deleteAbortSource).not.toHaveBeenCalled();
    expect(deleteActiveExecution).not.toHaveBeenCalled();
    expect(finalizeLinkedTaskSignal).toHaveBeenCalledOnce();
  });

  it('binds Codex disposal synchronously to abort and supports unbinding', () => {
    const scope = new FlowExecutorResourceScope();
    const controller = new AbortController();
    scope.bindCodex(controller, '/repo', 'credential', 'sub-chat');

    controller.abort();
    expect(mocks.disposeCodexAppServerSessionAndWait).toHaveBeenCalledWith(
      '/repo',
      'credential',
      'sub-chat',
    );

    const detached = new AbortController();
    const unbind = scope.bindCodex(detached, '/repo', 'credential', 'detached');
    unbind();
    detached.abort();
    expect(mocks.disposeCodexAppServerSessionAndWait).not.toHaveBeenCalledWith(
      '/repo',
      'credential',
      'detached',
    );

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    scope.bindCodex(alreadyAborted, '/repo', 'credential', 'already-aborted');
    expect(mocks.disposeCodexAppServerSessionAndWait).toHaveBeenCalledWith(
      '/repo',
      'credential',
      'already-aborted',
    );
  });

  it('retains admitted resources until an aborted Codex child closes', async () => {
    const release = vi.fn();
    mocks.registerFlowProviderExecution.mockResolvedValue({
      release,
      rebindAbort: vi.fn(),
      unregisterAbort: vi.fn(),
      prepareAndValidate: vi.fn(),
    });
    const child = deferred();
    mocks.disposeCodexAppServerSessionAndWait.mockReturnValueOnce(child.promise);
    const scope = new FlowExecutorResourceScope();
    const input = flowInput();
    await scope.admit(input.provenance, 'flow-task', input.controller);
    scope.bindCodex(input.controller, '/repo', 'credential', 'sub-chat');

    input.controller.abort();
    const settling = scope.settle(settlement());
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();

    child.resolve();
    await settling;
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it('prepares ordinary chat work without a Flow registration', async () => {
    const scope = new FlowExecutorResourceScope();

    await scope.prepareProviderExecution(prepareForExecution);

    expect(prepareForExecution).toHaveBeenCalledOnce();
  });
});
