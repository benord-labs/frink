/** Read-only shell commands over this chat's `pasted/` folder; Codex has no Read tool.
 * Flags are an allowlist with known arity; anything else asks. */

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { z } from 'zod';
import { isPathWithinProject } from '../../path-check';
import { maskQuoted, type SubCommand } from '../bash-parser';
import { isSystemDeniedPath } from '../system-denied-patterns';

type Spec = {
  /** getopt short flags without a value; clusters (`-An`) are read one char at a time. */
  short?: string;
  /** getopt short flags that take a value (`-n 5` or `-n5`). */
  shortValued?: string;
  /** Whole-token flags without a value (long `--x`, or single-dash words like `-layout`). */
  words?: readonly string[];
  /** Whole-token flags that take a value (`--lines=5`, `--lines 5`, `-enc UTF-8`). */
  wordValued?: readonly string[];
  /** Accepts `-5` as a line count. */
  numeric?: boolean;
  /** The first positional is a pattern unless `-e` named one. */
  pattern?: boolean;
  /** Runs with no path by reading stdin; false means a path is required. */
  stdin: boolean;
  /** Validates the positionals and returns the ones that are paths, or null. */
  paths?: (positionals: string[]) => string[] | null;
};

const LINE_RANGE_SCRIPT = /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/;
const HEAD_TAIL: Spec = {
  short: 'qv',
  shortValued: 'nc',
  words: ['--quiet', '--silent', '--verbose'],
  wordValued: ['--lines', '--bytes'],
  numeric: true,
  stdin: true,
};

const SPECS = new Map<string, Spec>([
  ['cat', { short: 'AbeEnstTuv', stdin: true }],
  ['head', HEAD_TAIL],
  ['tail', HEAD_TAIL],
  [
    'wc',
    {
      short: 'clmwL',
      words: ['--bytes', '--lines', '--chars', '--words', '--max-line-length'],
      stdin: true,
    },
  ],
  [
    'file',
    {
      short: 'bikNr',
      words: ['--brief', '--mime', '--mime-type', '--mime-encoding'],
      stdin: false,
    },
  ],
  // `-w` is left out: its value is optional, so `od -w 16 x` would hide a file named 16.
  ['od', { short: 'vcxbdo', shortValued: 'AtNj', stdin: true }],
  // xxd does not use getopt, so flags are whole tokens; a second positional is an output file.
  [
    'xxd',
    {
      words: ['-p', '-u', '-b', '-i'],
      wordValued: ['-l', '-s', '-c', '-g'],
      stdin: true,
      paths: (pos) => (pos.length <= 1 ? pos : null),
    },
  ],
  // Only `pdftotext <in> -`: with one positional it writes `<in>.txt` beside the attachment.
  [
    'pdftotext',
    {
      words: ['-layout', '-raw', '-nopgbrk', '-q'],
      wordValued: ['-f', '-l', '-enc', '-eol', '-opw', '-upw'],
      stdin: false,
      paths: (pos) => (pos.length === 2 && pos[1] === '-' ? [pos[0]] : null),
    },
  ],
  ['grep', { short: 'incLlvwxFEGhHoqsa', shortValued: 'emABC', pattern: true, stdin: true }],
  // rg with no path searches its working folder, so a path is required.
  [
    'rg',
    {
      short: 'nNiSFwvcloH',
      shortValued: 'emABC',
      words: ['--no-heading', '--color=never'],
      pattern: true,
      stdin: false,
    },
  ],
  // `sed -n '1,200p' f` only: a `w` or `e` script would write or run a command.
  [
    'sed',
    {
      short: 'n',
      stdin: true,
      paths: (pos) => (pos.length > 0 && LINE_RANGE_SCRIPT.test(pos[0]) ? pos.slice(1) : null),
    },
  ],
  ['nl', { shortValued: 'b', stdin: true }],
]);

const WORDS = z.array(z.string());
/** Unquoted, bash expands these (bracket globs, braces, tilde, history, `$'…'`) in any word. */
const UNQUOTED_EXPANSION = /[[\]{}~!$]/;

/** `..` resolves after any link before it, and braces expand; a realpath check sees neither. */
const UNSAFE_PATH_TEXT = /(?:^|[\\/])\.\.(?:[\\/]|$)|[{}]/;

export function hasUnsafePathText(path: string): boolean {
  return UNSAFE_PATH_TEXT.test(path);
}

type Parsed = { positionals: string[]; namedPattern: boolean };

/** One flag token's effect: how many following tokens it consumes, or null when unknown. */
function flagArity(token: string, spec: Spec): { consumes: number; pattern: boolean } | null {
  if (spec.words?.includes(token)) return { consumes: 0, pattern: false };
  if (spec.wordValued?.includes(token)) return { consumes: 1, pattern: false };
  const eq = token.indexOf('=');
  if (token.startsWith('--') && eq > 0 && spec.wordValued?.includes(token.slice(0, eq))) {
    return { consumes: 0, pattern: false };
  }
  if (token.startsWith('--')) return null;
  if (spec.numeric && /^-\d+$/.test(token)) return { consumes: 0, pattern: false };
  return clusterArity(token.slice(1), spec);
}

