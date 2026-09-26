import { useStore } from 'jotai';
import { useEffect } from 'react';
import type { SubagentTaskChangedPayload } from '../../../shared/types/wake-hold/subagent-task';
import { isDesktopApp } from '../utils/platform';
import { runningSubagentToolIdsAtom } from './active-transport-registry';

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

/**
 * Mirrors main's subagent-task liveness into {@link runningSubagentToolIdsAtom} so a Task/Agent
 * card whose async launch already resolved its tool part can keep reading "Running Subagent".
 *
 * Mounted once at the app root, not per chat — a task can settle while its chat is off screen,
 * and the retraction must still land.
 */
export function useSubagentTaskSync(): void {
  const store = useStore();

  useEffect(() => {
    if (!isDesktopApp()) return;
    if (!window.desktopApi?.on) return;

    return window.desktopApi.on('socket:subagent-task-changed', (data) => {
      if (!isSubagentTaskPayload(data)) return;
      const current = store.get(runningSubagentToolIdsAtom);
      if (current.has(data.toolCallId) === data.running) return;
      const next = new Set(current);
      if (data.running) {
        next.add(data.toolCallId);
      } else {
        next.delete(data.toolCallId);
      }
      store.set(runningSubagentToolIdsAtom, next);
    });
  }, [store]);
}
