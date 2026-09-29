/**
 * Bash checker. Splits compound commands, runs tier-1c safety per subcommand
 * (system-denied paths in read/write commands & redirections), evaluates
 * rules, severity-combines per-sub results (`deny > ask > allow`).
 *
 * Pure function. Ticket 05 of the permissions overhaul.
 */

import { escapeRuleContent, parseRule } from '../../../../shared/lib/rule-parser';
import {
  type CommandSignature,
  extractCommandSignatures,
  generatePatternChoices,
} from '../command-parser';
import {
  exciseHeredocBodies,
  extractSignature,
  splitCommand,
  stripSafeHeredocSubstitutions,
} from './bash-parser';
import { findSystemDeniedPathInSub, hasUnresolvableDirectory } from './bash-paths';
import { combineScopes, evalScope, type ScopedDocs } from './eval-rules';
import type { DenyReason, MatchContext, PermissionResult, PromptData } from './types';

const SUBCOMMAND_CAP = 50;
/** v1 wildcard signal — trailing ` *` or `*` on a generated pattern. */
const V1_WILDCARD_TAIL = /\s*\*$/;

/**
 * Shells and wrappers that exec their arguments, so `Bash(bash:*)` ≈ `Bash(*)`:
 * never SUGGESTED, still hand-writable. Mirrors Claude Code's BARE_SHELL_PREFIXES.
 */
const BARE_SHELL_PREFIXES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'csh',
  'tcsh',
  'ksh',
  'dash',
  'cmd',
  'powershell',
  'pwsh',
  'env',
  'xargs',
  'nice',
  'stdbuf',
  'nohup',
  'timeout',
  'time',
  'sudo',
  'doas',
  'pkexec',
  'command',
  'builtin',
  'coproc',
  'noglob',
  'nocorrect',
]);

function denyResult(reason: DenyReason): PermissionResult {
  return { decision: 'deny', reason };
}

function askResult(prompt: PromptData): PermissionResult {
  return { decision: 'ask', prompt };
}

/**
 * Generate v2 rule-string suggestions from command signatures. Drives the
 * renderer's "Allow for project" / "Allow on machine" dropdown. Callers pass
 * only the signatures that still need approval, so already-allowed subs of a
 * compound command never reappear as suggestions.
 *
 * For each pattern (e.g. `git push *`, `npm`), strip the v1 trailing `*` /
 * ` *` wildcard signal and wrap with the v2 `:*` suffix. Empty patterns are
 * skipped — `buildFallbackRule` in the renderer handles the no-suggestions case.
 */
function buildSuggestedRules(signatures: CommandSignature[]): string[] {
  const patterns = generatePatternChoices(signatures);
  const rules: string[] = [];
  for (const p of patterns) {
    const stripped = p.replace(V1_WILDCARD_TAIL, '').trim();
    if (stripped.length === 0) continue;
    // Never suggest a shell/wrapper base — `Bash(bash:*)` ≈ `Bash(*)`.
    if (BARE_SHELL_PREFIXES.has(stripped.split(' ')[0])) continue;
    rules.push(`Bash(${stripped}:*)`);
  }
  return rules;
}

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

