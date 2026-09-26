/**
 * Hook to detect when an agent completes a task-linked chat.
 * Depending on task intent, it either marks for review or completes directly.
 */

import * as Sentry from '@sentry/electron/renderer';
import { useAtomValue } from 'jotai';
import { useEffect, useRef } from 'react';
import { appStore } from '../../../../../lib/jotai-store';
import { runLiveAtomFamily, wakeHeldAtomFamily } from '../../../../../lib/stores/active-transport-registry';
import { trpc } from '../../../../../lib/trpc';
import type { TaskExecutionErrorSignal } from '../../../atoms';
import { useStreamingStatusStore } from '../../../stores/streaming-status-store';
import {
  getTaskRefetchInterval,
  invalidateTaskQueries,
  isExecutionLevelFailure,
  resolveAutoCompletionAction,
} from '../utils';

type Props = {
  taskId: string | null;
  chatId: string;
  subChatId: string;
  taskExecutionError: TaskExecutionErrorSignal | null;
  onTaskExecutionErrorHandled: () => void;
};

function isExpectedTaskStatusRaceError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes('409') ||
    message.includes('status transition is not allowed') ||
    message.includes('only running tasks can be failed')
  );
}

function toResultRecord(result: unknown): Record<string, unknown> | null {
  return typeof result === 'object' && result != null ? (result as Record<string, unknown>) : null;
}

/** The turn is over only when main's run liveness, the wake hold AND the presentation status all
 * read idle — the status store alone flips mid-turn (chat switch, foreign completion, socket blip). */
function useTurnLive(subChatId: string): boolean {
  const statusStreaming = useStreamingStatusStore((s) => s.isStreaming(subChatId));
  const runLive = useAtomValue(runLiveAtomFamily(subChatId), { store: appStore });
  const wakeHeld = useAtomValue(wakeHeldAtomFamily(subChatId), { store: appStore });
  return statusStreaming || runLive || wakeHeld !== null;
}

