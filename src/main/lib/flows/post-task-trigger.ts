/**
 * post_task_trigger fan-out. Polls terminal tasks every 2s and starts a flow
 * run for each matching `flow_trigger_bindings` row (triggerType =
 * 'post_task_trigger', isActive = 1, projectId = task.projectId).
 *
 * Idempotency: each (binding, task) pair fires once via the flow_run
 * idempotency key `post_task:<bindingId>:<taskId>` — prevents cycles where
 * the spawned flow's own terminal task would re-trigger the same binding.
 *
 * Single-machine and local-only: the binding fans out in this process, never across machines.
 */

import { and, inArray, isNotNull } from 'drizzle-orm';
import log from 'electron-log';
import { getDatabase } from '../db';
import { getFlowRunByIdempotencyKey } from '../db/repos/flow-runs';
import { listActiveForType } from '../db/repos/flow-trigger-bindings';
import type { Task } from '../db/schema';
import { tasks } from '../db/schema';
import { startFlowRun } from './start';

const POLL_INTERVAL_MS = 2_000;
const TERMINAL_STATUSES: Task['status'][] = [
  'completed',
  'done',
  'failed',
  'cancelled',
  'plan_ready',
  'needs_attention',
];

// In-memory dedup. Persisted protection sits in the flow_runs unique
// idempotencyKey index — this set just spares the DB hit for repeat ticks.
const firedKeys = new Set<string>();

let interval: NodeJS.Timeout | null = null;

async function runPostTaskTriggerTick(): Promise<{ fired: number; skipped: number }> {
  const db = getDatabase();
  const bindings = await listActiveForType(db, 'post_task_trigger').catch((err) => {
    log.warn('[PostTaskTrigger] listActiveForType failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  });
  if (bindings.length === 0) return { fired: 0, skipped: 0 };

  // Fetch terminal tasks scoped to projects referenced by any binding. Keep
  // the query narrow so unrelated tasks don't pull rows.
  const projectIds = Array.from(
    new Set(
      bindings
        .map((b) => b.projectId)
        .filter((p): p is string => typeof p === 'string' && p.length > 0),
    ),
  );
  if (projectIds.length === 0) return { fired: 0, skipped: 0 };

  const terminalTasks: Task[] = await db
    .select()
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.completedAt),
        inArray(tasks.status, TERMINAL_STATUSES),
        inArray(tasks.projectId, projectIds),
      ),
    );

  let fired = 0;
  let skipped = 0;

  for (const task of terminalTasks) {
    for (const binding of bindings) {
      if (binding.projectId !== task.projectId) continue;
      const idempotencyKey = `post_task:${binding.id}:${task.id}`;
      if (firedKeys.has(idempotencyKey)) {
        skipped += 1;
        continue;
      }
      const replay = await getFlowRunByIdempotencyKey(db, idempotencyKey).catch(() => null);
      if (replay) {
        firedKeys.add(idempotencyKey);
        skipped += 1;
        continue;
      }

      try {
        await startFlowRun({
          flowId: binding.flowId,
          triggerContext: {
            _frinkTrigger: 'post_task_trigger',
            bindingId: binding.id,
            taskId: task.id,
            projectId: task.projectId,
            taskStatus: task.status,
            taskTitle: task.title,
            taskCompletedAt: task.completedAt?.toISOString() ?? null,
          },
          idempotencyKey,
        });
        firedKeys.add(idempotencyKey);
        fired += 1;
      } catch (err) {
        log.warn('[PostTaskTrigger] startFlowRun failed', {
          bindingId: binding.id,
          flowId: binding.flowId,
          taskId: task.id,
          err: err instanceof Error ? err.message : String(err),
        });
        skipped += 1;
      }
    }
  }

  return { fired, skipped };
}

export function startPostTaskTriggerLoop(): void {
  if (interval) return;
  interval = setInterval(() => {
    void runPostTaskTriggerTick().catch((err) => {
      log.warn('[PostTaskTrigger] tick failed', { err });
    });
  }, POLL_INTERVAL_MS);
}

export function stopPostTaskTriggerLoop(): void {
  if (interval) clearInterval(interval);
  interval = null;
  firedKeys.clear();
}