export function checkBash(
  input: { command: string },
  docs: ScopedDocs,
  projectRoot: string,
): PermissionResult {
  const subs = splitCommand(input.command);
  // Tier-1c first, over every sub (so the over-cap ask cannot skip it). shell-quote splits
  // `<>` and orphans its target, so it is read as the `>` write it performs.
  for (const sub of splitCommand(input.command.replace(/<>/g, '>'))) {
    const denied = findSystemDeniedPathInSub(sub, projectRoot);
    if (denied) return denyResult(denied);
  }

  if (subs.length > SUBCOMMAND_CAP) {
    return askResult({
      tool: 'Bash',
      input,
      reason: 'over-50-subcommands',
      // Strip safe heredoc substitutions + excise heredoc bodies here too —
      // extractCommandSignatures runs raw shell-quote on the whole command and
      // would otherwise resurface the phantom subcommands splitCommand already
      // removed.
      suggestedRules: buildSuggestedRules(
        extractCommandSignatures(
          exciseHeredocBodies(stripSafeHeredocSubstitutions(input.command) ?? input.command),
        ),
      ),
    });
  }

  // Only `ask` subs drive the dropdown, so granted rules are not re-prompted.
  // Exact-match-only sigs take an exact rule; a prefix would never match them.
  const askSignatures: CommandSignature[] = [];
  // Set, not array: a command repeating the same sub (`echo $A && echo $A`)
  // must not offer the same rule twice in the dropdown.
  const exactRules = new Set<string>();
  // Heredoc bodies are excised before signatures, so an exact rule minted from
  // a multi-line command would match every future body. Single-line only.
  const canMintExact = !input.command.includes('\n');
  let askPrompt: PromptData | undefined;

  for (const sub of subs) {
    // Rule eval
    const base = extractSignature(sub);
    // A metachar-hidden directory makes the denied list unevaluable, so a prefix
    // rule must not auto-allow it — same treatment `$VAR` gets.
    const sig = hasUnresolvableDirectory(sub) ? { ...base, isExactMatchOnly: true } : base;
    const ctx: MatchContext = { bashCommandSignature: sig };

    // Build per-scope docs filtered to exact-match rules when sig demands it.
    // Tier-1c-deny rules still apply because filtering only removes prefix
    // wildcards from `allow` and `ask`; deny rules are checked verbatim
    // (we want `Bash(rm:*)` deny to fire even on an expansion-flagged sub).
    const docsToUse = sig.isExactMatchOnly
      ? {
          policy: {
            ...docs.policy,
            allow: exactMatchRules(docs.policy.allow),
            ask: exactMatchRules(docs.policy.ask),
          },
          project: {
            ...docs.project,
            allow: exactMatchRules(docs.project.allow),
            ask: exactMatchRules(docs.project.ask),
          },
          user: {
            ...docs.user,
            allow: exactMatchRules(docs.user.allow),
            ask: exactMatchRules(docs.user.ask),
          },
        }
      : docs;

    const policy = evalScope(docsToUse.policy, 'Bash', input, ctx);
    const project = evalScope(docsToUse.project, 'Bash', input, ctx);
    const user = evalScope(docsToUse.user, 'Bash', input, ctx);
    const combined = combineScopes(policy, project, user);

    if (combined.decision === 'deny') {
      return denyResult({
        kind: 'rule:deny',
        // biome-ignore lint/style/noNonNullAssertion: combineScopes guarantees rule+tier on deny
        rule: combined.rule!,
        // biome-ignore lint/style/noNonNullAssertion: combineScopes guarantees rule+tier on deny
        tier: combined.tier!,
      });
    }
    if (combined.decision === 'ask') {
      if (!sig.isExactMatchOnly) askSignatures.push(sig);
      // The matcher compares an exact rule against `fullSignature`, so a truncated
      // one (`grep foo` for `grep foo src/*/x.ts`) could never match the rule.
      else if (canMintExact && sig.fullSignature === sub.raw) {
        const exact = exactRuleFor(sub.raw);
        if (exact) exactRules.add(exact);
      }
      askPrompt ??= {
        tool: 'Bash',
        input,
        reason: combined.rule ? 'rule:ask' : 'no-matching-rule',
        matchedRule: combined.rule,
        matchedTier: combined.tier,
      };
    }
    // allow → nothing to collect; sub is already permitted
  }

  if (askPrompt) {
    const rules = [...buildSuggestedRules(askSignatures), ...exactRules];
    // Empty tells the card no rule can express the command. A withheld wrapper
    // prefix (`sudo npm i`) is not that: unset keeps the card's working fallback.
    askPrompt.suggestedRules = rules.length === 0 && askSignatures.length > 0 ? undefined : rules;
    return askResult(askPrompt);
  }
  return { decision: 'allow' };
}

/**
 * Exact rule for an exact-match-only sub, or null when it cannot round-trip the
 * rule grammar (backslash-paren): a rule that never matches is worse than none.
 */
function exactRuleFor(raw: string): string | null {
  // A command ending in the grammar's own wildcard shape would be read as a prefix
  // rule and then stripped by exactMatchRules, so it can never be an exact rule.
  if (/(?::|\s)\*$/.test(raw)) return null;
  const rule = `Bash(${escapeRuleContent(raw)})`;
  const parsed = parseRule(rule);
  return !('error' in parsed) && parsed.content === raw ? rule : null;
}
