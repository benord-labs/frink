/**
 * schedule_trigger polling — local equivalent of pg-boss flow/scheduled-check.
 *
 * Every minute, scan enabled flows whose first node is `schedule_trigger`,
 * evaluate the cron expression against the current UTC minute, and if it
 * matches start a flow run with idempotency key `schedule:<flowId>:<slotMs>`
 * (so a tick that fires twice — clock jitter, app sleep/wake — never starts
 * two runs).
 *
 * Single-user-per-machine: no per-user concurrency lock, no per-user hourly
 * budget. The 50-runs/hour cloud cap is dropped — users self-rate-limit by
 * the cron expression they author.
 */

import { Cron } from 'croner';
import log from 'electron-log';
import { isTriggerBlockType } from '../../../shared/lib/block-registry';
import { getDatabase } from '../db';
import { getFlowRunByIdempotencyKey, hasActiveRunForFlow } from '../db/repos/flow-runs';
import * as bindingsRepo from '../db/repos/flow-trigger-bindings';
import { listEnabledFlowGraphs } from './flow-trigger-scan';
import { startFlowRun } from './start';

const SCHEDULE_TICK_INTERVAL_MS = 60_000;
const SCHEDULE_TRIGGER_BLOCK = 'schedule_trigger';

type ScheduleConfig = { cronExpression: string; timezone: string; skipIfRunning: boolean };

function parseScheduleConfig(raw: unknown): ScheduleConfig {
  if (raw === null || typeof raw !== 'object') {
    return { cronExpression: '', timezone: 'UTC', skipIfRunning: false };
  }
  const r = raw as Record<string, unknown>;
  return {
    cronExpression: typeof r.cronExpression === 'string' ? r.cronExpression.trim() : '',
    timezone: typeof r.timezone === 'string' && r.timezone.trim() ? r.timezone.trim() : 'UTC',
    skipIfRunning: r.skipIfRunning === true,
  };
}

function cronMatchesUtcMinute(expression: string, timezone: string, now: Date): boolean {
  if (!expression.trim()) return false;
  try {
    const cron = new Cron(expression.trim(), { timezone: timezone.trim() || 'UTC' });
    const slot = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    return cron.match(slot) === true;
  } catch {
    return false;
  }
}

/**
 * Run one scan pass. Exposed for tests / manual trigger.
 */
async function runScheduledTriggerTick(
  now: Date = new Date(),
): Promise<{ fired: number; skipped: number }> {
  const db = getDatabase();
  const flowGraphs = await listEnabledFlowGraphs(db);
  let fired = 0;
  let skipped = 0;

  for (const { flow, graph } of flowGraphs) {
    const firstNode = graph.nodes[0];
    if (!firstNode || firstNode.blockType !== SCHEDULE_TRIGGER_BLOCK) {
      skipped += 1;
      continue;
    }
    if (!isTriggerBlockType(firstNode.blockType)) {
      skipped += 1;
      continue;
    }
    const cfg = parseScheduleConfig(firstNode.config);
    if (!cronMatchesUtcMinute(cfg.cronExpression, cfg.timezone, now)) {
      skipped += 1;
      continue;
    }

    // Cross-check the trigger binding before firing — lets the user disable a
    // schedule_trigger flow without re-saving the flow graph. Lazy-upsert when
    // no binding row exists yet (legacy schedule_trigger flows from before the
    // triggers migration).
    const binding = await bindingsRepo
      .upsertScheduleBindingForFlow(db, {
        flowId: flow.id,
        projectId: flow.projectId ?? null,
      })
      .catch((err) => {
        log.warn('[FlowsSchedule] upsertScheduleBindingForFlow failed', {
          flowId: flow.id,
          err: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
    if (!binding?.isActive) {
      skipped += 1;
      continue;
    }

    const slotMs = Math.floor(now.getTime() / 60_000) * 60_000;
    const idempotencyKey = `schedule:${flow.id}:${slotMs}`;

    // Idempotency guard: if a run for this minute slot already exists (clock
    // jitter / duplicate tick), don't double-fire. getOrCreateFlowRunByIdempotencyKey
    // would handle this transactionally, but we want to skip emitting a run
    // start log entirely on collision rather than dispatching and replaying.
    const replay = await getFlowRunByIdempotencyKey(db, idempotencyKey).catch(() => null);
    if (replay) {
      skipped += 1;
      continue;
    }

    if (cfg.skipIfRunning) {
      // skipIfRunning: don't start a new run if any active run (pending /
      // running / paused) for this flow already exists. Cloud parity.
      const isActive = await hasActiveRunForFlow(db, flow.id).catch(() => false);
      if (isActive) {
        skipped += 1;
        continue;
      }
    }

    try {
      await startFlowRun({
        flowId: flow.id,
        triggerContext: {
          _frinkTrigger: SCHEDULE_TRIGGER_BLOCK,
          scheduledAt: new Date(slotMs).toISOString(),
          cronExpression: cfg.cronExpression,
          timezone: cfg.timezone,
        },
        idempotencyKey,
      });
      fired += 1;
    } catch (err) {
      log.warn('[FlowsSchedule] startFlowRun failed', {
        flowId: flow.id,
        err: err instanceof Error ? err.message : String(err),
      });
      skipped += 1;
    }
  }

  return { fired, skipped };
}

let timer: NodeJS.Timeout | null = null;

export function startScheduleTriggerLoop(): void {
  if (timer) return;
  timer = setInterval(() => {
    void runScheduledTriggerTick().catch((err) => {
      log.warn('[FlowsSchedule] tick failed', { err });
    });
  }, SCHEDULE_TICK_INTERVAL_MS);
}

export function stopScheduleTriggerLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
