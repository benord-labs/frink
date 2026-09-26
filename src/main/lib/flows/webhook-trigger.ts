/** The machine's own listener verifies a delivery and runs the extractor; this matches the result against
 * LOCAL flow graphs and starts each match. No flowId travels, so a malformed delivery cannot force-run one. */

import log from 'electron-log';
import {
  extractFlowWebhookBindingFromGraph,
  matchesConditions,
  type WebhookEventData,
} from '../../../shared/lib/webhook-match';
import { getDatabase } from '../db';
import {
  getConnectionLifecycle,
  isPluginExecutionAllowed,
} from '../db/repos/plugin-connection-lifecycle';
import { listEnabledFlowGraphs } from './flow-trigger-scan';
import { startFlowRun } from './start';

const WEBHOOK_TRIGGER_BLOCK = 'webhook_trigger';

// `eventData` = normalized fields for condition matching; `rawPayload` = the raw
// provider webhook body that backs `{{trigger.payload.*}}`.
export type WebhookEventPayload = {
  integrationId: string;
  eventType: string;
  eventData: WebhookEventData;
  ownerExternalId?: string | null;
  deliveryId: string;
  rawPayload?: unknown;
};

/**
 * Build the trigger context stored on the flow run. Provider-agnostic: the raw
 * provider body (`fullContent`) backs `{{trigger.payload.*}}` via the shared
 * aliaser (`applyTriggerAliases` maps `{{trigger.payload}}` ← `fullContent`,
 * `{{trigger.event}}` ← `eventType`). Envelope metadata (`source`, `eventType`,
 * `triggeredBy`, `_frinkTrigger`) is kept for the task-executor / TriggerBubble.
 * The flat `eventData` feeds condition matching before the run starts (not here).
 */
function buildWebhookTriggerContext(args: {
  integrationId: string;
  eventType: string;
  eventData: WebhookEventData;
  deliveryId: string;
  fullContent: Record<string, unknown>;
}): Record<string, unknown> {
  const { integrationId, eventType, eventData, deliveryId, fullContent } = args;
  const externalUserId =
    typeof eventData.externalUserId === 'string' ? eventData.externalUserId : undefined;
  return {
    _frinkTrigger: WEBHOOK_TRIGGER_BLOCK,
    integrationId,
    eventType,
    deliveryId,
    source: typeof eventData.provider === 'string' ? eventData.provider : undefined,
    sourceAccountId: integrationId,
    timestamp: new Date().toISOString(),
    triggeredBy: externalUserId ? { externalUserId } : {},
    fullContent,
  };
}

const loggedFlowSkips = new Set<string>();

/**
 * Say why a flow did not run, once per (flow, event, reason): a stale binding shows up once rather
 * than on every delivery, and a flow rebound since then still reports a new reason.
 */
function logFlowSkipOnce(flowId: string, eventType: string, reason: string): void {
  const key = `${flowId}:${eventType}:${reason}`;
  if (loggedFlowSkips.has(key)) return;
  loggedFlowSkips.add(key);
  log.info('[WebhookTrigger] flow skipped', { flowId, eventType, reason });
}

/**
 * Match an already-verified webhook event against local flows and start each match. Returns counts
 * for observability. Never throws — a single flow's failure is logged and skipped.
 */
export async function handleVerifiedWebhookEvent(
  event: WebhookEventPayload,
): Promise<{ fired: number; replayed: number; skipped: number }> {
  const { integrationId, eventType, eventData, ownerExternalId, deliveryId, rawPayload } = event;
  // `{{trigger.payload}}` = the raw provider body. Same for every matched flow.
  const fullContent: Record<string, unknown> =
    rawPayload && typeof rawPayload === 'object' ? (rawPayload as Record<string, unknown>) : {};
  const db = getDatabase();

  // Mapped connections obey both account removal and plugin pause, including queued events.
  // A lookup failure must stop dispatch rather than treat the connection as unmanaged.
  const lifecycle = await getConnectionLifecycle(db, integrationId);
  if (
    lifecycle &&
    (lifecycle.lifecycleState !== 'active' ||
      !(await isPluginExecutionAllowed(db, lifecycle.pluginId)))
  ) {
    log.info('[WebhookTrigger] connection or plugin disabled — event dropped', {
      pluginId: lifecycle.pluginId,
    });
    return { fired: 0, replayed: 0, skipped: 0 };
  }
  const flowGraphs = await listEnabledFlowGraphs(db).catch((err) => {
    log.warn('[WebhookTrigger] listEnabledFlowGraphs failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  });

  let fired = 0;
  let replayed = 0;
  let skipped = 0;

  for (const { flow, graph } of flowGraphs) {
    const binding = extractFlowWebhookBindingFromGraph(graph, integrationId, eventType);
    if (!binding) {
      skipped += 1;
      logFlowSkipOnce(flow.id, eventType, 'no trigger in this flow is bound to this event');
      continue;
    }
    if (!matchesConditions(binding.conditions, eventData, ownerExternalId ?? undefined)) {
      skipped += 1;
      logFlowSkipOnce(flow.id, eventType, 'the event did not match the trigger filters');
      continue;
    }

    // flowId in the key so one event fanning out to N flows never collides;
    // deliveryId makes provider redelivery a replay (no second run).
    const idempotencyKey = `webhook:${integrationId}:${eventType}:${deliveryId}:${flow.id}`;
    try {
      const { isReplay } = await startFlowRun({
        flowId: flow.id,
        triggerContext: buildWebhookTriggerContext({
          integrationId,
          eventType,
          eventData,
          deliveryId,
          fullContent,
        }),
        idempotencyKey,
      });
      // Distinguish a real fan-out from a redelivery (same deliveryId) so the
      // counts don't read a redelivery storm as new runs.
      if (isReplay) replayed += 1;
      else fired += 1;
    } catch (err) {
      // startFlowRun throws on disabled / no-version — log and continue so other
      // matched flows still fire and the socket handler survives.
      log.warn('[WebhookTrigger] startFlowRun failed', {
        flowId: flow.id,
        err: err instanceof Error ? err.message : String(err),
      });
      skipped += 1;
    }
  }

  return { fired, replayed, skipped };
}
