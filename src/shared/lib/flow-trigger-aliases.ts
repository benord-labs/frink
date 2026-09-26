/**
 * Map stored trigger-context fields to the documented template aliases so
 * `{{trigger.event}}` ← `eventType` and `{{trigger.payload}}` ← `fullContent`.
 *
 * Single source of truth for the flow builder in
 * `src/main/lib/flows/block-context.ts` (`buildVariables`).
 */
export function applyTriggerAliases(
  rawTrigger: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const trigger: Record<string, unknown> = { ...(rawTrigger ?? {}) };
  const eventAlias = trigger.event ?? trigger.eventType;
  const payloadAlias = trigger.payload ?? trigger.fullContent;
  if (eventAlias !== undefined) trigger.event = eventAlias;
  if (payloadAlias !== undefined) trigger.payload = payloadAlias;
  return trigger;
}
