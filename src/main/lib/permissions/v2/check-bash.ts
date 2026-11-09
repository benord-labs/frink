/**
 * Bash checker. Splits compound commands, runs tier-1c safety per subcommand
 * (system-denied paths in read/write commands & redirections), evaluates
 * rules, severity-combines per-sub results (`deny > ask > allow`).
 *
 * Pure function. Ticket 05 of the permissions overhaul.
 */

import type { ParseEntry } from 'shell-quote';
import { escapeRuleContent, parseRule } from '../../../../shared/lib/rule-parser';
import { type CommandSignature, generatePatternChoices } from '../command-parser';
import { extractSignature, type Signature, type SubCommand, splitCommand } from './bash-parser';
import { expandTilde } from './check-edit';
import { combineScopes, evalScope, type ScopedDocs } from './eval-rules';
import { hasEscapingRedirect, type RedirectRoots, redirectSettled } from './redirects';
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
const REDIRECT_OP_PREFIX = /^(?:&?>>?|\d?>>?|\d?<>|\d?<|<<<?|&>|>&)/;
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
 * The rule pipeline does NOT hard-deny these — `grep foo src/ma*n/x.ts` is ordinary
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

/** Prefix and tool-wide allow/ask rules never match an exact-match-only signature. */
function evaluateSignature(sig: Signature, docs: ScopedDocs, input: { command: string }) {
  const ctx: MatchContext = { bashCommandSignature: sig };
  const exactOnly = (doc: ScopedDocs['policy']) =>
    sig.isExactMatchOnly
      ? { ...doc, allow: exactMatchRules(doc.allow), ask: exactMatchRules(doc.ask) }
      : doc;
  return combineScopes(
    evalScope(exactOnly(docs.policy), 'Bash', input, ctx),
    evalScope(exactOnly(docs.project), 'Bash', input, ctx),
    evalScope(exactOnly(docs.user), 'Bash', input, ctx),
  );
}

/**
 * A sub that writes outside the project keeps every deny and ask the plain
 * signature gets; an allow then also needs an exact rule naming the whole command.
 */
function evaluateEscapingSub(
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

type RedirectContext = { roots: RedirectRoots; subs: SubCommand[] };

/** The sub's signature and decision; an escaping sub needs an exact rule naming it whole. */
function judgeSub(
  index: number,
  ctx: RedirectContext,
  docs: ScopedDocs,
  input: { command: string },
) {
  const sub = ctx.subs[index];
  const base = extractSignature(sub);
  // A metachar-hidden directory makes the denied list unevaluable, so a prefix
  // rule must not auto-allow it — same treatment `$VAR` gets.
  const plainSig = hasUnresolvableDirectory(sub) ? { ...base, isExactMatchOnly: true } : base;
  const escaping = hasEscapingRedirect(sub, ctx.roots, redirectSettled(ctx.subs, index));
  if (!escaping)
    return { escaping, sig: plainSig, combined: evaluateSignature(plainSig, docs, input) };
  // Deny rules are checked verbatim, so `Bash(rm:*)` deny fires even on an exact-only sub.
  const combined = evaluateEscapingSub(plainSig, sub.raw, docs, input);
  return {
    escaping,
    sig: { ...plainSig, fullSignature: sub.raw, isExactMatchOnly: true },
    combined,
  };
}

/** Over-50 suggestions skip exact-only and escaping subs: no prefix rule could cover them. */
function overCapSuggestions(ctx: RedirectContext): string[] {
  return buildSuggestedRules(
    ctx.subs.flatMap((sub, index) => {
      const settled = redirectSettled(ctx.subs, index);
      if (hasUnresolvableDirectory(sub) || hasEscapingRedirect(sub, ctx.roots, settled)) return [];
      const sig = extractSignature(sub);
      return sig.isExactMatchOnly || sig.base === '' ? [] : [sig];
    }),
  );
}

function askReason(rule: string | undefined, escaping: boolean): PromptData['reason'] {
  if (rule) return 'rule:ask';
  return escaping ? 'redirect-outside-project' : 'no-matching-rule';
}

/** `commandCwd`: the folder the provider runs this command in, never the model's input. */
export function checkBash(
  input: { command: string },
  docs: ScopedDocs,
  projectRoot: string,
  executionRoot?: string,
  commandCwd?: string,
): PermissionResult {
  const subs = splitCommand(input.command);
  const ctx: RedirectContext = { roots: { projectRoot, executionRoot, cwd: commandCwd }, subs };

  if (subs.length > SUBCOMMAND_CAP) {
    return askResult({
      tool: 'Bash',
      input,
      reason: 'over-50-subcommands',
      // Always an array, so nothing prefix-able hides persistence instead of the `:*` fallback.
      suggestedRules: overCapSuggestions(ctx),
    });
  }

  // Only `ask` subs drive the dropdown, so granted rules are not re-prompted.
  // Exact-match-only sigs take an exact rule; a prefix would never match them.
  const askSignatures: CommandSignature[] = [];
  // Set, not array: a command repeating the same sub (`echo $A && echo $A`)
  // must not offer the same rule twice in the dropdown.
  const exactRules = new Set<string>();
  // Heredoc bodies are excised before signatures, so an exact rule minted from
  // a multi-line command would match every future body. Single-line only, judged
  // on the trimmed text splitCommand reads, so a trailing newline still mints.
  const canMintExact = !input.command.trim().includes('\n');
  // An exact-only sub that got no exact rule cannot be expressed by any rule.
  let unmintableExact = false;
  let askPrompt: PromptData | undefined;
  let redirectAsked = false;

  for (const [index, sub] of subs.entries()) {
    // Tier-1c: read/write commands and redirections against SYSTEM_DENIED_PATTERNS.
    const deniedPath = findSystemDeniedPathInSub(sub, projectRoot);
    if (deniedPath) return denyResult({ kind: 'safety:path', path: deniedPath });

    const { escaping, sig, combined } = judgeSub(index, ctx, docs, input);

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
      redirectAsked ||= escaping && !combined.rule;
      if (!sig.isExactMatchOnly) askSignatures.push(sig);
      // The matcher compares an exact rule against `fullSignature`, so a truncated
      // one (`grep foo` for `grep foo src/*/x.ts`) could never match the rule.
      else {
        const exact = canMintExact && sig.fullSignature === sub.raw ? exactRuleFor(sub.raw) : null;
        if (exact) exactRules.add(exact);
        else unmintableExact = true;
      }
      askPrompt ??= {
        tool: 'Bash',
        input,
        reason: askReason(combined.rule, escaping),
        matchedRule: combined.rule,
        matchedTier: combined.tier,
      };
    }
  }

  if (askPrompt) {
    // Name the redirect even when another part of a compound command asked first.
    if (askPrompt.reason === 'no-matching-rule' && redirectAsked) {
      askPrompt.reason = 'redirect-outside-project';
    }
    const rules = [...buildSuggestedRules(askSignatures), ...exactRules];
    // Empty = no rule can express the command. A lone withheld wrapper (`sudo npm i`)
    // stays unset for the card's fallback; an unmintable exact-only sub makes it dead.
    askPrompt.suggestedRules =
      rules.length === 0 && askSignatures.length > 0 && !unmintableExact ? undefined : rules;
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
