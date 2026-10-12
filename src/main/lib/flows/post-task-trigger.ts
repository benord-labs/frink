/**
 * post_task_trigger fan-out. Polls terminal tasks every 2s and starts a flow
 * run for each matching `flow_trigger_bindings` row (triggerType =
 * 'post_task_trigger', isActive = 1, projectId = task.projectId).
 *
 * Idempotency: each (binding, task) pair fires once via the flow_run
 * idempotency key `post_task:<bindingId>:<taskId>`, anti-joined in the tick's
 * query; a binding only sees tasks completed at or after its creation.
 *
 * Single-machine and local-only: the binding fans out in this process, never across machines.
 */

import { and, eq, exists, gte, inArray, isNotNull, notExists, sql } from 'drizzle-orm';
import log from 'electron-log';
import { getDatabase } from '../db';
import { isBlankProjectId, listActiveForType } from '../db/repos/flow-trigger-bindings';
import type { FlowTriggerBinding, Task } from '../db/schema';
import { flowRuns, flows, flowTriggerBindings, flowVersions, tasks } from '../db/schema';
import { type StartFlowRunInput, startFlowRun } from './start';

const POLL_INTERVAL_MS = 2_000;
const TERMINAL_STATUSES: Task['status'][] = [
  'completed',
  'done',
  'failed',
  'cancelled',
  'plan_ready',
  'needs_attention',
];

/** Must stay in lockstep with `pendingKeySql` below — the anti-join matches on this exact string. */
export function postTaskIdempotencyKey(bindingId: string, taskId: string): string {
  return `post_task:${bindingId}:${taskId}`;
}
const pendingKeySql = sql`'post_task:' || ${flowTriggerBindings.id} || ':' || ${tasks.id}`;

// Project-less bindings can never match a task; warn once per binding rather than every tick.
const warnedUnscopedBindings = new Set<string>();

let interval: NodeJS.Timeout | null = null;

type StartPostTaskRun = (input: StartFlowRunInput) => Promise<{ isReplay: boolean }>;
export type PostTaskTriggerDeps = {
  db: ReturnType<typeof getDatabase>;
  startFlowRun: StartPostTaskRun;
};
const realDeps = (): PostTaskTriggerDeps => ({ db: getDatabase(), startFlowRun });

/** (task, binding) pairs that should fire now: active binding, startable flow, unfired key. */
export function selectPendingPairs(db: ReturnType<typeof getDatabase>) {
  return db
    .select({
      taskId: tasks.id,
      projectId: tasks.projectId,
      status: tasks.status,
      title: tasks.title,
      completedAt: tasks.completedAt,
      bindingId: flowTriggerBindings.id,
      flowId: flowTriggerBindings.flowId,
    })
    .from(tasks)
    .innerJoin(
      flowTriggerBindings,
      and(
        eq(flowTriggerBindings.projectId, tasks.projectId),
        eq(flowTriggerBindings.triggerType, 'post_task_trigger'),
        eq(flowTriggerBindings.isActive, true),
      ),
    )
    .innerJoin(flows, and(eq(flows.id, flowTriggerBindings.flowId), eq(flows.isEnabled, true)))
    .where(
      and(
        isNotNull(tasks.completedAt),
        gte(tasks.completedAt, flowTriggerBindings.createdAt),
        inArray(tasks.status, TERMINAL_STATUSES),
        exists(
          db
            .select({ one: sql`1` })
            .from(flowVersions)
            .where(eq(flowVersions.flowId, flows.id)),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(flowRuns)
            .where(eq(flowRuns.idempotencyKey, pendingKeySql)),
        ),
      ),
    );
}

function warnUnscopedBindingsOnce(bindings: readonly FlowTriggerBinding[]): void {
  for (const binding of bindings) {
    if (!isBlankProjectId(binding.projectId) || warnedUnscopedBindings.has(binding.id)) continue;
    warnedUnscopedBindings.add(binding.id);
    log.warn('[PostTaskTrigger] skipping binding with no projectId', {
      bindingId: binding.id,
      flowId: binding.flowId,
    });
  }
}

export async function runPostTaskTriggerTick(
  deps: PostTaskTriggerDeps = realDeps(),
): Promise<{ fired: number; skipped: number }> {
  warnUnscopedBindingsOnce(await listActiveForType(deps.db, 'post_task_trigger'));
  const pairs = await selectPendingPairs(deps.db);

  let fired = 0;
  let skipped = 0;

  for (const pair of pairs) {
    const idempotencyKey = postTaskIdempotencyKey(pair.bindingId, pair.taskId);
    try {
      await deps.startFlowRun({
        flowId: pair.flowId,
        triggerContext: {
          _frinkTrigger: 'post_task_trigger',
          bindingId: pair.bindingId,
          taskId: pair.taskId,
          projectId: pair.projectId,
          taskStatus: pair.status,
          taskTitle: pair.title,
          taskCompletedAt: pair.completedAt?.toISOString() ?? null,
        },
        idempotencyKey,
      });
      fired += 1;
    } catch (err) {
      log.warn('[PostTaskTrigger] startFlowRun failed', {
        bindingId: pair.bindingId,
        flowId: pair.flowId,
        taskId: pair.taskId,
        err: err instanceof Error ? err.message : String(err),
      });
      skipped += 1;
    }
  }

  return { fired, skipped };
}

export function startPostTaskTriggerLoop(getDeps: () => PostTaskTriggerDeps = realDeps): void {
  if (interval) return;
  interval = setInterval(() => {
    void runPostTaskTriggerTick(getDeps()).catch((err) => {
      log.warn('[PostTaskTrigger] tick failed', { err });
    });
  }, POLL_INTERVAL_MS);
}

export function stopPostTaskTriggerLoop(): void {
  if (interval) clearInterval(interval);
  interval = null;
  warnedUnscopedBindings.clear();
}
