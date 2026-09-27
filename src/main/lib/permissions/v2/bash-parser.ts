/**
 * Bash parser for v2 permission gating. Pure, no I/O. Never denies syntax:
 * what it cannot analyse is exact-match-only (bash-command-permission-safety-tier).
 */

import { type ParseEntry, parse } from 'shell-quote';
import { inlineLiteralHeredocSubstitutions } from './heredoc';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubCommand = {
  /** Original source slice for this subcommand. Verbatim — fixes `$1` rendering. */
  raw: string;
  /** shell-quote tokens for this subcommand (operators already stripped at split time). */
  tokens: ParseEntry[];
  /** Redirections like `> /dev/null`, `2>&1`, stripped from `tokens`. */
  redirections: string[];
  /** Leading `KEY=value` assignments of INERT_ENV_ASSIGNMENTS names, stripped from `tokens`. */
  envAssignments: Record<string, string>;
  /**
   * True when shell would expand or eval something — `$1`, `$VAR`, `$(...)`,
   * backticks, heredocs (`<<`), process substitution (`<(...)`/`>(...)`).
   * Detection is regex-on-raw because shell-quote@1.8.3 returns `''` for
   * positional args (does NOT emit `{op:'expand', pattern:'1'}` as the
   * source ticket claims).
   */
  hasExpansion: boolean;
};

export type Signature = {
  base: string;
  subcommand?: string;
  fullSignature: string;
  /**
   * Contract for ticket 05 dispatcher: when true, ONLY exact
   * `signature.fullSignature === rule.content` matches. Skip prefix wildcards.
   * Set when hasExpansion, unsafe-env-prefix, or unparseable.
   */
  isExactMatchOnly: boolean;
};

// ---------------------------------------------------------------------------
// INERT_ENV_ASSIGNMENTS
// ---------------------------------------------------------------------------

/** Env vars that tune output, logging or build target only; never code-path vars like `NODE_OPTIONS`. */
export const INERT_ENV_ASSIGNMENTS: ReadonlySet<string> = new Set([
  'NODE_ENV',
  'RUST_BACKTRACE',
  'RUST_LOG',
  'GOARCH',
  'GOOS',
  'PYTHONUNBUFFERED',
  'PYTHONDONTWRITEBYTECODE',
  'CI',
  'CLICOLOR',
  'NO_COLOR',
  'FORCE_COLOR',
  'DEBUG',
  'VERBOSE',
]);

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const FLAGS_WITH_VALUES = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '-o',
  '--output',
  '-f',
  '--file',
]);

/**
 * Matches every shell-expansion form that shell-quote silently drops to `''`
 * or otherwise mangles. Includes:
 * - positional `$1` / `${1}`
 * - named `$var` / `${VAR}` (mixed case, since bash allows lowercase)
 * - special params `$$ $? $@ $* $# $! $- $_`
 * - command sub `$(...)`
 * - backticks
 * - heredocs `<<`
 * - process sub `<(...)` `>(...)`
 */
