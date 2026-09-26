/**
 * Bash checker. Splits compound commands, runs tier-1c safety per subcommand
 * (system-denied paths in read/write commands & redirections), evaluates
 * rules, severity-combines per-sub results (`deny > ask > allow`).
 *
 * Pure function. Ticket 05 of the permissions overhaul.
 */

import type { ParseEntry } from 'shell-quote';
import { escapeRuleContent, parseRule } from '../../../../shared/lib/rule-parser';
import {
  type CommandSignature,
  extractCommandSignatures,
  generatePatternChoices,
} from '../command-parser';
import {
  exciseHeredocBodies,
  extractSignature,
  type SubCommand,
  splitCommand,
  stripSafeHeredocSubstitutions,
} from './bash-parser';
import { expandTilde } from './check-edit';
import { combineScopes, evalScope, type ScopedDocs } from './eval-rules';
import { isSystemDeniedPath } from './system-denied-patterns';
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

/**
 * Bash commands that READ a path argument. If any positional arg matches
 * `SYSTEM_DENIED_PATTERNS`, deny — closes the bash-Read parity gap (a model
 * that has `Bash(cat:*)` allowed could otherwise read `.env`).
 */
const READ_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'bat',
  'xxd',
  'hexdump',
  'od',
  'file',
  'view',
  'vi',
  'vim',
  'nano',
  'emacs',
  // Everything below also emits file CONTENT, so each is as good as `cat` for
  // reading a secret. Metadata-only commands (ls, stat, find, du, readlink,
  // basename, dirname, tree) are deliberately absent: they leak a filename, not
  // contents, and listing them widens the false-positive surface for no gain.
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'strings',
  'sort',
  'uniq',
  'cut',
  'tr',
  'nl',
  'fold',
  'fmt',
  'column',
  'paste',
  'join',
  'comm',
  'diff',
  'cmp',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'sha512sum',
  'cksum',
  'tac',
  'rev',
  'base64',
  'zcat',
  'expand',
  'pr',
  'shuf',
]);

/**
 * Commands whose non-flag arguments are AMBIGUOUS — a search pattern, a flag
 * value, or a path — so only path-shaped tokens reach the denied list. Skipping
 * the first non-flag arg instead would eat any value-taking flag's value and
 * hard-deny `grep -C 3 .env README.md` at tier-1c with no way to approve.
 */
// biome-ignore format: one per line churns the size baseline for no readability gain
const PATTERN_ARG_COMMANDS = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'find',
  'fd',
  'locate',
  'ls',
  'dir',
  'tree',
  'stat',
  'du',
  'df',
  'wc',
  'lsof',
  'readlink',
  'realpath',
  'basename',
  'dirname',
]);

/** A token is path-shaped if it carries a separator or a `~` home reference. */
function looksLikePath(token: string): boolean {
  return token.includes('/') || token.includes('\\') || token.startsWith('~');
}

/** Bash commands that WRITE a path argument. Same parity rule for destinations. */
const WRITE_COMMANDS = new Set([
  'tee',
  'cp',
  'mv',
  'rm',
  'touch',
  'dd',
  'truncate',
  'install',
  'ln',
  'mkdir',
  'rsync',
]);

const ENV_TOKEN_REGEX = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Strip a redirection's operator prefix to recover the target path.
 * `bash-parser:stripRedirections` emits concatenated strings like `'>/tmp/foo'`.
 * Drop fd-dups (`>&2`, `2>&1` → `'2>&1'` strips to `'1'` digit, etc.) since
 * those aren't paths.
 */
const REDIRECT_OP_PREFIX = /^(?:&?>>?|\d?>>?|\d?<|<<<?|&>|>&)/;
const LONE_DIGIT = /^\d+$/;

/**
 * shell-quote emits `{ op: 'glob', pattern }` for an unquoted glob rather than a
 * string, so a plain string filter drops it — and `cat ~/.ssh/*` would extract
 * ZERO paths while the shell happily expands it. The pattern is literal text, so
 * `isSystemDeniedPath` matches it exactly as it would the expanded path.
 */
