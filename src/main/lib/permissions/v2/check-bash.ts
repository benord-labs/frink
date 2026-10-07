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
import {
  extractSignature,
  maskSingleQuoted,
  type SubCommand,
  splitBackgrounded,
  splitCommand,
} from './bash-parser';
import { expandTilde } from './check-edit';
import { evalBash, type ScopedDocs, strongerMatch, withoutAllow } from './eval-rules';
import { isSystemDeniedPath } from './system-denied-patterns';
import type { DenyReason, PermissionResult, PromptData } from './types';

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

/** A flag value or duration must look like one: the tokenizer folds `-n 5 >x` into an fd redirect. */
type WrapperSpec = { valueFlags?: string[]; value?: RegExp; positional?: RegExp; refuse?: RegExp };
const DURATION = /^\d*\.?\d+[smhd]?$/;
// Deny and ask rules also match the command a wrapper runs. Unlike Claude Code, allow rules
// never do, so a mis-read wrapper can never allow a command.
const WRAPPERS: ReadonlyMap<string, WrapperSpec> = new Map([
  [
    'timeout',
    {
      valueFlags: ['-s', '--signal', '-k', '--kill-after'],
      value: /^(\d*\.?\d+[smhd]?|(SIG)?[A-Z][A-Z0-9+]*)$/,
      positional: DURATION,
    },
  ],
  ['time', { valueFlags: ['-f', '--format', '-o', '--output'] }],
  ['nice', { valueFlags: ['-n', '--adjustment'], value: /^[-+]?\d+$/ }],
  ['nohup', {}],
  [
    'stdbuf',
    { valueFlags: ['-i', '-o', '-e', '--input', '--output', '--error'], value: /^(L|\d+\w*)$/ },
  ],
  ['command', { refuse: /^-\w*[vV]/ }],
  ['builtin', {}],
  ['noglob', {}],
  ['xargs', { refuse: /^-/ }],
]);
/** Peeled forms kept per subcommand; past this only the innermost command is added. */
const MAX_WRAPPERS = 4;
/** Nested commands the splitter never reaches, so no rule inside them was matched. */
const SUBSTITUTION = /\$\(|`|[<>]\(/;
const CONTROL_FLOW = new Set(
  'if then elif else fi for while until do done case esac select function coproc { } !'.split(' '),
);

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

/** Index of the command the wrapper at or after `start`'s assignments runs, or -1 when there is none. */
function wrappedCommandIndex(words: string[], start: number): number {
  let i = start;
  while (ENV_TOKEN_REGEX.test(words[i] ?? '')) i++;
  const spec = WRAPPERS.get(words[i]);
  let j = spec ? skipOptions(spec, words, i + 1) : -1;
  if (spec?.positional?.test(words[j] ?? '')) j++;
  return j !== -1 && j < words.length ? j : -1;
}

/** Index past a wrapper's own options, or -1 when one of them rules the wrapper out. */
function skipOptions(spec: WrapperSpec, words: string[], start: number): number {
  let j = start;
  while (words[j]?.startsWith('-')) {
    const flag = words[j++];
    if (spec.refuse?.test(flag)) return -1;
    if (flag === '--') return j;
    if (spec.valueFlags?.includes(flag) && (spec.value?.test(words[j]) ?? true)) j++;
  }
  return j;
}

/** The subcommand's words with each stacked wrapper peeled off in turn, bounded by MAX_WRAPPERS. */
function unwrapForms(sub: SubCommand): SubCommand[] {
  // Operators (`(`, a leftover `&` from `|&` or `&>`) and empty words are not part of the command.
  const kept = sub.tokens.filter((t) => tokenAsPathString(t));
  const words = kept.map((t) => tokenAsPathString(t) ?? '');
  const starts: number[] = [];
  let next = wrappedCommandIndex(words, 0);
  while (next !== -1) {
    starts.push(next);
    next = wrappedCommandIndex(words, next);
  }
  return starts
    .filter((_, k) => k < MAX_WRAPPERS - 1 || k === starts.length - 1)
    .map((start) => ({ ...sub, tokens: kept.slice(start) }));
}

/** One subcommand's verdict: deny/ask rules and the path check see past wrappers, allow rules do not. */
function judgeSub(sub: SubCommand, docs: ScopedDocs, input: { command: string }, root: string) {
  const forms = unwrapForms(sub);
  const unwrapped = [sub, ...forms].map(extractSignature);
  // A stack past the bound always has peeled forms, so it is untraced too.
  const untraced = forms.length > 0 || CONTROL_FLOW.has(unwrapped[0].base);
  const deniedPath = [sub, ...forms].map((f) => findSystemDeniedPathInSub(f, root)).find(Boolean);
  // A metachar-hidden directory makes the denied list unevaluable, so a prefix
  // rule must not auto-allow it — same treatment `$VAR` gets.
  const sig = hasUnresolvableDirectory(sub)
    ? { ...unwrapped[0], isExactMatchOnly: true }
    : unwrapped[0];
  // Deny and ask rules also match every unwrapped form, and a matched ask outranks any allow.
  const combined = unwrapped
    .map((s) => evalBash(withoutAllow(docs), s, input))
    .reduce(strongerMatch, evalBash(docs, sig, input));
  return { deniedPath, sig, combined, untraced };
}

/** The pieces a lone `&` cuts a subcommand into, or none; the whole is judged before them. */
function backgroundPieces(sub: SubCommand): SubCommand[] {
  const pieces = splitBackgrounded(sub.raw);
  return pieces.length > 1 ? pieces.flatMap(splitCommand) : [];
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
      // Skip exact-only subs (the matcher drops prefix rules for them); always an
      // array, so nothing prefix-able hides persistence instead of the `:*` fallback.
      suggestedRules: buildSuggestedRules(
        subs.flatMap((sub) => {
          if (hasUnresolvableDirectory(sub)) return [];
          const sig = extractSignature(sub);
          return sig.isExactMatchOnly || sig.base === '' ? [] : [sig];
        }),
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
  // a multi-line command would match every future body. Single-line only, judged
  // on the trimmed text splitCommand reads, so a trailing newline still mints.
  const canMintExact = !input.command.trim().includes('\n');
  // An exact-only sub that got no exact rule cannot be expressed by any rule.
  let unmintableExact = false;
  let askPrompt: PromptData | undefined;
  let untraced = SUBSTITUTION.test(maskSingleQuoted(input.command));

  for (const sub of [...subs, ...subs.flatMap(backgroundPieces)]) {
    const { deniedPath, sig, combined, ...verdict } = judgeSub(sub, docs, input, projectRoot);
    untraced ||= verdict.untraced;
    // Tier-1c: bash-Read parity. Read-ish/write-ish commands + redirections
    // checked against SYSTEM_DENIED_PATTERNS.
    if (deniedPath) return denyResult({ kind: 'safety:path', path: deniedPath });

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
      else {
        const exact = canMintExact && sig.fullSignature === sub.raw ? exactRuleFor(sub.raw) : null;
        if (exact) exactRules.add(exact);
        else unmintableExact = true;
      }
      // The first matched ask rule names the card, even after an unmatched sub.
      if (combined.rule && !askPrompt?.matchedRule) askPrompt = undefined;
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
    if (untraced && askPrompt.reason === 'no-matching-rule') askPrompt.reason = 'untraced';
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
