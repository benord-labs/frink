import { z } from 'zod';
import { eventSupportsAssignee } from '../../../../shared/integrations/selectors';
import { defaultWebhookAssignee } from '../../../../shared/lib/webhook-trigger-condition-pack';
import { STATE_TRANSITION_EVENTS } from './constants';
import type { AssigneeMode, ConditionFilter } from './types';

const storedFilterSchema = z.object({
  field: z.string(),
  operator: z.enum(['equals', 'not_equals', 'contains', 'in_list']),
  value: z.union([z.string(), z.array(z.string())]),
});

/** What a webhook_trigger node stores under `config.conditions`; a malformed field falls back to its default instead of failing the whole parse. */
const storedConditionsSchema = z.object({
  assignee: z.enum(['me', 'anyone', 'specific']).optional().catch(undefined),
  from_status: z.string().optional().catch(undefined),
  to_status: z.string().optional().catch(undefined),
  filters: z.array(z.unknown()).optional().catch(undefined),
});

/** The stored shape as it arrives from node config, before any field is validated. */
export type StoredWebhookConditions = z.input<typeof storedConditionsSchema>;

export type WebhookTriggerFormState = {
  assigneeMode: AssigneeMode;
  fromStatus: string;
  toStatus: string;
  filters: ConditionFilter[];
};

/** Parse stored webhook_trigger conditions back to the editor's form state. */
export function parseConditions(
  conditions: StoredWebhookConditions,
  eventType: string,
  providerId: string,
): WebhookTriggerFormState {
  const stored = storedConditionsSchema.safeParse(conditions);
  const c = stored.success ? stored.data : {};
  const supportsStateTransition = STATE_TRANSITION_EVENTS.includes(eventType);
  const supportsAssignee = eventSupportsAssignee(providerId, eventType);

  const filters: ConditionFilter[] = [];
  for (const entry of c.filters ?? []) {
    const filter = storedFilterSchema.safeParse(entry);
    if (filter.success) filters.push({ id: crypto.randomUUID(), ...filter.data });
  }

  return {
    assigneeMode: supportsAssignee && c.assignee ? c.assignee : defaultWebhookAssignee(eventType),
    fromStatus: supportsStateTransition ? c.from_status || '' : '',
    toStatus: supportsStateTransition ? c.to_status || '' : '',
    filters,
  };
}