/** Detects when the agent's turn ends for a task-linked chat and updates task status. */
export function useTaskCompletionDetection({
  taskId,
  chatId,
  subChatId,
  taskExecutionError,
  onTaskExecutionErrorHandled,
}: Props) {
  const isStreaming = useTurnLive(subChatId);
  const wasStreamingRef = useRef(false);
  const hasMarkedRef = useRef(false);
  const onTaskExecutionErrorHandledRef = useRef(onTaskExecutionErrorHandled);
  onTaskExecutionErrorHandledRef.current = onTaskExecutionErrorHandled;
  const hasPendingTaskExecutionErrorRef = useRef(taskExecutionError != null);
  const utils = trpc.useUtils();

  // `trpc.tasks.markForReview` maps to the "plan ready" state in the current model;
  // `markPlanReadyMutation` keeps the runtime intent explicit, and success calls
  // `invalidateTaskQueries` to refresh task data after the mutation completes.
  const markPlanReadyMutation = trpc.tasks.markForReview.useMutation({
    onSuccess: () => invalidateTaskQueries(utils),
  });
  const markDoneMutation = trpc.tasks.updateStatus.useMutation({
    onSuccess: () => invalidateTaskQueries(utils),
  });
  const completeMutation = trpc.tasks.complete.useMutation({
    onSuccess: () => invalidateTaskQueries(utils),
  });
  const markNeedsAttentionMutation = trpc.tasks.updateStatus.useMutation({
    onSuccess: () => invalidateTaskQueries(utils),
  });
  const failTaskMutation = trpc.tasks.fail.useMutation({
    onSuccess: () => invalidateTaskQueries(utils),
  });
  const taskQuery = trpc.tasks.getById.useQuery(taskId ?? '', {
    enabled: !!taskId,
    refetchInterval: (query) => getTaskRefetchInterval(query.state.data?.status),
  });
  const task = taskQuery.data;
  const refetchTask = taskQuery.refetch;

  useEffect(() => {
    hasPendingTaskExecutionErrorRef.current = taskExecutionError != null;
  }, [taskExecutionError]);

  useEffect(() => {
    // Track streaming state transitions
    if (isStreaming) {
      wasStreamingRef.current = true;
    }

    // Detect transition from streaming to not streaming (completion)
    if (wasStreamingRef.current && !isStreaming && taskId && !hasMarkedRef.current) {
      hasMarkedRef.current = true;
      // `task` stays in deps as a fallback baseline for `resolveAutoCompletionAction` if `refetchTask` doesn't return fresh data; `wasStreamingRef` + `hasMarkedRef` gate this path to prevent duplicate mutations.
      void refetchTask()
        .then((latest) => {
          const latestTask = latest.data ?? task ?? null;
          const latestResult = toResultRecord(latestTask?.result);
          if (
            latestTask?.status === 'cancelled' ||
            (latestTask?.status === 'failed' && latestResult?.cancelled === true)
          ) {
            // User-triggered cancellation should stay terminal, not bounce to review/done.
            wasStreamingRef.current = false;
            hasMarkedRef.current = false;
            return;
          }

          const latestAction = resolveAutoCompletionAction(latestTask);
          if (latestAction == null) {
            // Nothing to apply for this stream completion, allow future transitions.
            wasStreamingRef.current = false;
            hasMarkedRef.current = false;
            return;
          }

          if (latestAction === 'mark_done') {
            markDoneMutation.mutate({
              taskId,
              status: 'done',
              result: latestResult ?? {
                summary: 'Agent finished and is awaiting manual completion.',
              },
            });
            return;
          }
          if (latestAction === 'complete') {
            completeMutation.mutate({
              taskId,
              result: { summary: 'Agent completed execution' },
            });
            return;
          }
          if (latestAction === 'needs_attention') {
            markNeedsAttentionMutation.mutate({
              taskId,
              status: 'needs_attention',
              result: latestResult ?? { summary: 'Agent finished and requires attention.' },
            });
            return;
          }
          if (latestAction === 'failed') {
            failTaskMutation.mutate({
              taskId,
              error: 'Agent explicitly signaled failure.',
            });
            return;
          }
          if (latestAction === 'mark_plan_ready') {
            markPlanReadyMutation.mutate({
              taskId,
              chatId,
              summary: 'Agent completed execution',
            });
            return;
          }
        })
        .catch(() => {
          wasStreamingRef.current = false;
          hasMarkedRef.current = false;
        });
    }
  }, [
    isStreaming,
    taskId,
    chatId,
    markPlanReadyMutation,
    markDoneMutation,
    completeMutation,
    markNeedsAttentionMutation,
    failTaskMutation,
    refetchTask,
    task,
  ]);

  useEffect(() => {
    if (!taskId || !taskExecutionError) {
      return;
    }

    if (!isExecutionLevelFailure(taskExecutionError.error, taskExecutionError.category)) {
      // Flow-run declines stay latched for the recovery surfaces (InterruptedRunControls click, a
      // new manual send, or — for RESUMING specifically — the re-admitted turn's own start chunk,
      // cleared in useRealtimeSync/websocket-chat-transport) — handling them here would erase the
      // signal the instant it surfaced.
      if (
        taskExecutionError.category !== 'FLOW_RUN_ENDED' &&
        taskExecutionError.category !== 'FLOW_RUN_RESUMING'
      ) {
        onTaskExecutionErrorHandledRef.current();
      }
      return;
    }

    void refetchTask()
      .then(async (latest) => {
        const latestTask = latest.data ?? task ?? null;
        if (latestTask?.status !== 'running') {
          onTaskExecutionErrorHandledRef.current();
          return;
        }

        try {
          await failTaskMutation.mutateAsync({
            taskId,
            error: taskExecutionError.error,
          });
        } catch (error) {
          if (!isExpectedTaskStatusRaceError(error)) {
            Sentry.captureException(error, {
              tags: {
                source: 'useTaskCompletionDetection',
              },
              extra: {
                taskId,
                errorCategory: taskExecutionError.category,
              },
            });
          }
        } finally {
          onTaskExecutionErrorHandledRef.current();
        }
      })
      .catch(() => {
        onTaskExecutionErrorHandledRef.current();
      });
  }, [taskId, task, taskExecutionError, refetchTask, failTaskMutation]);

  // Reset when taskId changes (new task)
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset on taskId change
  useEffect(() => {
    wasStreamingRef.current = false;
    hasMarkedRef.current = false;
    if (hasPendingTaskExecutionErrorRef.current) {
      onTaskExecutionErrorHandledRef.current();
    }
  }, [taskId]);
}
