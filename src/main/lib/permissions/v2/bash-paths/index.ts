/** Tier-1c path extraction for the Bash checker: the paths a subcommand reads or writes, and
 * whether any hits a system deny list. Rule evaluation stays in check-bash. */

import type { ParseEntry } from 'shell-quote';
import type { SubCommand } from '../bash-parser';
import { expandTilde } from '../check-edit';
import { isShellStartupPath, isSystemDeniedPath } from '../system-denied-patterns';
import type { DenyReason } from '../types';

/** Commands that READ a path argument — bash-Read parity, so `Bash(cat:*)` cannot
 * read a system-denied `.env`. */
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
  // These also emit file CONTENT. Metadata-only commands (ls, stat, find, du, tree)
  // are absent on purpose: they leak a filename, not contents.
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

/** Non-flag args may be a pattern, a flag value or a path, so only path-shaped tokens
 * are checked — `grep -C 3 .env README.md` must not hard-deny. */
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

/** Operator prefix of a `stripRedirections` string (`'>/tmp/foo'`, `'2>&1'`); stripping it
 * recovers the target, and a lone digit left over is an fd, not a path. */
const REDIRECT_OP_PREFIX = /^(?:&?>>?|\d?>>?|\d?<|<<<?|&>|>&)/;
const LONE_DIGIT = /^\d+$/;

/** shell-quote emits an unquoted glob as `{ op: 'glob' }`; keep its literal pattern so
 * `cat ~/.ssh/*` still yields a path to check. */
function tokenAsPathString(token: ParseEntry): string | null {
  if (typeof token === 'string') return token;
  if (typeof token === 'object' && token !== null && 'op' in token && token.op === 'glob') {
    return (token as { op: 'glob'; pattern: string }).pattern;
  }
  return null;
}

/** Only `unambiguous` paths reach the deny lists; `write` adds the startup list
 * (agent-persistence-write-deny, bash-command-permission-safety-tier). */
type BashPathArg = { path: string; unambiguous: boolean; write: boolean };

/** Copy-shaped writers: the first operand is the source, so `cp ~/.zshrc bak` stays a read. */
const COPY_COMMANDS = new Set(['cp', 'install', 'rsync']);
/** Copy flags whose value is a separate token, so it is never taken for the destination. */
const COPY_VALUE_FLAGS = new Set([
  '-m',
  '--mode',
  '-o',
  '--owner',
  '-g',
  '--group',
  '-S',
  '--suffix',
  '-e',
  '--rsh',
]);
const FD_DUP_TARGET = /^(?:\d+-?|-)$/;

/** `cp -t DIR` / `--target-directory[=]DIR` / `-tDIR` before `--`: the destination, and the
 * index of a separate DIR token. Not rsync, whose `-t` preserves mtimes. */
function copyTargetDir(tokens: string[], head: number): { dir: string; index: number } | null {
  if (tokens[head] === 'rsync') return null;
  for (let k = head + 1; k < tokens.length && tokens[k] !== '--'; k++) {
    const tok = tokens[k];
    if ((tok === '-t' || tok === '--target-directory') && tokens[k + 1]) {
      return { dir: tokens[k + 1], index: k + 1 };
    }
    if (tok.startsWith('--target-directory=')) return { dir: tok.slice(19), index: -1 };
    if (/^-t./.test(tok)) return { dir: tok.slice(2), index: -1 };
  }
  return null;
}

/** Non-flag operands after the head; `--` ends options, and `skip` drops flag values. */
function positionalOperands(
  tokens: string[],
  head: number,
  skip: (k: number) => boolean,
): string[] {
  const operands: string[] = [];
  let endOfOptions = false;
  for (let j = head + 1; j < tokens.length; j++) {
    const tok = tokens[j];
    if (tok === '--' && !endOfOptions) {
      endOfOptions = true;
      continue;
    }
    // GNU long-flags `--target=/etc/passwd` get skipped here. Best-effort
    // per ticket 05 §38; documented limitation, not a bug.
    if (!endOfOptions && (tok.startsWith('-') || skip(j))) continue;
    operands.push(tok);
  }
  return operands;
}

/** Deny-leaning: only a copy's FIRST operand is a read, so a misparse never hides a write. */
function copyOperandPaths(tokens: string[], head: number): BashPathArg[] {
  const target = copyTargetDir(tokens, head);
  const isFlagValue = (k: number): boolean =>
    k === target?.index || COPY_VALUE_FLAGS.has(tokens[k - 1]);
  const operands = positionalOperands(tokens, head, isFlagValue).map((path, n): BashPathArg => ({
    path,
    unambiguous: true,
    write: !target && n > 0,
  }));
  return target ? [{ path: target.dir, unambiguous: true, write: true }, ...operands] : operands;
}

function operandPaths(cmd: string, tokens: string[], head: number): BashPathArg[] {
  if (COPY_COMMANDS.has(cmd)) return copyOperandPaths(tokens, head);
  const ambiguous = PATTERN_ARG_COMMANDS.has(cmd);
  const write = WRITE_COMMANDS.has(cmd);
  return positionalOperands(tokens, head, () => false).map((path) => ({
    path,
    unambiguous: !ambiguous || looksLikePath(path),
    write,
  }));
}

/** An output redirection is a write; `>&2` is an fd-dup, but `>& file` opens the file. */
function redirectionPath(redir: string): BashPathArg | null {
  const write = !(redir.match(REDIRECT_OP_PREFIX)?.[0] ?? '').includes('<');
  const stripped = redir.replace(REDIRECT_OP_PREFIX, '').trim();
  const target = stripped.startsWith('&') ? stripped.slice(1).trim() : stripped;
  if (!target || FD_DUP_TARGET.test(target) || LONE_DIGIT.test(target)) return null;
  return { path: target, unambiguous: true, write };
}

function extractBashPaths(sub: SubCommand): BashPathArg[] {
  const tokens = sub.tokens.map(tokenAsPathString).filter((t): t is string => t !== null);
  // Skip leading KEY= tokens. Safe envs already moved to envAssignments;
  // unsafe envs left in tokens — neither is a path.
  let i = 0;
  while (i < tokens.length && ENV_TOKEN_REGEX.test(tokens[i])) i++;
  const cmd = tokens[i];
  const reads = cmd && (READ_COMMANDS.has(cmd) || WRITE_COMMANDS.has(cmd));
  const paths = reads ? operandPaths(cmd, tokens, i) : [];
  for (const redir of sub.redirections) {
    const path = redirectionPath(redir);
    if (path) paths.push(path);
  }
  return paths;
}

/** A metachar outside the final segment hides the directory the deny list matches on
 * (`~/.c*fig/gcloud/creds`). */
const METACHAR_IN_DIRECTORY = /[*?[{][^/]*\//;

export function findSystemDeniedPathInSub(sub: SubCommand, projectRoot: string): DenyReason | null {
  for (const { path, unambiguous, write } of extractBashPaths(sub)) {
    if (!unambiguous) continue;
    const expanded = expandTilde(path);
    if (isSystemDeniedPath(expanded, projectRoot)) return { kind: 'safety:path', path: expanded };
    if (write && isShellStartupPath(expanded, projectRoot)) {
      return { kind: 'safety:write-path', path: expanded };
    }
  }
  return null;
}

/** A path the deny list cannot evaluate: the caller makes the signature exact-match-only
 * (asks) rather than hard-denying ordinary globs. */
export function hasUnresolvableDirectory(sub: SubCommand): boolean {
  return extractBashPaths(sub).some(({ path }) => METACHAR_IN_DIRECTORY.test(path));
}
