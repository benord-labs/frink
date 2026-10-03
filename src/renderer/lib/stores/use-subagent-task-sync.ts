import * as Sentry from '@sentry/electron/renderer';
import { useStore } from 'jotai';
import { useEffect } from 'react';
import type {
  BackgroundRosterPayload,
  BackgroundRosterTask,
  SubagentTaskChangedPayload,
} from '../../../shared/types/wake-hold/subagent-task';
import { trpcClient } from '../trpc';
import { isDesktopApp } from '../utils/platform';
import {
  backgroundRosterAtomFamily,
  runningSubagentToolIdsAtom,
} from './active-transport-registry';

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

function isRosterTask(value: unknown): value is BackgroundRosterTask {
  if (typeof value !== 'object' || value === null) return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === 'string' &&
    task.id.length > 0 &&
    typeof task.type === 'string' &&
    typeof task.description === 'string' &&
    typeof task.ambient === 'boolean'
  );
}

export function isBackgroundRosterPayload(data: unknown): data is BackgroundRosterPayload {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  if (typeof d.subChatId !== 'string') return false;
  return d.tasks === null || (Array.isArray(d.tasks) && d.tasks.every(isRosterTask));
}

function applyRosterSnapshot(
  store: ReturnType<typeof useStore>,
  rosters: unknown[],
  spokenFor: ReadonlySet<string>,
): void {
  for (const roster of rosters) {
    if (!isBackgroundRosterPayload(roster) || spokenFor.has(roster.subChatId)) continue;
    store.set(backgroundRosterAtomFamily(roster.subChatId), roster.tasks);
  }
}

/**
 * Mirrors main's background roster into {@link backgroundRosterAtomFamily}, then seeds it from main's
 * snapshot, since a frame is pushed only on a membership change. A live frame beats the snapshot.
 */
function syncBackgroundRosters(store: ReturnType<typeof useStore>): () => void {
  const spokenFor = new Set<string>();
  let disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = window.desktopApi.on('socket:background-tasks-changed', (data) => {
    if (!isBackgroundRosterPayload(data)) return;
    spokenFor.add(data.subChatId);
    store.set(backgroundRosterAtomFamily(data.subChatId), data.tasks);
  });
  // Report once and retry once, as the subagent seed does; then give up.
  const seed = (mayRetry: boolean): void => {
    trpcClient.socket.listBackgroundRosters
      .query()
      .then((rosters) => {
        if (!disposed) applyRosterSnapshot(store, rosters, spokenFor);
      })
      .catch((error: unknown) => {
        if (disposed || !mayRetry) return;
        Sentry.captureException(error, { tags: { surface: 'background-roster-rehydrate' } });
        retryTimer = setTimeout(() => seed(false), RETRY_DELAY_MS);
      });
  };
  seed(true);
  return () => {
    disposed = true;
    if (retryTimer) clearTimeout(retryTimer);
    unsubscribe();
  };
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
 *
 * Also mirrors each sub-chat's live background tasks into {@link backgroundRosterAtomFamily}.
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

  useEffect(() => {
    if (!isDesktopApp() || !window.desktopApi?.on) return;
    return syncBackgroundRosters(store);
  }, [store]);
}
