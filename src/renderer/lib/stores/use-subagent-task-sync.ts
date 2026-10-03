import * as Sentry from '@sentry/electron/renderer';
import { useStore } from 'jotai';
import { useEffect } from 'react';
import type { SubagentTaskChangedPayload } from '../../../shared/types/wake-hold/subagent-task';
import { trpcClient } from '../trpc';
import { isDesktopApp } from '../utils/platform';
import { runningSubagentToolIdsAtom } from './active-transport-registry';

const RETRY_DELAY_MS = 500;

/** IPC data arrives as `unknown`; a malformed frame must leave the running set untouched. */
export function isSubagentTaskPayload(data: unknown): data is SubagentTaskChangedPayload {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.subChatId === 'string' &&
    typeof d.toolCallId === 'string' &&
    d.toolCallId.length > 0 &&
    typeof d.running === 'boolean'
  );
}

/** The set is replaced only when membership changes, so a repeated frame never re-renders cards. */
function applySubagentTask(
  store: ReturnType<typeof useStore>,
  toolCallId: string,
  running: boolean,
): void {
  const current = store.get(runningSubagentToolIdsAtom);
  if (current.has(toolCallId) === running) return;
  const next = new Set(current);
  if (running) {
    next.add(toolCallId);
  } else {
    next.delete(toolCallId);
  }
  store.set(runningSubagentToolIdsAtom, next);
}

/**
 * Mirrors main's subagent-task liveness into {@link runningSubagentToolIdsAtom} so a Task/Agent
 * card whose async launch already resolved its tool part can keep reading "Running Subagent".
 *
 * Mounted once at the app root, not per chat — a task can settle while its chat is off screen,
 * and the retraction must still land.
 *
 * Boot also SEEDS from main's tracker, because the push is the only announcement a start ever
 * makes: a window that reloads mid-task would otherwise read the card as "Completed Subagent".
 */
export function useSubagentTaskSync(): void {
  const store = useStore();

  useEffect(() => {
    if (!isDesktopApp()) return;
    if (!window.desktopApi?.on) return;

    // Subscribe BEFORE seeding, and let a live frame win: one landing while the snapshot is in
    // flight is fresher than it, so seeding over a retraction would spin a card no frame retracts.
    const spokenFor = new Set<string>();
    // A reply answered after teardown knows only what THIS instance's `spokenFor` saw, so it is
    // void entirely, errors included.
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retried = false;
    const unsubscribe = window.desktopApi.on('socket:subagent-task-changed', (data) => {
      if (!isSubagentTaskPayload(data)) return;
      spokenFor.add(data.toolCallId);
      applySubagentTask(store, data.toolCallId, data.running);
    });

    // Pull once; on rejection, report and retry exactly once more; then give up.
    const seed = async (): Promise<void> => {
      try {
        const tasks = await trpcClient.socket.listRunningSubagentTasks.query();
        if (disposed) return;
        for (const task of tasks) {
          if (!isSubagentTaskPayload(task) || !task.running || spokenFor.has(task.toolCallId)) {
            continue;
          }
          applySubagentTask(store, task.toolCallId, true);
        }
      } catch (error) {
        if (disposed || retried) return;
        retried = true;
        Sentry.captureException(error, { tags: { surface: 'subagent-task-rehydrate' } });
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void seed();
        }, RETRY_DELAY_MS);
      }
    };

    void seed();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribe();
    };
  }, [store]);
}
