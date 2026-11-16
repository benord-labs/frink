/**
 * Webhook event matcher — pure condition matching for local-first flow triggers.
 *
 * matching moved off Vercel (which matched against the now-empty cloud
 * `flow_versions`) onto the machine, where local flow graphs live. Vercel still
 * runs the provider extractors (`detectEventType` + `buildEventData`) and forwards
 * the normalized `WebhookEventData`; the machine matches it against the
 * `webhook_trigger` node in each local flow graph.
 *
 * Pure (no DB, no IO) so it's unit-testable and importable by the Electron main
 * process. The shape here is the cross-boundary contract; keep it in sync with
 * `src/shared/webhooks/extractors/types.ts`, which the provider extractors produce.
 */

import { z } from 'zod';
import type { FlowNode } from './validate-flow-graph';

// Event data produced by a provider extractor and forwarded from the cloud.
export type WebhookEventData = {
  eventType: string;
  provider: string;
  externalUserId: string;
  // Event-specific fields for condition matching (storyName, owner_ids, …).
  [key: string]: unknown;
};

export const WEBHOOK_FILTER_OPERATORS = ['equals', 'not_equals', 'contains', 'in_list'] as const;

/** A filter as the webhook-trigger editor persists it; anything else never matches. */
export const webhookFilterSchema = z.object({
  field: z.string(),
  operator: z.enum(WEBHOOK_FILTER_OPERATORS),
  value: z.union([z.string(), z.array(z.string())]),
});

type WebhookFilter = z.infer<typeof webhookFilterSchema>;

const MAX_NAMED_FILTERS = 5;

const storedFiltersSchema = z.object({ filters: z.unknown() });

/** Why the matcher can never pass this stored filter, or null when it can. */
function filterProblem(parsed: z.ZodSafeParseResult<WebhookFilter>): string | null {
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue?.path[0];
    if (key === 'operator') {
      const op = z.string().safeParse(issue?.input);
      return op.success ? `unknown operator '${op.data}'` : 'no operator';
    }
    if (key === 'value') return 'value must be text or a list of text';
    if (key === 'field') return 'no field';
    return 'not a filter';
  }
  const { operator, value } = parsed.data;
  if (operator === 'in_list') {
    if (!Array.isArray(value)) return 'in_list needs a list value';
    return value.length > 0 ? null : 'in_list needs at least one value';
  }
  return Array.isArray(value) ? `${operator} needs a text value, not a list` : null;
}

/** A save-time warning naming the stored filters that block every event, or null when none do. */
export function unreadableWebhookFilterMessage(
  nodeLabel: string,
  config: FlowNode['config'],
): string | null {
  const stored = storedFiltersSchema.safeParse(config?.conditions);
  if (!stored.success || stored.data.filters === undefined) return null;
  const list = z.array(z.unknown()).safeParse(stored.data.filters);
  if (!list.success) {
    return `Webhook trigger "${nodeLabel}" filters must be a list, so this trigger will never start. Fix or remove them.`;
  }
  const bad = list.data.flatMap((entry, i) => {
    const problem = filterProblem(webhookFilterSchema.safeParse(entry, { reportInput: true }));
    return problem ? [`filter ${i + 1} (${problem})`] : [];
  });
  if (bad.length === 0) return null;
  const more = bad.length > MAX_NAMED_FILTERS ? ` and ${bad.length - MAX_NAMED_FILTERS} more` : '';
  return `Webhook trigger "${nodeLabel}" ${bad.slice(0, MAX_NAMED_FILTERS).join(', ')}${more} can't match any event, so this trigger will never start. Fix or remove ${bad.length === 1 ? 'it' : 'them'}.`;
}

function isRepoFullNameField(field: string): boolean {
  return field === 'repo_full_name';
}

