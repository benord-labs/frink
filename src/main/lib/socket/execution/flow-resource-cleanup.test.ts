import { beforeEach, describe, expect, it, vi } from 'vitest';

const providerMocks = vi.hoisted(() => ({
  disposeClaudeSessionAndWait: vi.fn(async () => {}),
}));
const clearCurrentExecutionChat = vi.hoisted(() => vi.fn());
const reconcileFlowAdmission = vi.hoisted(() => vi.fn(async () => {}));
const teardownMocks = vi.hoisted(() => ({
  cancelFlowTaskForSubChat: vi.fn<() => Promise<unknown>>(async () => null),
}));
const testDb = vi.hoisted(() => ({}));

vi.mock('./claude-provider-cleanup', () => providerMocks);
vi.mock('../../flows/admission/runtime', () => ({ reconcileFlowAdmission }));
vi.mock('../../db', () => ({ getDatabase: vi.fn(() => testDb) }));
vi.mock('../../db/repos/tasks', () => ({
  cancelFlowTaskForSubChat: teardownMocks.cancelFlowTaskForSubChat,
}));

import {
  beginFlowResourceActivity,
  hasFlowResourceActivity,
  setFlowAdmissionLifecycleHooks,
} from '../../flows/admission/activity';
import {
  acquireExecutorRuntimeSlot,
  settleFlowForegroundResources,
  startFlowTaskTeardown,
} from './flow-resource-cleanup';

const session = { subChatId: 'flow-chat' } as never;
type FlowCleanup = Parameters<typeof settleFlowForegroundResources>[0];

const cleanup = (overrides: Partial<FlowCleanup> = {}): FlowCleanup => {
  const executionController = overrides.executionController ?? new AbortController();
  return {
    subChatId: 'flow-chat',
    release: vi.fn(),
    resourcesTransferredToWakeHold: false,
    session,
    executionContextId: undefined,
    clearExecutionContext: clearCurrentExecutionChat,
    executionController,
    getActiveController: () => executionController ?? undefined,
    deleteAbortSource: () => {},
    clearPendingApprovals: () => {},
    providerSettlements: [],
    finalizeLinkedTaskSignal: async () => {},
    deleteActiveExecution: () => {},
    chatId: undefined,
    flowContinuationClearId: null,
    clearFlowContinuation: () => {},
    cleanupRuntime: null,
    unregisterFlowRunAbort: () => {},
    ...overrides,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  setFlowAdmissionLifecycleHooks({
    reconcile: reconcileFlowAdmission,
    requestRelease: vi.fn(async () => {}),
  });
});

