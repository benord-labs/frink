/**
 * Condition node predicate evaluation. Pure — no DB / IO.
 */

import {
  CONDITION_OPERATORS,
  CONDITION_TRUE_RESULT,
  type ConditionOperator,
  type ConditionPredicate,
  type NodeOutput,
} from '../../../shared/types/flow';

function isConditionOperator(value: unknown): value is ConditionOperator {
  return typeof value === 'string' && (CONDITION_OPERATORS as readonly string[]).includes(value);
}

type ParseConditionPredicateResult =
  | { ok: true; predicate: ConditionPredicate }
  | { ok: false; reason: 'missing' | 'invalid' };

export function parseConditionPredicate(raw: unknown): ParseConditionPredicateResult {
  if (raw === null || raw === undefined) return { ok: false, reason: 'missing' };
  if (typeof raw !== 'object') return { ok: false, reason: 'missing' };
  if (Array.isArray(raw)) return { ok: false, reason: 'invalid' };
  const o = raw as Record<string, unknown>;
  if (typeof o.field !== 'string' || o.field.trim() === '' || !isConditionOperator(o.operator)) {
    return { ok: false, reason: 'invalid' };
  }
  return {
    ok: true,
    predicate: { field: o.field.trim(), operator: o.operator, value: o.value },
  };
}

type ConditionResult = typeof CONDITION_TRUE_RESULT | 'stop';

function getByPath(obj: unknown, path: string): unknown {
  if (!path || !obj || typeof obj !== 'object') return undefined;
  const parts = path.split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function resolveField(field: string, previousOutput: NodeOutput | undefined): unknown {
  if (!previousOutput) return undefined;
  if (field === 'status') return previousOutput.status;
  if (field.startsWith('outputs.')) {
    return getByPath(previousOutput.outputs, field.slice('outputs.'.length));
  }
  return getByPath(previousOutput.outputs, field);
}

function numericCompare(
  op: 'gt' | 'gte' | 'lt' | 'lte',
  left: unknown,
  right: unknown,
): boolean | null {
  const a = Number(left);
  const b = Number(right);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  switch (op) {
    case 'gt':
      return a > b;
    case 'gte':
      return a >= b;
    case 'lt':
      return a < b;
    case 'lte':
      return a <= b;
  }
}

/**
 * `continue` when predicate passes; `stop` when it fails or unsafe (fail-safe).
 */
export function evaluateCondition(
  predicate: ConditionPredicate,
  previousOutput: NodeOutput | undefined,
): ConditionResult {
  const resolved = resolveField(predicate.field, previousOutput);
  if (resolved === undefined && predicate.operator !== 'truthy' && predicate.operator !== 'falsy') {
    return 'stop';
  }
  const { operator, value: expected } = predicate;
  let passes = false;
  switch (operator) {
    case 'eq':
      passes = resolved === expected;
      break;
    case 'neq':
      passes = resolved !== expected;
      break;
    case 'contains':
      if (typeof resolved === 'string' && typeof expected === 'string') {
        passes = resolved.includes(expected);
      } else if (Array.isArray(resolved)) {
        passes = resolved.includes(expected);
      } else {
        passes = false;
      }
      break;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const cmp = numericCompare(operator, resolved, expected);
      if (cmp === null) return 'stop';
      passes = cmp;
      break;
    }
    case 'truthy':
      passes = !!resolved;
      break;
    case 'falsy':
      passes = !resolved;
      break;
    default:
      return 'stop';
  }
  return passes ? CONDITION_TRUE_RESULT : 'stop';
}