function stringEqualsForField(field: string, left: unknown, right: unknown): boolean {
  if (isRepoFullNameField(field) && typeof left === 'string' && typeof right === 'string') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

/**
 * Check whether event data satisfies a webhook_trigger's conditions.
 * Supports state transitions (from_status / to_status), assignee me/anyone,
 * a `filters` array of custom conditions, and legacy direct-field matching.
 */
export function matchesConditions(
  conditions: Record<string, unknown>,
  eventData: WebhookEventData,
  userExternalId?: string,
): boolean {
  // Empty conditions = match all events of this type.
  if (!conditions || Object.keys(conditions).length === 0) {
    return true;
  }

  // State transition conditions (from_status / to_status).
  if (conditions.from_status) {
    const actualFromStatus = eventData.oldStatus || eventData.old_status;
    if (actualFromStatus !== conditions.from_status) {
      return false;
    }
  }

  if (conditions.to_status) {
    const actualToStatus = eventData.newStatus || eventData.new_status || eventData.status;
    if (actualToStatus !== conditions.to_status) {
      return false;
    }
  }

  // Assignee condition.
  if (conditions.assignee) {
    const ownerIds = eventData.owner_ids || eventData.ownerIds;
    const assigneeIds = Array.isArray(ownerIds) ? ownerIds : ownerIds ? [ownerIds] : [];

    if (conditions.assignee === 'me') {
      // Must be assigned to the integration owner.
      if (!userExternalId || !assigneeIds.includes(userExternalId)) {
        return false;
      }
    } else if (conditions.assignee === 'anyone') {
      // Must have at least one assignee.
      if (assigneeIds.length === 0) {
        return false;
      }
    }
    // 'specific' would need assignee_id checked - not implemented yet.
  }

  // Custom filter conditions. A malformed persisted filter fails closed: it never matches.
  if ('filters' in conditions) {
    const parsedFilters = z.array(webhookFilterSchema).safeParse(conditions.filters);
    if (!parsedFilters.success) return false;
    for (const filter of parsedFilters.data) {
      const actualValue = eventData[filter.field];
      // An array field (labels) matches when any element does.
      const candidates = Array.isArray(actualValue) ? actualValue : [actualValue];
      const text = Array.isArray(filter.value) ? null : filter.value;

      switch (filter.operator) {
        case 'equals':
          if (
            text === null ||
            !candidates.some((v) => stringEqualsForField(filter.field, v, text))
          ) {
            return false;
          }
          break;
        case 'not_equals':
          if (
            text === null ||
            candidates.some((v) => stringEqualsForField(filter.field, v, text))
          ) {
            return false;
          }
          break;
        case 'contains': {
          const needle = text?.toLowerCase();
          if (
            needle === undefined ||
            !candidates.some((v) => {
              const candidate = z.string().safeParse(v);
              return candidate.success && candidate.data.toLowerCase().includes(needle);
            })
          ) {
            return false;
          }
          break;
        }
        case 'in_list': {
          const actual = z.string().safeParse(actualValue);
          if (text !== null || !actual.success || !filter.value.includes(actual.data)) {
            return false;
          }
          break;
        }
      }
    }
  }

  // Legacy condition format (direct field matching).
  for (const [key, expectedValue] of Object.entries(conditions)) {
    if (['from_status', 'to_status', 'assignee', 'assignee_id', 'filters'].includes(key)) {
      continue;
    }

    const actualValue = eventData[key];

    if (key.endsWith('_contains')) {
      const field = key.replace('_contains', '');
      const fieldValue = eventData[field];
      if (typeof fieldValue !== 'string' || typeof expectedValue !== 'string') {
        return false;
      }
      if (!fieldValue.toLowerCase().includes(expectedValue.toLowerCase())) {
        return false;
      }
    } else if (key.endsWith('_in')) {
      const field = key.replace('_in', '');
      const fieldValue = eventData[field];
      if (!Array.isArray(expectedValue) || !expectedValue.includes(fieldValue)) {
        return false;
      }
    } else if (Array.isArray(expectedValue)) {
      if (!Array.isArray(actualValue)) {
        if (!expectedValue.includes(actualValue)) {
          return false;
        }
      } else {
        const hasMatch = expectedValue.some((v) => actualValue.includes(v));
        if (!hasMatch) {
          return false;
        }
      }
    } else {
      if (!stringEqualsForField(key, actualValue, expectedValue)) {
        return false;
      }
    }
  }

  return true;
}

export type WebhookBinding = {
  conditions: Record<string, unknown>;
  actionConfig: Record<string, unknown>;
};

/**
 * Find the `webhook_trigger` node in a flow graph whose config matches the
 * incoming integration + event, returning its stored conditions and optional
 * actionConfig. Returns null when no node matches.
 */
export function extractFlowWebhookBindingFromGraph(
  graph: unknown,
  integrationId: string,
  eventType: string,
): WebhookBinding | null {
  if (!graph || typeof graph !== 'object') return null;
  const nodes = (graph as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return null;
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    const node = n as Record<string, unknown>;
    if (node.blockType !== 'webhook_trigger') continue;
    const config = node.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
    const c = config as Record<string, unknown>;
    const iid = c.integrationId;
    const et = c.eventType;
    if (typeof iid !== 'string' || typeof et !== 'string') continue;
    if (iid !== integrationId || et !== eventType) continue;
    const conditions = c.conditions;
    const actionConfig = c.actionConfig;
    return {
      conditions:
        conditions && typeof conditions === 'object' && !Array.isArray(conditions)
          ? (conditions as Record<string, unknown>)
          : {},
      actionConfig:
        actionConfig && typeof actionConfig === 'object' && !Array.isArray(actionConfig)
          ? (actionConfig as Record<string, unknown>)
          : {},
    };
  }
  return null;
}
