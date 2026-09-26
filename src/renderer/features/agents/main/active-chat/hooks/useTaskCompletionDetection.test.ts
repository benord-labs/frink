// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appStore } from '../../../../../lib/jotai-store';
import {
  runLiveAtomFamily,
  wakeHeldAtomFamily,
} from '../../../../../lib/stores/active-transport-registry';
import { useStreamingStatusStore } from '../../../stores/streaming-status-store';
import { useTaskCompletionDetection } from './useTaskCompletionDetection';

const SUB = 'sub-1';
const setStreaming = (on: boolean) =>
  act(() => useStreamingStatusStore.getState().setStatus(SUB, on ? 'streaming' : 'ready'));
const setRunLive = (on: boolean) => act(() => appStore.set(runLiveAtomFamily(SUB), on));

const completeMutate = vi.fn();
const markPlanReadyMutate = vi.fn();
const updateStatusMutate = vi.fn();
const failMutateAsync = vi.fn();
const invalidateListPaginated = vi.fn();
const invalidateListCounts = vi.fn();
const invalidateGetById = vi.fn();
let completeOnSuccess: (() => void) | undefined;
let markPlanReadyOnSuccess: (() => void) | undefined;
let updateStatusOnSuccess: (() => void) | undefined;

type TaskData = {
  status:
    | 'pending'
    | 'running'
    | 'plan_ready'
    | 'needs_attention'
    | 'done'
    | 'completed'
    | 'failed'
    | 'cancelled';
  result?: {
    skipReview?: boolean;
    cancelled?: boolean;
    startMode?: 'execute' | 'plan' | 'wait';
    summary?: string;
    error?: string;
    agentSignal?: { state?: string; summary?: string };
  };
  trigger_context?: {
    _config?: { completionSignal?: 'agent_finish' | 'manual' };
  };
};

let taskData: TaskData | null = null;
let refetchTaskData: TaskData | null = null;

vi.mock('../../../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      tasks: {
        listPaginated: { invalidate: invalidateListPaginated },
        listCounts: { invalidate: invalidateListCounts },
        getById: { invalidate: invalidateGetById },
      },
    }),
    tasks: {
      markForReview: {
        useMutation: (options?: { onSuccess?: () => void }) => {
          markPlanReadyOnSuccess = options?.onSuccess;
          return {
            mutate: (input: unknown) => {
              markPlanReadyMutate(input);
              markPlanReadyOnSuccess?.();
            },
          };
        },
      },
      complete: {
        useMutation: (options?: { onSuccess?: () => void }) => {
          completeOnSuccess = options?.onSuccess;
          return {
            mutate: (input: unknown) => {
              completeMutate(input);
              completeOnSuccess?.();
            },
          };
        },
      },
      updateStatus: {
        useMutation: (options?: { onSuccess?: () => void }) => {
          updateStatusOnSuccess = options?.onSuccess;
          return {
            mutate: (input: unknown) => {
              updateStatusMutate(input);
              updateStatusOnSuccess?.();
            },
          };
        },
      },
      fail: {
        useMutation: (options?: { onSuccess?: () => void }) => ({
          mutate: (input: unknown) => {
            failMutateAsync(input);
            options?.onSuccess?.();
          },
          mutateAsync: async (input: unknown) => {
            failMutateAsync(input);
            options?.onSuccess?.();
          },
        }),
      },
      getById: {
        useQuery: () => ({
          data: taskData,
          refetch: vi.fn(async () => ({ data: refetchTaskData })),
        }),
      },
    },
  },
}));