/** A getopt cluster such as `An` or `n5`: a valued flag takes the rest, or the next token. */
function clusterArity(chars: string, spec: Spec): { consumes: number; pattern: boolean } | null {
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (spec.shortValued?.includes(ch)) {
      return { consumes: i === chars.length - 1 ? 1 : 0, pattern: ch === 'e' };
    }
    if (!spec.short?.includes(ch)) return null;
  }
  return chars.length > 0 ? { consumes: 0, pattern: false } : null;
}

/** Splits argv into positionals, or null on any flag the spec does not list. */
function parseArgs(args: string[], spec: Spec): Parsed | null {
  const positionals: string[] = [];
  let namedPattern = false;
  let flagsDone = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!flagsDone && token === '--') {
      flagsDone = true;
    } else if (!flagsDone && token.startsWith('-') && token !== '-') {
      // BSD tools stop at the first positional and would read a later `-x` as a file.
      if (positionals.length > 0) return null;
      const arity = flagArity(token, spec);
      if (!arity || (arity.consumes > 0 && i + 1 >= args.length)) return null;
      namedPattern ||= arity.pattern;
      i += arity.consumes;
    } else {
      positionals.push(token);
    }
  }
  return { positionals, namedPattern };
}

/** The paths one subcommand reads, or null when it is not an inert read. */
function readPaths(sub: SubCommand): string[] | null {
  if (sub.hasExpansion || Object.keys(sub.envAssignments).length > 0) return null;
  // Any redirect asks: the parser takes a digit before one as its descriptor, so argv is unsure.
  if (sub.redirections.length > 0 || UNQUOTED_EXPANSION.test(maskQuoted(sub.raw))) return null;
  // A glob, `&` or parenthesis arrives as an operator object, so only plain words pass.
  const words = WORDS.safeParse(sub.tokens);
  if (!words.success) return null;
  const [base, ...args] = words.data;
  const spec = base === undefined ? undefined : SPECS.get(base);
  if (!spec) return null;
  const parsed = parseArgs(args, spec);
  if (!parsed) return null;
  const operands =
    spec.pattern && !parsed.namedPattern ? parsed.positionals.slice(1) : parsed.positionals;
  if (spec.pattern && !parsed.namedPattern && parsed.positionals.length === 0) return null;
  const paths = spec.paths ? spec.paths(operands) : operands;
  if (!paths || (paths.length === 0 && !spec.stdin)) return null;
  return paths;
}

/** An existing regular file inside the folder, reached through no link and with one name. */
function isPastedFile(file: string, pastedDir: string): boolean {
  if (!nodePath.isAbsolute(file) || hasUnsafePathText(file)) return false;
  try {
    const real = nodeFs.realpathSync.native(file);
    if (!isPathWithinProject(real, pastedDir) || !isOneNameFile(file)) return false;
    return !isSystemDeniedPath(real, pastedDir);
  } catch {
    return false;
  }
}

const MAX_SEARCHED_ENTRIES = 500;

/** Each entry under `dir` is a one-name file or such a folder, none on the system deny list,
 * within the entry budget. Each child is re-read with lstat, so a swapped-in link never passes. */
function isLinkFreeTree(dir: string, budget: { left: number }): boolean {
  const handle = nodeFs.opendirSync(dir);
  try {
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      if (--budget.left < 0) return false;
      const child = nodePath.join(dir, entry.name);
      if (isSystemDeniedPath(child, dir)) return false;
      const stat = nodeFs.lstatSync(child);
      if (stat.isDirectory() ? !isLinkFreeTree(child, budget) : !isOneName(stat)) return false;
    }
    return true;
  } finally {
    handle.closeSync();
  }
}

function isOneName(stat: nodeFs.Stats): boolean {
  return stat.isFile() && stat.nlink === 1;
}

function isOneNameFile(file: string): boolean {
  return isOneName(nodeFs.lstatSync(file));
}

/** A search root inside `pastedDir` whose every file has one name, so a search reads only there. */
export function isPastedSearchRoot(root: string, pastedDir: string): boolean {
  try {
    if (!isPathWithinProject(root, pastedDir)) return false;
    const stat = nodeFs.lstatSync(root);
    if (stat.isFile()) return stat.nlink === 1;
    return stat.isDirectory() && isLinkFreeTree(root, { left: MAX_SEARCHED_ENTRIES });
  } catch {
    return false;
  }
}

/** Every subcommand is an allowlisted read of files in `pastedDir`, at least one named.
 * Whole-command, so an earlier part cannot swap a file a later read opens. */
export function isSessionPastedRead(subs: SubCommand[], pastedDir: string): boolean {
  let named = 0;
  for (const sub of subs) {
    const paths = readPaths(sub);
    if (!paths || !paths.every((p) => isPastedFile(p, pastedDir))) return false;
    named += paths.length;
  }
  return named > 0;
}
