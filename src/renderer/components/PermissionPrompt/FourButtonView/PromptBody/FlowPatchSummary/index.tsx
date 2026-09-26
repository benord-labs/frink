import type { ReactElement } from 'react';
import { isPlainObject } from '../../../../../../shared/lib/case-converter';
import { describeFlowNodeConfigChange } from '../../../../../../shared/lib/flows/flow-change-config-detail';
import { flowChangeStringValue } from '../../../../../../shared/lib/flows/flow-change-text';
import { flowPatchOperationShape } from '../../../../../../shared/lib/flows/flow-patch-operation-shape';

type ScopeKey = 'steps' | 'connections' | 'settings';

type TargetedSummary = {
  index: number;
  copy: string;
};

type FlowPatchCopy = {
  headline: string;
  targetedSummary?: string;
  scopeCopy?: string;
  consequence: string;
};

type StepUpdate = {
  label?: string;
  changedFields: string[];
};

const SCOPE_KEYS: ScopeKey[] = ['steps', 'connections', 'settings'];

function joinPhrases(phrases: string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? '';
  return `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}`;
}

function firstFlowString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const stringValue = flowChangeStringValue(value);
    if (stringValue) return stringValue.trim();
  }
  return undefined;
}

function configSummary(config: unknown): string | undefined {
  if (!isPlainObject(config)) return undefined;
  const details = describeFlowNodeConfigChange(config)
    .split(' · ')
    .map((detail) => detail.toLowerCase());
  return joinPhrases(details);
}

function parseStepUpdate(value: unknown): StepUpdate | undefined {
  if (!isPlainObject(value)) return undefined;
  if (firstFlowString(value.op) !== 'update_node') return undefined;

  const nestedLabel = isPlainObject(value.node) ? value.node.label : undefined;
  const label = firstFlowString(value.label, nestedLabel);
  const changedFields = [label ? 'step name' : undefined, configSummary(value.config)].filter(
    (field): field is string => Boolean(field),
  );

  return changedFields.length > 0 ? { label, changedFields } : undefined;
}

function stepUpdateCopy(update: StepUpdate): string {
  const target = update.label ? `“${update.label}”` : 'One step';
  return `${target}: ${joinPhrases(update.changedFields)} will change.`;
}

function findTargetedSummary(operations: unknown[]): TargetedSummary | undefined {
  for (const [index, operation] of operations.entries()) {
    const update = parseStepUpdate(operation);
    if (update) return { index, copy: stepUpdateCopy(update) };
  }
  return undefined;
}

function scopeKeyForOperation(value: unknown): ScopeKey | undefined {
  if (!isPlainObject(value)) return undefined;

  const kind = flowPatchOperationShape(value.op)?.kind;
  if (kind === 'node') return 'steps';
  if (kind === 'edge') return 'connections';
  if (kind === 'settings') return 'settings';
  return undefined;
}

function scopePhrase(key: ScopeKey, count: number): string | undefined {
  if (count === 0) return undefined;
  if (key === 'settings') return 'Flow settings';
  const singular = key === 'steps' ? 'step' : 'connection';
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function scopeSummary(operations: unknown[]): string {
  const counts: Record<ScopeKey, number> = { steps: 0, connections: 0, settings: 0 };
  for (const operation of operations) {
    const key = scopeKeyForOperation(operation);
    if (key) counts[key] += 1;
  }

  const phrases = SCOPE_KEYS.map((key) => scopePhrase(key, counts[key])).filter(
    (phrase): phrase is string => Boolean(phrase),
  );
  return joinPhrases(phrases);
}

function updateScopeCopy(
  targetedSummary: TargetedSummary | undefined,
  fullScope: string,
  remainingScope: string,
): string | undefined {
  if (!targetedSummary) return `Updates ${fullScope || 'the Flow definition'}.`;
  if (!remainingScope) return undefined;
  return `Also updates ${remainingScope}.`;
}

function flowPatchCopy(input: unknown): FlowPatchCopy {
  const record = isPlainObject(input) ? input : undefined;
  const name = firstFlowString(record?.name);
  const operations = Array.isArray(record?.operations) ? record.operations : [];
  const targeted = findTargetedSummary(operations);
  const remainingOperations = targeted
    ? operations.filter((_, index) => index !== targeted.index)
    : operations;
  const fullScope = scopeSummary(operations);

  if (name) {
    return {
      headline: `Create “${name}”?`,
      scopeCopy: `Adds ${fullScope || 'the Flow definition'}.`,
      consequence: 'Saves the Flow. The Flow will not run.',
    };
  }

  return {
    headline: 'Update this Flow?',
    targetedSummary: targeted?.copy,
    scopeCopy: updateScopeCopy(targeted, fullScope, scopeSummary(remainingOperations)),
    consequence: 'Saves a new version. The Flow will not run.',
  };
}

export function FlowPatchSummary({ input }: { input: unknown }): ReactElement {
  const copy = flowPatchCopy(input);

  return (
    <div className="min-w-0 space-y-0.5 [overflow-wrap:anywhere]">
      <strong className="block text-xs font-semibold leading-4 text-foreground">
        {copy.headline}
      </strong>
      {copy.targetedSummary ? (
        <span className="block text-xs leading-4 text-foreground">{copy.targetedSummary}</span>
      ) : null}
      {copy.scopeCopy ? (
        <span className="block text-xs leading-4 text-foreground">{copy.scopeCopy}</span>
      ) : null}
      <span className="block text-[10px] leading-4 text-muted-foreground">{copy.consequence}</span>
    </div>
  );
}