function tokenAsPathString(token: ParseEntry): string | null {
  if (typeof token === 'string') return token;
  if (typeof token === 'object' && token !== null && 'op' in token && token.op === 'glob') {
    return (token as { op: 'glob'; pattern: string }).pattern;
  }
  return null;
}

/**
 * A path argument, and whether it is unambiguously one. The denied list only
 * consumes unambiguous ones: a bare literal may be a search pattern, and
 * denying `grep .env config.txt` at tier-1c would refuse ordinary code search
 * with no rule able to override it.
 * Ruling: docs/decisions/bash-command-permission-safety-tier.md — containment
 * lives on the commands that touch files (`git diff --no-index ~/.ssh/id_rsa
 * /dev/null` is the known cost of a command outside the two lists).
 */
type BashPathArg = { path: string; unambiguous: boolean };

function extractBashPaths(sub: SubCommand): BashPathArg[] {
  const paths: BashPathArg[] = [];
  const tokens = sub.tokens.map(tokenAsPathString).filter((t): t is string => t !== null);

  // Skip leading KEY= tokens. Safe envs already moved to envAssignments;
  // unsafe envs left in tokens — neither is a path.
  let i = 0;
  while (i < tokens.length && ENV_TOKEN_REGEX.test(tokens[i])) i++;
  const cmd = tokens[i];

  if (cmd && (READ_COMMANDS.has(cmd) || WRITE_COMMANDS.has(cmd))) {
    const ambiguous = PATTERN_ARG_COMMANDS.has(cmd);
    for (let j = i + 1; j < tokens.length; j++) {
      const tok = tokens[j];
      // GNU long-flags `--target=/etc/passwd` get skipped here. Best-effort
      // per ticket 05 §38; documented limitation, not a bug.
      if (tok.startsWith('-')) continue;
      paths.push({ path: tok, unambiguous: !ambiguous || looksLikePath(tok) });
    }
  }

  for (const redir of sub.redirections) {
    const stripped = redir.replace(REDIRECT_OP_PREFIX, '').trim();
    if (!stripped) continue;
    if (stripped.startsWith('&')) continue; // `>&2` → '&2' (fd-dup, not a path)
    if (LONE_DIGIT.test(stripped)) continue; // pure file descriptor reference
    paths.push({ path: stripped, unambiguous: true });
  }

  return paths;
}

/**
 * A shell metacharacter anywhere but the FINAL path segment. The tokenizer keeps
 * it literal, so the segment the denied list matches on is gone by the time we
 * look, while the shell still expands onto it — `~/.c*fig/gcloud/creds` reaches
 * the gcloud credentials that `~/.config/gcloud/creds` is denied for.
 */
const METACHAR_IN_DIRECTORY = /[*?[{][^/]*\//;

function findSystemDeniedPathInSub(sub: SubCommand, projectRoot: string): string | null {
  for (const { path, unambiguous } of extractBashPaths(sub)) {
    if (!unambiguous) continue;
    const expanded = expandTilde(path);
    if (isSystemDeniedPath(expanded, projectRoot)) return expanded;
  }
  return null;
}

/**
 * True when a subcommand carries a path the denied list cannot evaluate, because
 * a metachar hides a directory segment.
 *
 * The rule pipeline does NOT hard-deny these — `grep foo src/*​/x.ts` is ordinary
 * — it makes the signature exact-match-only, so a prefix rule like `Bash(cat:*)`
 * stops auto-allowing and the user is asked. That closes the tier-1c bypass
 * without a hard deny no rule can appeal.
 */
function hasUnresolvableDirectory(sub: SubCommand): boolean {
  return extractBashPaths(sub).some(({ path }) => METACHAR_IN_DIRECTORY.test(path));
}

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
    // Tier-1c: bash-Read parity. Read-ish/write-ish commands + redirections
    // checked against SYSTEM_DENIED_PATTERNS.
    const deniedPath = findSystemDeniedPathInSub(sub, projectRoot);
    if (deniedPath) return denyResult({ kind: 'safety:path', path: deniedPath });

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