describe('Flow foreground cleanup', () => {
  it('releases only after exact provider, MCP, bookkeeping and runtime cleanup', async () => {
    const order: string[] = [];
    providerMocks.disposeClaudeSessionAndWait.mockImplementationOnce(async () => {
      order.push('provider');
    });
    clearCurrentExecutionChat.mockImplementationOnce(() => order.push('mcp'));
    const release = vi.fn(() => order.push('activity'));

    await settleFlowForegroundResources(
      cleanup({
        release,
        executionContextId: 'ctx-flow',
        deleteAbortSource: () => order.push('abort'),
        clearPendingApprovals: () => order.push('approvals'),
        finalizeLinkedTaskSignal: async () => {
          order.push('turn');
        },
        deleteActiveExecution: () => order.push('bookkeeping'),
        cleanupRuntime: () => order.push('runtime'),
        unregisterFlowRunAbort: () => order.push('abort-registry'),
      }),
    );

    expect(order).toEqual([
      'approvals',
      'abort',
      'turn',
      'provider',
      'mcp',
      'bookkeeping',
      'runtime',
      'abort-registry',
      'activity',
    ]);
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it('aggregates cleanup failures into the Flow release after every phase runs', async () => {
    const approvalError = new Error('approval cleanup failed');
    const persistenceError = new Error('signal persistence failed');
    const activeExecutionError = new Error('active execution cleanup failed');
    const providerError = new Error('provider cleanup failed');
    const bookkeepingError = new Error('bookkeeping failed');
    const runtimeError = new Error('runtime cleanup failed');
    providerMocks.disposeClaudeSessionAndWait.mockRejectedValueOnce(providerError);
    const release = vi.fn();
    const deleteAbortSource = vi.fn(() => {
      throw bookkeepingError;
    });
    const runtimeCleanup = vi.fn(() => {
      throw runtimeError;
    });

    await expect(
      settleFlowForegroundResources(
        cleanup({
          release,
          deleteAbortSource,
          clearPendingApprovals: () => {
            throw approvalError;
          },
          finalizeLinkedTaskSignal: async () => {
            throw persistenceError;
          },
          cleanupRuntime: runtimeCleanup,
          deleteActiveExecution: () => {
            throw activeExecutionError;
          },
        }),
      ),
    ).rejects.toBeInstanceOf(AggregateError);

    expect(deleteAbortSource).toHaveBeenCalled();
    expect(runtimeCleanup).toHaveBeenCalled();
    const reported = release.mock.calls[0]?.[0];
    expect(reported).toBeInstanceOf(AggregateError);
    expect((reported as AggregateError).errors).toEqual([
      approvalError,
      bookkeepingError,
      persistenceError,
      providerError,
      activeExecutionError,
      runtimeError,
    ]);
  });

  it('passes a persistence failure to activity and rethrows it after teardown', async () => {
    const persistenceError = new Error('signal finalization failed');
    const release = vi.fn();
    const runtimeCleanup = vi.fn();

    await expect(
      settleFlowForegroundResources(
        cleanup({
          release,
          finalizeLinkedTaskSignal: async () => {
            throw persistenceError;
          },
          cleanupRuntime: runtimeCleanup,
        }),
      ),
    ).rejects.toThrow('signal finalization failed');

    expect(runtimeCleanup).toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(persistenceError);
  });

  it('normalizes an undefined cleanup rejection into durable failure evidence', async () => {
    const release = vi.fn();

    await expect(
      settleFlowForegroundResources(
        cleanup({
          release,
          clearPendingApprovals: () => {
            throw undefined;
          },
        }),
      ),
    ).rejects.toThrow('Flow cleanup failed without an error value');

    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Flow cleanup failed without an error value' }),
    );
  });

  it('awaits cancellation persistence before terminal signal and resource release', async () => {
    let finishPersistence = () => {};
    const persistence = new Promise<void>((resolve) => {
      finishPersistence = resolve;
    });
    const order: string[] = [];
    const release = vi.fn(() => order.push('activity'));
    providerMocks.disposeClaudeSessionAndWait.mockImplementationOnce(async () => {
      order.push('provider');
    });

    teardownMocks.cancelFlowTaskForSubChat.mockReturnValueOnce(persistence);
    const executionController = new AbortController();
    startFlowTaskTeardown('flow-chat', false, executionController);
    const settlement = settleFlowForegroundResources(
      cleanup({
        release,
        executionController,
        finalizeLinkedTaskSignal: async () => {
          order.push('signal');
        },
        cleanupRuntime: () => {},
      }),
    );

    await Promise.resolve();
    expect(order).toEqual([]);

    finishPersistence();
    await settlement;
    expect(order).toEqual(['signal', 'provider', 'activity']);
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it('retains activity until an out-of-process provider closes', async () => {
    let settleFirst = () => {};
    let settleSecond = () => {};
    const first = new Promise<void>((resolve) => {
      settleFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      settleSecond = resolve;
    });
    const release = vi.fn();
    const finalizeLinkedTaskSignal = vi.fn(async () => {});
    const settlement = settleFlowForegroundResources(
      cleanup({
        providerSettlements: [first, second],
        release,
        session: null,
        finalizeLinkedTaskSignal,
      }),
    );

    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();

    settleFirst();
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();
    expect(finalizeLinkedTaskSignal).not.toHaveBeenCalled();

    settleSecond();
    await settlement;
    expect(finalizeLinkedTaskSignal).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it('cleans the exact session supplied by the execution', async () => {
    await settleFlowForegroundResources(cleanup());

    expect(providerMocks.disposeClaudeSessionAndWait).toHaveBeenCalledWith(session);
  });

  it('retains preflight activity when runtime-slot acquisition fails', async () => {
    const release = beginFlowResourceActivity('flow-run');
    const acquisitionError = new Error('runtime slot unavailable');

    await expect(
      acquireExecutorRuntimeSlot(
        'codex',
        'execute',
        'flow-chat',
        async () => {
          throw acquisitionError;
        },
        release,
      ),
    ).rejects.toBe(acquisitionError);

    expect(hasFlowResourceActivity('flow-run')).toBe(true);
    release();
    await vi.waitFor(() => expect(hasFlowResourceActivity('flow-run')).toBe(false));
  });
});
