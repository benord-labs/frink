/**
 * Pure pack logic for webhook_trigger `config.conditions` (mirrors the editor's webhook trigger condition form).
 * Kept in shared so editor and unit tests share one implementation.
 */

export type WebhookConditionFilterForPack = {
  field: string;
  operator: string;
  /** A list is what in_list stores; it passes through untouched. */
  value: string | string[];
};

const STARTS_ON_ANYONE = new Set(['story_assigned', 'story_created', 'task_assignee_changed']);

/** The assignee mode a rule starts on, new or stored without one: anyone for those events, me
 * otherwise. An event that gains the choice later starts on anyone, or its saved rules narrow. */
export function defaultWebhookAssignee(eventType: string): 'anyone' | 'me' {
  return STARTS_ON_ANYONE.has(eventType) ? 'anyone' : 'me';
}

export function packWebhookTriggerConditions(o: {
  supportsStateTransition: boolean;
  supportsAssignee: boolean;
  fromStatus: string;
  toStatus: string;
  assigneeMode: string;
  filters: WebhookConditionFilterForPack[];
}): Record<string, unknown> {
  const conditions: Record<string, unknown> = {};
  if (o.supportsStateTransition) {
    if (o.fromStatus) conditions.from_status = o.fromStatus;
    if (o.toStatus) conditions.to_status = o.toStatus;
  }
  if (o.supportsAssignee) {
    conditions.assignee = o.assigneeMode;
  }
  if (o.filters.length > 0) {
    const packedFilters = o.filters
      .map((f) => {
        const field = typeof f.field === 'string' ? f.field.trim() : '';
        const value = Array.isArray(f.value) ? f.value : f.value.trim();
        if (!field || value.length === 0) return null;
        return {
          field,
          operator: field === 'repo_full_name' ? 'equals' : f.operator,
          value,
        };
      })
      .filter((f): f is NonNullable<typeof f> => f !== null);
    if (packedFilters.length > 0) {
      conditions.filters = packedFilters;
    }
  }
  return conditions;
}
