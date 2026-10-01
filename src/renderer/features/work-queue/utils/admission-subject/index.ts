import { buildTriggerSummary } from '../../../../../shared/lib/trigger-summary';
import type { TriggerContext } from '../../../../../shared/types/trigger-context';
import { parseTriggerContext } from '../trigger-context';

// A batch member's trigger_context is its batch item, arbitrary data that can look like a webhook
// envelope; only a non-batch run's context is read as a trigger.
export function admissionTrigger(
  raw: Record<string, unknown> | null,
  isBatchMember: boolean,
): TriggerContext | null {
  return isBatchMember ? null : parseTriggerContext(raw);
}

// A queued run's one-line subject: a batch member's item label, else its webhook trigger's summary
// title. Null for starts that carry nothing recognisable (manual, schedule, post-task).
export function admissionSubject(
  raw: Record<string, unknown> | null,
  isBatchMember: boolean,
): string | null {
  if (isBatchMember) return typeof raw?.label === 'string' && raw.label.trim() ? raw.label : null;
  const triggerContext = admissionTrigger(raw, false);
  return triggerContext ? buildTriggerSummary(triggerContext).title?.trim() || null : null;
}
