import { z } from 'zod';
import { TRIGGER_FIELD_ALIASES } from '../../../../shared/integrations/trigger-field-aliases';
import { TRIGGER_SAMPLES } from '../../../../shared/integrations/trigger-samples';
import { describeTriggerField, TRIGGER_SCHEMAS } from '../../../../shared/lib/output-schemas';
import type { JsonValue } from '../../../../shared/types/permissions';

type DetailSuggestion = { value: string; label: string };

export type RunFirstDetails = { suggestions: DetailSuggestion[]; noDetails: boolean };

/** A trigger detail path is at most five segments, `trigger` included. */
const MAX_PATH_SEGMENTS = 5;
const MAX_SUGGESTIONS = 40;
const SAMPLE_LEAF = z.union([z.string(), z.number(), z.boolean()]);

const POST_TASK_DETAILS: DetailSuggestion[] = (TRIGGER_SCHEMAS.post_task_trigger ?? []).map(
  (field) => ({ value: `trigger.${field.key}`, label: describeTriggerField(field) }),
);

/** Every text, number or true/false value in a sample body, labelled with its sample value. */
function sampleLeaves(value: JsonValue, path: string, out: DetailSuggestion[]): void {
  if (value === null || out.length >= MAX_SUGGESTIONS) return;
  const leaf = SAMPLE_LEAF.safeParse(value);
  if (leaf.success) {
    out.push({ value: path, label: `e.g. ${String(leaf.data).slice(0, 60)}` });
    return;
  }
  if (path.split('.').length >= MAX_PATH_SEGMENTS) return;
  const entries = Array.isArray(value)
    ? value.slice(0, 1).map((v, i) => [String(i), v] as const)
    : Object.entries(value);
  for (const [key, child] of entries) sampleLeaves(child, `${path}.${key}`, out);
}

function webhookDetails(
  provider: string | undefined,
  eventType: string | undefined,
): DetailSuggestion[] {
  if (!provider) return [];
  const aliases = (TRIGGER_FIELD_ALIASES[provider] ?? []).map((a) => ({
    value: `trigger.${a.alias}`,
    label: a.label,
  }));
  const sample = eventType ? TRIGGER_SAMPLES[provider]?.[eventType] : undefined;
  const leaves: DetailSuggestion[] = [];
  if (sample) sampleLeaves(sample, 'trigger.payload', leaves);
  return [...aliases, ...leaves];
}

/** What "Only runs that match" can check for a Flow's trigger, and whether its runs carry nothing to check. */
export function runFirstDetails(args: {
  triggerBlockType: string | undefined;
  provider?: string;
  eventType?: string;
  batchKeys?: readonly string[];
}): RunFirstDetails {
  switch (args.triggerBlockType) {
    case 'schedule_trigger':
      return { suggestions: [], noDetails: true };
    case 'post_task_trigger':
      return { suggestions: POST_TASK_DETAILS, noDetails: false };
    case 'webhook_trigger':
      return { suggestions: webhookDetails(args.provider, args.eventType), noDetails: false };
    default:
      return {
        suggestions: (args.batchKeys ?? []).map((key) => ({ value: `trigger.${key}`, label: key })),
        noDetails: false,
      };
  }
}
