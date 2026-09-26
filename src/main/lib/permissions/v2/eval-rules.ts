/**
 * Truth-table evaluator shared by all per-tool checkers.
 *
 * Per-scope eval (deny > ask > allow > miss).
 * Cross-scope combine (deny in ANY scope wins; policy > project > user for ask/allow).
 *
 * Pure. Ticket 05 of the permissions overhaul.
 */

import { matchesRule } from './rule-matcher';
import type {
  DenyReason,
  MatchContext,
  PermissionResult,
  PermissionRule,
  PermissionsDoc,
  PermissionTier,
  PromptData,
} from './types';

export type ScopedDocs = {
  policy: PermissionsDoc;
  project: PermissionsDoc;
  user: PermissionsDoc;
};

export type ScopeEval =
  | { kind: 'deny'; rule: string }
  | { kind: 'ask'; rule: string }
  | { kind: 'allow'; rule: string }
  | { kind: 'miss' };

export type CombinedDecision = {
  decision: 'allow' | 'ask' | 'deny';
  tier?: PermissionTier;
  rule?: string;
};

const EMPTY_DOC: PermissionsDoc = { allow: [], deny: [], ask: [] };

export const EMPTY_DOCS: ScopedDocs = {
  policy: EMPTY_DOC,
  project: EMPTY_DOC,
  user: EMPTY_DOC,
};

function findMatchingRule(
  rules: PermissionRule[] | undefined,
  toolName: string,
  toolInput: unknown,
  ctx?: MatchContext,
): string | null {
  if (!rules) return null;
  for (const rule of rules) {
    if (matchesRule(rule, toolName, toolInput, ctx)) return rule;
  }
  return null;
}

export function evalScope(
  doc: PermissionsDoc,
  toolName: string,
  toolInput: unknown,
  ctx?: MatchContext,
): ScopeEval {
  const denyMatch = findMatchingRule(doc.deny, toolName, toolInput, ctx);
  if (denyMatch) return { kind: 'deny', rule: denyMatch };
  const askMatch = findMatchingRule(doc.ask, toolName, toolInput, ctx);
  if (askMatch) return { kind: 'ask', rule: askMatch };
  const allowMatch = findMatchingRule(doc.allow, toolName, toolInput, ctx);
  if (allowMatch) return { kind: 'allow', rule: allowMatch };
  return { kind: 'miss' };
}

export function combineScopes(
  policy: ScopeEval,
  project: ScopeEval,
  user: ScopeEval,
): CombinedDecision {
  // Deny in any scope wins. Report first matching deny by tier precedence.
  if (policy.kind === 'deny') return { decision: 'deny', tier: 'policy', rule: policy.rule };
  if (project.kind === 'deny') return { decision: 'deny', tier: 'project', rule: project.rule };
  if (user.kind === 'deny') return { decision: 'deny', tier: 'user', rule: user.rule };

  // policy > project > user precedence for ask / allow.
  const ordered: ReadonlyArray<readonly [ScopeEval, PermissionTier]> = [
    [policy, 'policy'],
    [project, 'project'],
    [user, 'user'],
  ];
  for (const [item, tier] of ordered) {
    if (item.kind === 'ask') return { decision: 'ask', tier, rule: item.rule };
    if (item.kind === 'allow') return { decision: 'allow', tier, rule: item.rule };
  }
  // (miss, miss, miss) → default prompt.
  return { decision: 'ask' };
}

/**
 * Convert a combined decision into the public `PermissionResult` shape.
 * Specified once so checkers don't re-derive prompt payloads ad hoc.
 */
export function resultFromCombined(
  combined: CombinedDecision,
  toolName: string,
  toolInput: unknown,
): PermissionResult {
  if (combined.decision === 'deny') {
    if (!combined.rule || !combined.tier) {
      // Should never happen — combineScopes always populates these for deny.
      throw new Error('combineScopes deny without rule/tier');
    }
    const reason: DenyReason = { kind: 'rule:deny', rule: combined.rule, tier: combined.tier };
    return { decision: 'deny', reason };
  }
  if (combined.decision === 'allow') return { decision: 'allow' };

  const prompt: PromptData = {
    tool: toolName,
    input: toolInput,
    reason: combined.rule ? 'rule:ask' : 'no-matching-rule',
    matchedRule: combined.rule,
    matchedTier: combined.tier,
  };
  return { decision: 'ask', prompt };
}