const EXPANSION_REGEX = /(?:\$\{?\d+\}?|\$\{?[a-zA-Z_]\w*\}?|\$[$?@*#!_-]|\$\(|`|<<|<\(|>\()/;

// Bash env-assignment grammar: identifier = anything. Mixed case allowed.
const ENV_TOKEN_REGEX = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Heads whose argument is shell code in one opaque token, so `Bash(eval:*)` would
 * be `Bash(*)`. Exact-match-only; base kept so a prefix DENY still fires.
 */
const EVAL_LIKE_HEADS = new Set([
  'eval',
  'exec',
  'source',
  '.',
  'zmodload',
  'zcompile',
  'autoload',
]);

/**
 * Walk the raw command and return a copy of equal length where single-quoted
 * runs are blanked to spaces, so expansion detection honours POSIX
 * single-quote semantics. A backslash inside single quotes is literal.
 */
function maskSingleQuoted(raw: string): string {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  let escapeNext = false;
  for (const ch of raw) {
    if (escapeNext) {
      out += ch;
      escapeNext = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      out += ch;
      escapeNext = true;
      continue;
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      out += ch;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      out += ch;
      continue;
    }
    out += inSingle ? ' ' : ch;
  }
  return out;
}

/**
 * Like maskSingleQuoted but blanks BOTH single- and double-quoted runs.
 * Used only to locate heredoc `<<` openers: a `<<` inside any quoted string
 * (e.g. `awk "x<<4"`) is not a redirection operator, so it must not be matched.
 * Length-preserving so opener indices map back onto the raw line verbatim.
 */
function maskQuoted(raw: string): string {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  let escapeNext = false;
  for (const ch of raw) {
    if (escapeNext) {
      out += inSingle || inDouble ? ' ' : ch;
      escapeNext = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      out += ch;
      escapeNext = true;
      continue;
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      out += ch;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      out += ch;
      continue;
    }
    out += inSingle || inDouble ? ' ' : ch;
  }
  return out;
}

/**
 * Quote-aware raw splitter. Walks the command character-by-character tracking
 * single/double quote and backslash-escape state. When NOT inside quotes, splits
 * on `&&` `||` `;` `|` and a bare newline/CR (escaped newline = continuation).
 */
function splitRaw(command: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  let escapeNext = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escapeNext) {
      buf += ch;
      escapeNext = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      buf += ch;
      escapeNext = true;
      continue;
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      buf += ch;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      buf += ch;
      continue;
    }
    if (!inSingle && !inDouble) {
      const next = command[i + 1];
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
        out.push(buf);
        buf = '';
        i++;
        continue;
      }
      if (ch === ';' || ch === '|' || ch === '\n' || ch === '\r') {
        out.push(buf);
        buf = '';
        continue;
      }
    }
    buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

type HeredocOpener = { start: number; end: number; delim: string; stripTabs: boolean };

/**
 * Anchored at a `<<`: matches the operator + delimiter — `<<EOF`, `<<-EOF`,
 * `<< EOF`, `<<'EOF'`, `<<"EOF"`. The delimiter must be a letter-initial
 * bareword (rejects the `1<<4` left-shift's `4` and `}'`). Read off the RAW
 * line (not the quote-masked copy) so the delimiter inside `<<'EOF'` survives.
 */
const HEREDOC_DELIM_REGEX = /^<<(-?)[ \t]*(['"]?)([A-Za-z_]\w*)\2/;
/** Leading tabs a `<<-` closer may be indented with. */
const LEADING_TABS_REGEX = /^\t+/;
/** Trailing CR so a CRLF (`EOF\r`) closer still matches on Windows-authored commands. */
const TRAILING_CR_REGEX = /\r$/;

/**
 * Locate the single heredoc opener on one command line. `<<` positions are
 * found in a both-quote masked copy (so a `<<` inside a quoted arg, e.g.
 * `awk "x<<4"`, is never seen), but the delimiter is parsed from the raw line
 * so a quoted delimiter `<<'EOF'` still resolves. A digit immediately before
 * `<<` (the C left-shift `1<<4`) is rejected. Returns the operator span
 * [start,end) so callers excise only the `<<delim` token and keep any trailing
 * command. Returns null unless EXACTLY one opener is present.
 */
function findHeredocOpener(line: string): HeredocOpener | null {
  const masked = maskQuoted(line);
  let found: HeredocOpener | null = null;
  for (let k = masked.indexOf('<<'); k !== -1; k = masked.indexOf('<<', k + 2)) {
    const prev = line[k - 1];
    if (prev >= '0' && prev <= '9') continue; // `1<<4` left-shift, not a heredoc
    const m = HEREDOC_DELIM_REGEX.exec(line.slice(k));
    if (!m) continue;
    if (found) return null; // >1 opener on the line — conservative skip
    found = { start: k, end: k + m[0].length, delim: m[3], stripTabs: m[1] === '-' };
  }
  return found;
}

/**
 * Remove well-formed heredoc bodies so the surviving command tokenizes to a
 * real signature (`cat > f << EOF\n{body}\nEOF` → `cat > f`). Heredoc bodies
 * are opaque stdin, not shell code — keeping them makes shell-quote choke AND
 * lets splitRaw mis-split a body containing `;`/`|` into phantom subcommands.
 * Only the `<<delim` operator span is dropped (trailing commands on the opener
 * line survive and stay checked), and only when a matching closer line exists.
 * Conservative: no opener / no closer / >1 opener per line → returned unchanged,
 * so the command keeps today's exact-match-only treatment.
 */
export function exciseHeredocBodies(command: string): string {
  if (!command.includes('<<')) return command;
  const lines = command.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const opener = findHeredocOpener(lines[i]);
    if (!opener) {
      out.push(lines[i]);
      continue;
    }
    let closerIdx = -1;
    for (let j = i + 1; j < lines.length; j++) {
      // Bash closes only on a line that EXACTLY equals the delimiter — leading
      // tabs are stripped for `<<-` only, never spaces; `.trim()` would over-
      // match an indented body line and close the heredoc early. Tolerate a
      // trailing CR so a Windows-authored CRLF closer still matches.
      const bare = lines[j].replace(TRAILING_CR_REGEX, '');
      const candidate = opener.stripTabs ? bare.replace(LEADING_TABS_REGEX, '') : bare;
      if (candidate === opener.delim) {
        closerIdx = j;
        break;
      }
    }
    if (closerIdx === -1) {
      // Unterminated heredoc — bash consumes the rest as its (opaque) body, so
      // append it FLATTENED (splitRaw separates on a newline, which would burst
      // a body into a phantom sub per line) and stop. The break bounds cost to
      // O(n): else many closer-less openers each re-scan to the end (O(n²)).
      out.push(lines.slice(i).join(' ').split('\r').join(' '));
      break;
    }
    // Drop the `<<delim` token only; keep text before AND after it on the line.
    out.push((lines[i].slice(0, opener.start) + lines[i].slice(opener.end)).trimEnd());
    i = closerIdx; // skip the body lines + the closer line
  }
  return out.join('\n');
}

/**
 * Extract leading `KEY=value` env assignments from string tokens, but only
 * for entries in `INERT_ENV_ASSIGNMENTS`. Unsafe `KEY=` tokens are left in place — the
 * matcher should fail prefix wildcards on them (`isExactMatchOnly`).
 */
function stripSafeEnvAssignments(tokens: ParseEntry[]): {
  rest: ParseEntry[];
  envAssignments: Record<string, string>;
} {
  const envAssignments: Record<string, string> = {};
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (typeof t !== 'string') break;
    const m = ENV_TOKEN_REGEX.exec(t);
    if (!m) break;
    if (!INERT_ENV_ASSIGNMENTS.has(m[1])) break;
    envAssignments[m[1]] = m[2];
  }
  return { rest: tokens.slice(i), envAssignments };
}

const REDIRECT_OP_REGEX = /^(?:&?>>?|\d?>>?|\d?<|<<<?|&>|>&)$/;
const FD_DIGIT_REGEX = /^\d$/;

/**
 * Strip redirection operators + their target tokens. shell-quote represents
 * `>` `<` `>>` etc. as `{op: '>'}`-shaped objects but also concatenates
 * `2>&1` into a single string token. Handle both.
 */
function stripRedirections(tokens: ParseEntry[]): {
  rest: ParseEntry[];
  redirections: string[];
} {
  const rest: ParseEntry[] = [];
  const redirections: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (typeof t === 'object' && t !== null && 'op' in t && REDIRECT_OP_REGEX.test(t.op)) {
      // shell-quote splits `2>&1` into ['2', {op:'>&'}, '1']. If the previous
      // token in `rest` is a single digit (file descriptor prefix), reclaim it
      // so signature extraction doesn't see a stray '2'.
      const prev = rest[rest.length - 1];
      let fdPrefix = '';
      if (typeof prev === 'string' && FD_DIGIT_REGEX.test(prev)) {
        fdPrefix = prev;
        rest.pop();
      }
      const target = tokens[i + 1];
      const targetStr = typeof target === 'string' ? target : '';
      redirections.push(`${fdPrefix}${t.op}${targetStr}`);
      if (target !== undefined) i++;
      continue;
    }
    if (typeof t === 'string' && REDIRECT_OP_REGEX.test(t)) {
      redirections.push(t);
      continue;
    }
    rest.push(t);
  }
  return { rest, redirections };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function splitCommand(command: string): SubCommand[] {
  const trimmed = command.trim();
  if (!trimmed) return [];
  // Strip provably-literal `$(cat <<'DELIM'…)` substitutions BEFORE excising
  // heredoc bodies: for a bare (unquoted-context) substitution the excise pass
  // would consume the body and break range detection. Then excise remaining
  // heredoc bodies: they are opaque stdin, and splitRaw would otherwise
  // mis-split a body containing `;`/`|` into phantom subcommands.
  const cleaned = inlineLiteralHeredocSubstitutions(trimmed) ?? trimmed;
  const rawChunks = splitRaw(exciseHeredocBodies(cleaned));
  const subs: SubCommand[] = [];
  for (const raw of rawChunks) {
    if (!raw || raw.startsWith('#')) continue;
    let tokens: ParseEntry[];
    try {
      tokens = parse(raw) as ParseEntry[];
    } catch {
      // shell-quote throws on malformed `${` substitutions. Surface as exact-only.
      subs.push({
        raw,
        tokens: [],
        redirections: [],
        envAssignments: {},
        hasExpansion: true,
      });
      continue;
    }
    const masked = maskSingleQuoted(raw);
    const hasExpansion = EXPANSION_REGEX.test(masked);
    const { rest: noEnv, envAssignments } = stripSafeEnvAssignments(tokens);
    const { rest: noRedir, redirections } = stripRedirections(noEnv);
    subs.push({
      raw,
      tokens: noRedir,
      redirections,
      envAssignments,
      hasExpansion,
    });
  }
  return subs;
}

export function extractSignature(sub: SubCommand): Signature {
  const stringTokens = sub.tokens.filter((t): t is string => typeof t === 'string');
  // Walk past unsafe `KEY=` tokens. (Safe ones were already stripped into envAssignments.)
  let baseIdx = 0;
  while (baseIdx < stringTokens.length && ENV_TOKEN_REGEX.test(stringTokens[baseIdx])) {
    baseIdx++;
  }
  if (stringTokens.length === 0) {
    // Keep the raw text: a command the tokenizer could not read (zsh-only forms
    // like `${(%)x}`) is still approvable by a rule quoting it exactly.
    return { base: '', fullSignature: sub.raw, isExactMatchOnly: true };
  }
  const base = stringTokens[baseIdx] ?? '';
  let subcommand: string | undefined;
  for (let i = baseIdx + 1; i < stringTokens.length; i++) {
    const tok = stringTokens[i];
    if (tok.startsWith('-')) {
      if (FLAGS_WITH_VALUES.has(tok)) i++;
      continue;
    }
    subcommand = tok;
    break;
  }
  // Expansion, an unsafe `KEY=` prefix and eval-like heads all keep base+subcommand
  // so an explicit prefix DENY still fires; exact-match-only stops a prefix ALLOW.
  if (sub.hasExpansion || baseIdx > 0 || EVAL_LIKE_HEADS.has(base)) {
    return { base, subcommand, fullSignature: sub.raw, isExactMatchOnly: true };
  }
  return {
    base,
    subcommand,
    fullSignature: subcommand ? `${base} ${subcommand}` : base,
    isExactMatchOnly: false,
  };
}
