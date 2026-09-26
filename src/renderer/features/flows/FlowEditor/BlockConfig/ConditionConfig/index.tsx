/**
 * Condition block: predicate editor with operator-aware value input.
 * Shows loop settings when the condition node has a back-edge (isLoopCondition).
 */

import { Input } from '@benord-labs/frink-primitives';
import { RotateCcw } from 'lucide-react';
import type { ReactElement } from 'react';
import type { FlowNode } from '../../../../../../shared/lib/validate-flow-graph';
import {
  CONDITION_OPERATORS,
  type ConditionLoopConfig,
  type ConditionOperator,
  type ConditionPredicate,
} from '../../../../../../shared/types/flow';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../../components/ui/select';
import { cfg, FieldRow } from '../shared';

const LOOP_MAX_ITERATIONS_DEFAULT = 10;
const LOOP_MAX_ITERATIONS_CAP = 50;

type Props = {
  node: FlowNode;
  /** True when this condition node has at least one back-edge (loop). */
  isLoopCondition: boolean;
  onPatchLabel: (patch: { label?: string }) => void;
  onConfigPatch: (config: Record<string, unknown>) => void;
};

const CONDITION_OPERATOR_LABELS: Record<ConditionOperator, string> = {
  eq: 'Equals',
  neq: 'Does not equal',
  contains: 'Contains',
  gt: 'Greater than (numeric)',
  gte: 'Greater than or equal (numeric)',
  lt: 'Less than (numeric)',
  lte: 'Less than or equal (numeric)',
  truthy: 'Is truthy',
  falsy: 'Is falsy',
};

function defaultPredicate(): ConditionPredicate {
  return { field: '', operator: 'eq', value: '' };
}

function defaultLoopConfig(): ConditionLoopConfig {
  return { maxIterations: LOOP_MAX_ITERATIONS_DEFAULT, onMaxReached: 'fail' };
}

function clampLoopMaxIterations(value: number): number {
  return Math.max(1, Math.min(value, LOOP_MAX_ITERATIONS_CAP));
}

function readLoopConfig(node: FlowNode): ConditionLoopConfig {
  const raw = cfg(node).loop;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultLoopConfig();
  const o = raw as Record<string, unknown>;
  const mi = o.maxIterations;
  const maxIterations =
    typeof mi === 'number' && Number.isFinite(mi)
      ? clampLoopMaxIterations(Math.trunc(mi))
      : LOOP_MAX_ITERATIONS_DEFAULT;
  const onMaxReached = o.onMaxReached === 'continue' ? 'continue' : 'fail';
  return { maxIterations, onMaxReached };
}

function readPredicate(node: FlowNode): ConditionPredicate {
  const raw = cfg(node).predicate;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultPredicate();
  const o = raw as Record<string, unknown>;
  const field = typeof o.field === 'string' ? o.field : '';
  const op =
    typeof o.operator === 'string' &&
    (CONDITION_OPERATORS as readonly string[]).includes(o.operator)
      ? (o.operator as ConditionOperator)
      : 'eq';
  const value = o.value;
  return { field, operator: op, value };
}

function setPredicate(
  onConfigPatch: (config: Record<string, unknown>) => void,
  next: ConditionPredicate,
): void {
  const { operator } = next;
  if (operator === 'truthy' || operator === 'falsy') {
    const { field, operator: op } = next;
    onConfigPatch({ predicate: { field, operator: op } });
    return;
  }
  onConfigPatch({ predicate: next });
}

const NUMERIC_OPS = new Set<string>(['gt', 'gte', 'lt', 'lte']);