describe('useTaskCompletionDetection', () => {
  beforeEach(() => {
    completeMutate.mockReset();
    markPlanReadyMutate.mockReset();
    invalidateListPaginated.mockReset();
    invalidateListCounts.mockReset();
    invalidateGetById.mockReset();
    updateStatusMutate.mockReset();
    failMutateAsync.mockReset();
    taskData = null;
    refetchTaskData = null;
    completeOnSuccess = undefined;
    markPlanReadyOnSuccess = undefined;
    updateStatusOnSuccess = undefined;
    useStreamingStatusStore.getState().clearStatus(SUB);
    appStore.set(runLiveAtomFamily(SUB), false);
    appStore.set(wakeHeldAtomFamily(SUB), null);
  });

  it('ignores a presentation-status flip while main still reports the run live', async () => {
    taskData = { status: 'running', result: { skipReview: true } };
    refetchTaskData = {
      status: 'running',
      result: { startMode: 'execute', agentSignal: { state: 'done', summary: 'Finished' } },
    };
    renderHook(() =>
      useTaskCompletionDetection({
        taskId: 't-live',
        chatId: 'c-live',
        subChatId: SUB,
        taskExecutionError: null,
        onTaskExecutionErrorHandled: vi.fn(),
      }),
    );

    // A chat switch or a foreign completion flips the status store; the run is still executing.
    setRunLive(true);
    setStreaming(true);
    setStreaming(false);
    await Promise.resolve();
    expect(updateStatusMutate).not.toHaveBeenCalled();

    // Main settles the stream: the recorded signal is applied on that edge, not before.
    setRunLive(false);
    await waitFor(() => {
      expect(updateStatusMutate).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 't-live', status: 'done' }),
      );
    });
  });

  it('stays armed across a wake hold', async () => {
    taskData = { status: 'running', result: { skipReview: true } };
    refetchTaskData = {
      status: 'running',
      result: { startMode: 'execute', agentSignal: { state: 'awaiting_input', summary: 'Q?' } },
    };
    renderHook(() =>
      useTaskCompletionDetection({
        taskId: 't-hold',
        chatId: 'c-hold',
        subChatId: SUB,
        taskExecutionError: null,
        onTaskExecutionErrorHandled: vi.fn(),
      }),
    );

    // Between wake bursts there is no transport, no observed run and status is 'ready' — only the
    // hold says the session will wake again. An eager question must not park the task here.
    setRunLive(true);
    act(() => appStore.set(wakeHeldAtomFamily(SUB), { waitingOn: ['Command'] }));
    setRunLive(false);
    await Promise.resolve();
    expect(updateStatusMutate).not.toHaveBeenCalled();

    act(() => appStore.set(wakeHeldAtomFamily(SUB), null));
    await waitFor(() => {
      expect(updateStatusMutate).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 't-hold', status: 'needs_attention' }),
      );
    });
  });

  it('stands down when no signal is present, then still acts on a later real turn end', async () => {
    // The streaming flag can flip mid-turn (it tracks presentation liveness); main owns parking
    // on silence. The stand-down must leave the hook armed for the genuine completion.
    taskData = { status: 'running', result: { skipReview: true } };
    refetchTaskData = taskData;
    renderHook(() =>
      useTaskCompletionDetection({
        taskId: 't1',
        chatId: 'c1',
        subChatId: SUB,
        taskExecutionError: null,
        onTaskExecutionErrorHandled: vi.fn(),
      }),
    );

    setStreaming(true);
    setStreaming(false);

    await waitFor(() => {
      expect(invalidateGetById).not.toHaveBeenCalled();
    });
    expect(updateStatusMutate).not.toHaveBeenCalled();
    expect(markPlanReadyMutate).not.toHaveBeenCalled();
    expect(completeMutate).not.toHaveBeenCalled();

    refetchTaskData = {
      status: 'running',
      result: { startMode: 'execute', agentSignal: { state: 'done', summary: 'Finished' } },
    };
    setStreaming(true);
    setStreaming(false);

    await waitFor(() => {
      expect(updateStatusMutate).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 't1', status: 'done' }),
      );
    });
    expect(invalidateGetById).toHaveBeenCalledTimes(1);
  });

  it('prefers explicit done signal over stream-end fallback', async () => {
    taskData = { status: 'running', result: { skipReview: true } };
    refetchTaskData = {
      status: 'running',
      result: {
        startMode: 'execute',
        agentSignal: { state: 'done', summary: 'All steps complete' },
      },
    };
    renderHook(() =>
      useTaskCompletionDetection({
        taskId: 't-done-race',
        chatId: 'c-done-race',
        subChatId: SUB,
        taskExecutionError: null,
        onTaskExecutionErrorHandled: vi.fn(),
      }),
    );

    setStreaming(true);
    setStreaming(false);

    await waitFor(() => {
      expect(updateStatusMutate).toHaveBeenCalledWith({
        taskId: 't-done-race',
        status: 'done',
        result: expect.objectContaining({
          startMode: 'execute',
          agentSignal: expect.objectContaining({ state: 'done' }),
        }),
      });
    });
    expect(completeMutate).not.toHaveBeenCalled();
  });

  it('does not overwrite explicit needs-attention signal metadata on stream completion', async () => {
    taskData = { status: 'running', result: { skipReview: true } };
    refetchTaskData = {
      status: 'running',
      result: {
        startMode: 'execute',
        agentSignal: { state: 'awaiting_input', summary: 'Waiting on user confirmation' },
      },
    };
    renderHook(() =>
      useTaskCompletionDetection({
        taskId: 't-awaiting-race',
        chatId: 'c-awaiting-race',
        subChatId: SUB,
        taskExecutionError: null,
        onTaskExecutionErrorHandled: vi.fn(),
      }),
    );

    setStreaming(true);
    setStreaming(false);

    await waitFor(() => {
      expect(updateStatusMutate).toHaveBeenCalledWith({
        taskId: 't-awaiting-race',
        status: 'needs_attention',
        result: expect.objectContaining({
          agentSignal: expect.objectContaining({
            state: 'awaiting_input',
          }),
        }),
      });
    });
  });

  it('fails task when latest refetched state carries explicit failed agent signal', async () => {
    taskData = { status: 'running', result: { skipReview: true } };
    refetchTaskData = {
      status: 'running',
      result: {
        startMode: 'execute',
        agentSignal: { state: 'failed', summary: 'Command failed at step 3' },
      },
    };
    renderHook(() =>
      useTaskCompletionDetection({
        taskId: 't-failed-signal',
        chatId: 'c-failed-signal',
        subChatId: SUB,
        taskExecutionError: null,
        onTaskExecutionErrorHandled: vi.fn(),
      }),
    );

    setStreaming(true);
    setStreaming(false);

    await waitFor(() => {
      expect(failMutateAsync).toHaveBeenCalledWith({
        taskId: 't-failed-signal',
        error: 'Agent explicitly signaled failure.',
      });
    });
    expect(updateStatusMutate).not.toHaveBeenCalled();
    expect(completeMutate).not.toHaveBeenCalled();
    expect(markPlanReadyMutate).not.toHaveBeenCalled();
  });

  it('marks for review when running with skipReview=false', async () => {
    taskData = { status: 'running', result: { skipReview: false, startMode: 'plan' } };
    refetchTaskData = taskData;
    renderHook(() =>
      useTaskCompletionDetection({
        taskId: 't2',
        chatId: 'c2',
        subChatId: SUB,
        taskExecutionError: null,
        onTaskExecutionErrorHandled: vi.fn(),
      }),
    );

    setStreaming(true);
    setStreaming(false);

    await waitFor(() => {
      expect(markPlanReadyMutate).toHaveBeenCalledWith({
        taskId: 't2',
        chatId: 'c2',
        summary: 'Agent completed execution',
      });
    });
    expect(invalidateListPaginated).toHaveBeenCalledTimes(1);
    expect(invalidateListCounts).toHaveBeenCalledTimes(1);
    expect(completeMutate).not.toHaveBeenCalled();
  });

  it('does not transition when task is not running', () => {
    taskData = { status: 'plan_ready', result: { skipReview: true } };
    refetchTaskData = taskData;
    renderHook(() =>
      useTaskCompletionDetection({
        taskId: 't3',
        chatId: 'c3',
        subChatId: SUB,
        taskExecutionError: null,
        onTaskExecutionErrorHandled: vi.fn(),
      }),
    );

    setStreaming(true);
    setStreaming(false);

    expect(markPlanReadyMutate).not.toHaveBeenCalled();
    expect(completeMutate).not.toHaveBeenCalled();
  });

  it('uses latest refetched task state before deciding fallback action', async () => {
    taskData = { status: 'running', result: { skipReview: false, startMode: 'plan' } };
    refetchTaskData = { status: 'running', result: { skipReview: true, startMode: 'plan' } };

    renderHook(() =>
      useTaskCompletionDetection({
        taskId: 't4',
        chatId: 'c4',
        subChatId: SUB,
        taskExecutionError: null,
        onTaskExecutionErrorHandled: vi.fn(),
      }),
    );

    setStreaming(true);
    setStreaming(false);

    await waitFor(() => {
      expect(completeMutate).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't4' }));
    });
    expect(markPlanReadyMutate).not.toHaveBeenCalled();
    expect(updateStatusMutate).not.toHaveBeenCalled();
  });

  it('does not park a manual-completion task that ended without a signal', async () => {
    taskData = {
      status: 'running',
      result: { skipReview: true },
      trigger_context: { _config: { completionSignal: 'manual' } },
    };
    refetchTaskData = taskData;
    renderHook(() =>
      useTaskCompletionDetection({
        taskId: 't-outcome',
        chatId: 'c7',
        subChatId: SUB,
        taskExecutionError: null,
        onTaskExecutionErrorHandled: vi.fn(),
      }),
    );

    setStreaming(true);
    setStreaming(false);

    await waitFor(() => {
      expect(invalidateGetById).not.toHaveBeenCalled();
    });
    expect(updateStatusMutate).not.toHaveBeenCalled();
    expect(completeMutate).not.toHaveBeenCalled();
    expect(markPlanReadyMutate).not.toHaveBeenCalled();
    expect(invalidateListPaginated).not.toHaveBeenCalled();
    expect(invalidateListCounts).not.toHaveBeenCalled();
  });

  it('recovers when refetch returns no task data', async () => {
    taskData = null;
    refetchTaskData = null;

    renderHook(() =>
      useTaskCompletionDetection({
        taskId: 't5',
        chatId: 'c5',
        subChatId: SUB,
        taskExecutionError: null,
        onTaskExecutionErrorHandled: vi.fn(),
      }),
    );

    // First completion edge: no task data available yet, no mutation should run.
    setStreaming(true);
    setStreaming(false);

    await waitFor(() => {
      expect(completeMutate).not.toHaveBeenCalled();
      expect(markPlanReadyMutate).not.toHaveBeenCalled();
    });

    // Next completion edge: task becomes available and should still be processed.
    taskData = {
      status: 'running',
      result: { startMode: 'execute', agentSignal: { state: 'done', summary: 'Finished' } },
    };
    refetchTaskData = taskData;
    setStreaming(true);
    setStreaming(false);

    await waitFor(() => {
      expect(updateStatusMutate).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 't5', status: 'done' }),
      );
    });
  });

  it('does not transition cancelled tasks after stream completion', async () => {
    taskData = { status: 'running', result: { skipReview: false } };
    refetchTaskData = { status: 'failed', result: { cancelled: true } };

    renderHook(() =>
      useTaskCompletionDetection({
        taskId: 't6',
        chatId: 'c6',
        subChatId: SUB,
        taskExecutionError: null,
        onTaskExecutionErrorHandled: vi.fn(),
      }),
    );

    setStreaming(true);
    setStreaming(false);

    await waitFor(() => {
      expect(completeMutate).not.toHaveBeenCalled();
      expect(markPlanReadyMutate).not.toHaveBeenCalled();
    });
  });

  it('fails running task on execution-level error signal', async () => {
    taskData = { status: 'running', result: { skipReview: false } };
    refetchTaskData = taskData;
    const handled = vi.fn();

    const { rerender } = renderHook(
      ({ taskExecutionError }) =>
        useTaskCompletionDetection({
          taskId: 't7',
          chatId: 'c7',
          subChatId: SUB,
          taskExecutionError,
          onTaskExecutionErrorHandled: handled,
        }),
      {
        initialProps: {
          taskExecutionError: null as {
            error: string;
            category: string;
            timestamp: number;
          } | null,
        },
      },
    );

    rerender({
      taskExecutionError: {
        error: 'Tool concurrency failed with 400',
        category: 'UNKNOWN',
        timestamp: Date.now(),
      },
    });

    await waitFor(() => {
      expect(failMutateAsync).toHaveBeenCalledWith({
        taskId: 't7',
        error: 'Tool concurrency failed with 400',
      });
    });
    expect(handled).toHaveBeenCalled();
  });

  it('does not fail task for transport-only error categories', async () => {
    taskData = { status: 'running', result: { skipReview: false } };
    refetchTaskData = taskData;
    const handled = vi.fn();

    renderHook(() =>
      useTaskCompletionDetection({
        taskId: 't8',
        chatId: 'c8',
        subChatId: SUB,
        taskExecutionError: {
          error: 'Socket disconnected',
          category: 'SOCKET_DISCONNECTED',
          timestamp: Date.now(),
        },
        onTaskExecutionErrorHandled: handled,
      }),
    );

    await waitFor(() => {
      expect(handled).toHaveBeenCalled();
    });
    expect(failMutateAsync).not.toHaveBeenCalled();
  });

  it('leaves a FLOW_RUN_ENDED signal latched for the recovery surfaces', async () => {
    taskData = { status: 'running', result: { skipReview: false } };
    refetchTaskData = taskData;
    const handled = vi.fn();

    // Latch AFTER mount, as in the app: the signal arrives on a live hook, not at first render
    // (mounting with a pre-latched error would trip the taskId-reset effect instead).
    const { rerender } = renderHook(
      ({ err }: { err: { error: string; category: string; timestamp: number } | null }) =>
        useTaskCompletionDetection({
          taskId: 't8b',
          chatId: 'c8b',
          subChatId: SUB,
          taskExecutionError: err,
          onTaskExecutionErrorHandled: handled,
        }),
      {
        initialProps: {
          err: null as { error: string; category: string; timestamp: number } | null,
        },
      },
    );
    rerender({
      err: {
        error: 'Flow task t8b is no longer execution-eligible',
        category: 'FLOW_RUN_ENDED',
        timestamp: Date.now(),
      },
    });

    // Never auto-handled: InterruptedRunControls / a new manual send clear it on user intent.
    await new Promise((r) => setTimeout(r, 50));
    expect(handled).not.toHaveBeenCalled();
    expect(failMutateAsync).not.toHaveBeenCalled();
  });

  it('fails task for tool-concurrency API 400 errors', async () => {
    taskData = { status: 'running', result: { skipReview: false } };
    refetchTaskData = taskData;
    const handled = vi.fn();

    renderHook(() =>
      useTaskCompletionDetection({
        taskId: 't8-tool-concurrency',
        chatId: 'c8-tool-concurrency',
        subChatId: SUB,
        taskExecutionError: {
          error:
            'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"tool_use ids were found without tool_result blocks immediately after: toolu_123"}}',
          category: 'AUTH_FAILED_SDK',
          timestamp: Date.now(),
        },
        onTaskExecutionErrorHandled: handled,
      }),
    );

    await waitFor(() => {
      expect(failMutateAsync).toHaveBeenCalledWith({
        taskId: 't8-tool-concurrency',
        error:
          'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"tool_use ids were found without tool_result blocks immediately after: toolu_123"}}',
      });
    });
    expect(handled).toHaveBeenCalled();
  });

  it('swallows expected 409 race conflicts for fail transition', async () => {
    taskData = { status: 'running', result: { skipReview: false } };
    refetchTaskData = taskData;
    const handled = vi.fn();
    failMutateAsync.mockImplementationOnce(async () => {
      throw new Error('HTTP 409: Task status transition is not allowed');
    });

    renderHook(() =>
      useTaskCompletionDetection({
        taskId: 't9',
        chatId: 'c9',
        subChatId: SUB,
        taskExecutionError: {
          error: 'Execution failed',
          category: 'UNKNOWN',
          timestamp: Date.now(),
        },
        onTaskExecutionErrorHandled: handled,
      }),
    );

    await waitFor(() => {
      expect(handled).toHaveBeenCalled();
    });
  });

  it('does not fail when latest task is already terminal', async () => {
    taskData = { status: 'running', result: { skipReview: false } };
    refetchTaskData = { status: 'completed', result: { summary: 'done' } };
    const handled = vi.fn();

    renderHook(() =>
      useTaskCompletionDetection({
        taskId: 't10',
        chatId: 'c10',
        subChatId: SUB,
        taskExecutionError: {
          error: 'Execution failed',
          category: 'UNKNOWN',
          timestamp: Date.now(),
        },
        onTaskExecutionErrorHandled: handled,
      }),
    );

    await waitFor(() => {
      expect(handled).toHaveBeenCalled();
    });
    expect(failMutateAsync).not.toHaveBeenCalled();
  });

  it('does not clear task execution error signal on taskId change when no error is pending', async () => {
    const handled = vi.fn();
    const { rerender } = renderHook(
      ({ taskId, taskExecutionError }) =>
        useTaskCompletionDetection({
          taskId,
          chatId: 'c-reset',
          subChatId: SUB,
          taskExecutionError,
          onTaskExecutionErrorHandled: handled,
        }),
      {
        initialProps: {
          taskId: 'old-task',
          taskExecutionError: null,
        },
      },
    );

    rerender({ taskId: 'new-task', taskExecutionError: null });

    await Promise.resolve();
    expect(handled).not.toHaveBeenCalled();
  });

  it('clears task execution error signal on taskId change when an error is pending', async () => {
    taskData = { status: 'running', result: { skipReview: false } };
    refetchTaskData = taskData;
    const handled = vi.fn();

    const { rerender } = renderHook(
      ({ taskId, taskExecutionError }) =>
        useTaskCompletionDetection({
          taskId,
          chatId: 'c-reset-pending',
          subChatId: SUB,
          taskExecutionError,
          onTaskExecutionErrorHandled: handled,
        }),
      {
        initialProps: {
          taskId: 'old-task',
          taskExecutionError: {
            error: 'Execution failed',
            category: 'UNKNOWN',
            timestamp: Date.now(),
          } as { error: string; category: string; timestamp: number } | null,
        },
      },
    );

    await waitFor(() => {
      expect(handled).toHaveBeenCalled();
    });

    handled.mockClear();

    rerender({
      taskId: 'new-task',
      taskExecutionError: {
        error: 'Execution failed again',
        category: 'UNKNOWN',
        timestamp: Date.now() + 1,
      },
    });

    await waitFor(() => {
      expect(handled).toHaveBeenCalled();
    });
  });

  it('avoids duplicate fail when second error arrives after first transition', async () => {
    taskData = { status: 'running', result: { skipReview: false } };
    refetchTaskData = { status: 'running', result: { skipReview: false } };
    const handled = vi.fn();

    const { rerender } = renderHook(
      ({ taskExecutionError }) =>
        useTaskCompletionDetection({
          taskId: 't11',
          chatId: 'c11',
          subChatId: SUB,
          taskExecutionError,
          onTaskExecutionErrorHandled: handled,
        }),
      {
        initialProps: {
          taskExecutionError: {
            error: 'first failure',
            category: 'UNKNOWN',
            timestamp: Date.now(),
          } as { error: string; category: string; timestamp: number } | null,
        },
      },
    );

    await waitFor(() => {
      expect(failMutateAsync).toHaveBeenCalledTimes(1);
    });

    // Simulate backend state after first fail transition.
    refetchTaskData = { status: 'failed', result: { error: 'first failure' } };
    rerender({
      taskExecutionError: {
        error: 'second duplicate signal',
        category: 'UNKNOWN',
        timestamp: Date.now() + 1,
      },
    });

    await waitFor(() => {
      expect(handled.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
    expect(failMutateAsync).toHaveBeenCalledTimes(1);
  });
});
