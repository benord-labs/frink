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

/** The assignee mode a new rule starts on: a Shortcut story event starts on anyone, every other event on me. */
export function defaultWebhookAssignee(eventType: string): 'anyone' | 'me' {
  return eventType === 'story_assigned' || eventType === 'story_created' ? 'anyone' : 'me';
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