export function ConditionConfig({
  node,
  isLoopCondition,
  onPatchLabel,
  onConfigPatch,
}: Props): ReactElement {
  const p = readPredicate(node);
  const loop = readLoopConfig(node);
  const fieldErr =
    p.field.trim() === '' ? 'Field path is required (e.g. status or outputs.result).' : null;
  const showValue = p.operator !== 'truthy' && p.operator !== 'falsy';
  const numeric = NUMERIC_OPS.has(p.operator);

  const valueStr = p.value == null ? '' : String(p.value);

  function patchLoop(update: Partial<ConditionLoopConfig>): void {
    const next: ConditionLoopConfig = { ...loop, ...update };
    if (
      update.maxIterations !== undefined &&
      typeof update.maxIterations === 'number' &&
      Number.isFinite(update.maxIterations)
    ) {
      next.maxIterations = clampLoopMaxIterations(Math.trunc(update.maxIterations));
    }
    onConfigPatch({ loop: next });
  }

  return (
    <div className="space-y-4">
      <FieldRow htmlFor="flow-condition-label" label="Display name" hint="Shown in the step list.">
        <Input
          id="flow-condition-label"
          value={node.label ?? ''}
          onChange={(e) => onPatchLabel({ label: e.target.value })}
          placeholder="Condition"
        />
      </FieldRow>
      <FieldRow
        htmlFor="flow-cond-field"
        label="Field path"
        hint="Previous node output: use status, or outputs.&lt;key&gt; (dot paths supported)."
        error={fieldErr}
      >
        <Input
          id="flow-cond-field"
          value={p.field}
          onChange={(e) => setPredicate(onConfigPatch, { ...p, field: e.target.value })}
          placeholder="status"
          error={!!fieldErr}
        />
      </FieldRow>
      <FieldRow htmlFor="flow-cond-op" label="Operator">
        <Select
          value={p.operator}
          onValueChange={(v) => {
            const op = v as ConditionOperator;
            if (op === 'truthy' || op === 'falsy') {
              setPredicate(onConfigPatch, { field: p.field, operator: op });
            } else if (NUMERIC_OPS.has(op)) {
              const n = Number(valueStr);
              setPredicate(onConfigPatch, {
                field: p.field,
                operator: op,
                value: Number.isNaN(n) ? 0 : n,
              });
            } else {
              setPredicate(onConfigPatch, { field: p.field, operator: op, value: valueStr });
            }
          }}
        >
          <SelectTrigger id="flow-cond-op" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONDITION_OPERATORS.map((op) => (
              <SelectItem key={op} value={op}>
                {CONDITION_OPERATOR_LABELS[op]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      {showValue ? (
        <FieldRow
          htmlFor="flow-cond-val"
          label="Compare value"
          hint={numeric ? 'Numeric comparison uses JavaScript Number().' : undefined}
        >
          {numeric ? (
            <Input
              id="flow-cond-val"
              type="number"
              value={valueStr}
              onChange={(e) => {
                const n = e.target.value === '' ? 0 : Number(e.target.value);
                setPredicate(onConfigPatch, {
                  field: p.field,
                  operator: p.operator,
                  value: Number.isNaN(n) ? 0 : n,
                });
              }}
            />
          ) : (
            <Input
              id="flow-cond-val"
              value={valueStr}
              onChange={(e) =>
                setPredicate(onConfigPatch, {
                  field: p.field,
                  operator: p.operator,
                  value: e.target.value,
                })
              }
              placeholder="Value"
            />
          )}
        </FieldRow>
      ) : null}

      {isLoopCondition ? (
        <div className="space-y-3 rounded-md border border-primary/25 bg-primary/5 p-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-primary/80">
            <RotateCcw className="h-3 w-3" aria-hidden />
            Loop settings
          </div>
          <FieldRow
            htmlFor="flow-cond-max-iter"
            label="Max iterations"
            hint={`How many times the loop body may run before stopping (1–${LOOP_MAX_ITERATIONS_CAP}). Values are clamped to this range.`}
          >
            <Input
              id="flow-cond-max-iter"
              type="number"
              min={1}
              max={LOOP_MAX_ITERATIONS_CAP}
              value={loop.maxIterations}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (!Number.isNaN(n)) patchLoop({ maxIterations: n });
              }}
            />
          </FieldRow>
          <FieldRow
            htmlFor="flow-cond-on-max"
            label="When limit reached"
            hint="Fail stops the flow run; continue follows the non-looping exit path."
          >
            <Select
              value={loop.onMaxReached}
              onValueChange={(v) => patchLoop({ onMaxReached: v as 'fail' | 'continue' })}
            >
              <SelectTrigger id="flow-cond-on-max" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fail">Fail the flow run</SelectItem>
                <SelectItem value="continue">Continue (exit loop)</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
        </div>
      ) : null}
    </div>
  );
}
