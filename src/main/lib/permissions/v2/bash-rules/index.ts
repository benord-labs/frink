/** Bash rule evaluation for one subcommand signature, shared by the Bash checker. */

import { parseRule } from '../../../../../shared/lib/rule-parser';
import type { Signature } from '../bash-parser';
import { combineScopes, evalScope, type ScopedDocs } from '../eval-rules';
import type { MatchContext } from '../types';

/**
 * Drop prefix-wildcard ALLOW/ASK rules for an exact-match-only signature: those
 * signatures keep a base, so nothing else would stop a prefix rule matching.
 */
function exactMatchRules(rules: string[] | undefined): string[] {
  if (!rules) return [];
  const out: string[] = [];
  for (const rule of rules) {
    const parsed = parseRule(rule);
    if ('error' in parsed) continue;
    if (parsed.tool !== 'Bash') continue;
    if (parsed.content === undefined) continue; // tool-wide `Bash` — too permissive for exact-only
    if (parsed.content === '*') continue; // shortcut wildcard
    if (parsed.content.endsWith(':*') || parsed.content.endsWith(' *')) continue;
    out.push(rule);
  }
  return out;
}

/** Every scope's Bash rules for one subcommand signature, combined deny > ask > allow. */
function evalBashScopes(docs: ScopedDocs, input: { command: string }, sig: Signature) {
  const ctx: MatchContext = { bashCommandSignature: sig };
  return combineScopes(
    evalScope(docs.policy, 'Bash', input, ctx),
    evalScope(docs.project, 'Bash', input, ctx),
    evalScope(docs.user, 'Bash', input, ctx),
  );
}

/** A prefix ask rule that the exact-only filter dropped, which still names this subcommand. */
export function prefixAskMatches(docs: ScopedDocs, input: { command: string }, sig: Signature) {
  const combined = evalBashScopes(docs, input, sig);
  return combined.decision === 'ask' && Boolean(combined.rule);
}

/** Prefix and tool-wide allow/ask rules never match an exact-match-only signature. */
export function evaluateSignature(sig: Signature, docs: ScopedDocs, input: { command: string }) {
  const exactOnly = (doc: ScopedDocs['policy']) =>
    sig.isExactMatchOnly
      ? { ...doc, allow: exactMatchRules(doc.allow), ask: exactMatchRules(doc.ask) }
      : doc;
  const filtered = {
    policy: exactOnly(docs.policy),
    project: exactOnly(docs.project),
    user: exactOnly(docs.user),
  };
  return evalBashScopes(filtered, input, sig);
}

/**
 * A sub that writes outside the project keeps every deny and ask the plain
 * signature gets; an allow then also needs an exact rule naming the whole command.
 */
export function evaluateEscapingSub(
  sig: Signature,
  raw: string,
  docs: ScopedDocs,
  input: { command: string },
) {
  const plain = evaluateSignature(sig, docs, input);
  const whole = evaluateSignature(
    { ...sig, fullSignature: raw, isExactMatchOnly: true },
    docs,
    input,
  );
  if (plain.decision === 'deny') return plain;
  if (whole.decision === 'deny') return whole;
  if (plain.decision === 'ask' && plain.rule) return plain;
  if (whole.decision !== 'ask' || whole.rule) return whole;
  return plain.decision === 'ask' ? plain : whole;
}
