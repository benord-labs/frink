import { z } from 'zod';
import { canonicalStringify } from '../../../../shared/lib/canonical-stringify';
import { flowNodeConfigLabel } from '../../../../shared/lib/flows/flow-change-config-detail';
import {
  formatModelPickerLabel,
  resolveModelPickerItemById,
} from '../../../../shared/lib/model-picker-label';
import type { FlowNode } from '../../../../shared/lib/validate-flow-graph';
import { diffText, type TextDiff } from './text-diff';

export type TextFieldChange = {
  kind: 'text';
  label: string;
  diff: TextDiff;
  before: string;
  after: string;
  showPreview: boolean;
};

export type StepFieldChange =
  | TextFieldChange
  | { kind: 'value'; label: string; before: string; after: string }
  | { kind: 'label'; label: string };

/** Long-form fields shown as a word diff. */
const TEXT_KEYS = new Set([
  'instructions',
  'agentInstructions',
  'messageTemplate',
  'message',
  'command',
  'predicate',
  'description',
]);
/** Short settings whose values are safe to show as old → new. Every other key shows its label only. */
const VALUE_KEYS = new Set([
  'model',
  'startMode',
  'branch',
  'timezone',
  'cronExpression',
  'maxIterations',
  'maxParallel',
  'mode',
  'fireAndForget',
  'startInWorktree',
  'skipIfRunning',
  'label',
  'method',
]);
const KIND_ORDER: Record<StepFieldChange['kind'], number> = { text: 0, value: 1, label: 2 };
const NOT_SET = 'Not set';

/** A missing text field reads as empty, so adding instructions diffs against nothing. */
/** An empty string and a missing key read the same, so switching between them is not a change. */
const EMPTY_VALUE = z.union([z.literal(''), z.null(), z.undefined()]);
const TEXT_VALUE = z
  .string()
  .nullish()
  .transform((text) => text ?? '');
/** Scalars render as words a non-developer reads; anything structured has no display value. */
const DISPLAY_VALUE = z.union([
  z.boolean().transform((on) => (on ? 'On' : 'Off')),
  z.number().transform(String),
  z
    .string()
    .nullish()
    .transform((text) => text || NOT_SET),
]);

function friendlyValue(key: string, value: string): string {
  const model = key === 'model' ? resolveModelPickerItemById(value) : null;
  return model ? formatModelPickerLabel(model.item) : value;
}

type FieldInput = { key: string; label: string; before: FlowNode; after: FlowNode };
type FieldResult = StepFieldChange | undefined;

function textChange({ key, label, before, after }: FieldInput): FieldResult {
  const beforeText = TEXT_VALUE.safeParse(before.config?.[key]);
  const afterText = TEXT_VALUE.safeParse(after.config?.[key]);
  if (!beforeText.success || !afterText.success) return { kind: 'label', label };
  if (beforeText.data === afterText.data) return undefined;
  return {
    kind: 'text',
    label,
    diff: diffText(beforeText.data, afterText.data),
    before: beforeText.data,
    after: afterText.data,
    // A command line can carry a token, so it shows only once the user expands it.
    showPreview: key !== 'command',
  };
}

function valueChange({ key, label, before, after }: FieldInput): FieldResult {
  const beforeValue = DISPLAY_VALUE.safeParse(before.config?.[key]);
  const afterValue = DISPLAY_VALUE.safeParse(after.config?.[key]);
  if (!beforeValue.success || !afterValue.success) return { kind: 'label', label };
  if (beforeValue.data === afterValue.data) return undefined;
  return {
    kind: 'value',
    label,
    before: friendlyValue(key, beforeValue.data),
    after: friendlyValue(key, afterValue.data),
  };
}

/** The row for one changed key, or undefined when both sides read the same (an empty value vs none). */
function fieldChange(input: FieldInput): FieldResult {
  const { key, before, after } = input;
  const bothEmpty =
    EMPTY_VALUE.safeParse(before.config?.[key]).success &&
    EMPTY_VALUE.safeParse(after.config?.[key]).success;
  if (bothEmpty) return undefined;
  if (TEXT_KEYS.has(key)) return textChange(input);
  return VALUE_KEYS.has(key) ? valueChange(input) : { kind: 'label', label: input.label };
}

function isDisplayedKey(key: string): boolean {
  return TEXT_KEYS.has(key) || VALUE_KEYS.has(key);
}

/** Field rows for one step, one per user-facing label, with display-safe keys claiming it first. */
export function stepFieldChanges(before: FlowNode, after: FlowNode): StepFieldChange[] {
  const rows: StepFieldChange[] = [];
  if ((before.label ?? '') !== (after.label ?? '')) {
    rows.push({
      kind: 'value',
      label: 'Step name',
      before: before.label || NOT_SET,
      after: after.label || NOT_SET,
    });
  }
  const beforeConfig = before.config ?? {};
  const afterConfig = after.config ?? {};
  const keys = [...new Set([...Object.keys(beforeConfig), ...Object.keys(afterConfig)])].sort(
    (a, b) => Number(isDisplayedKey(b)) - Number(isDisplayedKey(a)),
  );
  const labels = new Set<string>();
  for (const key of keys) {
    if (canonicalStringify(beforeConfig[key]) === canonicalStringify(afterConfig[key])) continue;
    const label = flowNodeConfigLabel(key) ?? 'Other step setup';
    const row = labels.has(label) ? undefined : fieldChange({ key, label, before, after });
    if (!row) continue;
    labels.add(label);
    rows.push(row);
  }
  return rows.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}
