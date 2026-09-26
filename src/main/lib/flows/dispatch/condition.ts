/**
 * Condition block — evaluates a predicate against the previous node's output.
 * Returns 'continue' or 'stop' as the result.value so advanceFlowRun can pick
 * the labelled outgoing edge.
 */

import { CONDITION_TRUE_RESULT } from '../../../../shared/types/flow';
import { evaluateCondition, parseConditionPredicate } from '../condition-eval';
import type { Dispatcher } from './types';

export const dispatchCondition: Dispatcher = async (ctx) => {
  const config = (ctx.node.config ?? {}) as { predicate?: unknown };
  const parsed = parseConditionPredicate(config.predicate);
  if (!parsed.ok) {
    return {
      type: 'error',
      message: `Condition node missing predicate (${parsed.reason})`,
    };
  }

  const result = evaluateCondition(parsed.predicate, ctx.previousOutput);
  // Pass through upstream outputs so {{previous.<upstreamField>}} still resolves after a
  // condition (matches cloud's dispatchCondition) — result/passed win on key conflict.
  const upstream = ctx.previousOutput?.outputs ?? {};
  return {
    type: 'completed',
    output: {
      status: 'completed',
      outputs: {
        ...upstream,
        result,
        passed: result === CONDITION_TRUE_RESULT,
      },
      artifacts: [],
      durationMs: 0,
    },
  };
};
