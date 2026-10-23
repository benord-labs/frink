/** A prefix Bash rule approves the command, not where it writes: an output redirect
 * outside the project (or one that cannot be resolved) asks. */

import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { z } from 'zod';
import { extractSignature, type SubCommand } from '../bash-parser';

/** `cwd`: where the provider says the command runs (the Claude hook or Codex), never model input. */
export type RedirectRoots = { projectRoot: string; executionRoot?: string; cwd?: string };

/** `[fd]op[target]` as recorded by the parser: `2>&1`, `>>~/.zshrc`, bare `>`. */
const REDIRECTION = /^(\d*|&)(>>|>&|<>|>|<<<|<<|<)(.*)$/s;
const FD_DUP_TARGET = /^(?:\d+|-)$/;
const GLOB_CHARS = /[*?[{]/;
const REWRITTEN_CHARS = /[\\$]/;
const DEV_FD = /^\/dev\/fd\/\d+$/;
const WRITE_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);
const TEMP_DIRS = ['/tmp', '/private/tmp', '/var/tmp'];
const MISSING = z.object({ code: z.literal('ENOENT') });
const BACKGROUND = z.object({ op: z.literal('&') });
const WORD_OR_GLOB = z.union([z.string(), z.object({ op: z.literal('glob') })]);
/** Commands that cannot create links, move files or change folder, so they cannot change where a
 * redirect elsewhere in the same command lands. Anything else might (`tar`, `git`, `cd`, a script). */
const INERT_COMMANDS = new Set([
  ...['cat', 'echo', 'false', 'grep', 'head', 'ls', 'mkdir', 'printf', 'pwd'],
  ...['sort', 'tail', 'test', 'touch', 'true', 'wc', '[', ':'],
]);

/** Realpath of the deepest existing ancestor plus the missing tail; null for an entry
 * that exists but will not resolve (a dangling link writes wherever it points). */
function resolveForContainment(absolutePath: string): string | null {
  const tail: string[] = [];
  let current = nodePath.resolve(absolutePath);
  for (;;) {
    try {
      return nodePath.join(nodeFs.realpathSync.native(current), ...tail);
    } catch (error) {
      // Not a plain "missing" (unreadable, under a file, a dangling link): cannot vouch for it.
      if (!MISSING.safeParse(error).success || entryExists(current)) return null;
    }
    const parent = nodePath.dirname(current);
    if (parent === current) return nodePath.resolve(absolutePath);
    tail.unshift(nodePath.basename(current));
    current = parent;
  }
}

function entryExists(path: string): boolean {
  try {
    return nodeFs.lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return true;
  }
}

/** Segment by segment, so a link resolves before a `..` after it, as the kernel does. */
function resolveTarget(base: string, target: string): string | null {
  const start = nodePath.isAbsolute(target) ? nodePath.parse(nodePath.resolve(target)).root : base;
  let current = resolveForContainment(start);
  for (const segment of target.split(nodePath.sep === '\\' ? /[\\/]/ : '/')) {
    if (current === null) return null;
    if (segment === '' || segment === '.') continue;
    current =
      segment === '..'
        ? nodePath.dirname(current)
        : resolveForContainment(nodePath.join(current, segment));
  }
  return current;
}

function baseOf(roots: RedirectRoots): string {
  return roots.cwd || roots.executionRoot || roots.projectRoot;
}

function isInside(target: string, root: string): boolean {
  return (
    target === root || target.startsWith(root.endsWith(nodePath.sep) ? root : root + nodePath.sep)
  );
}

function writableRoots({ projectRoot, executionRoot }: RedirectRoots): string[] {
  const roots = [projectRoot, executionRoot, ...TEMP_DIRS, nodeOs.tmpdir()];
  return roots
    .filter((root): root is string => Boolean(root))
    .map(resolveForContainment)
    .filter((root): root is string => root !== null);
}

function targetEscapes(target: string, roots: RedirectRoots): boolean {
  // `\` and `$` survive tokenizing literally while bash rewrites them (`$'\x2f'`, `$'/etc'`).
  if (
    !target ||
    target.startsWith('~') ||
    REWRITTEN_CHARS.test(target) ||
    GLOB_CHARS.test(target)
  ) {
    return true;
  }
  const base = baseOf(roots);
  if (!nodePath.isAbsolute(target) && !base) return true;
  const resolved = resolveTarget(base, target);
  if (resolved === null) return true;
  return !writableRoots(roots).some((root) => isInside(resolved, root));
}

/** One recorded redirection: true when it writes somewhere a prefix rule must not cover. */
function redirectionEscapes(redirection: string, roots: RedirectRoots, settled: boolean): boolean {
  const match = REDIRECTION.exec(redirection);
  if (!match) return true;
  const [, , op, rawTarget] = match;
  if (op === '<' || op === '<<' || op === '<<<') return false;
  const target = rawTarget.trim();
  if (op === '>&' && FD_DUP_TARGET.test(target)) return false;
  if (WRITE_SINKS.has(target) || DEV_FD.test(target)) return false;
  return !settled || targetEscapes(target, roots);
}

/** Plain words only: an operator token can make it something else (`cat() ( ln … )`). */
function isInert(sub: SubCommand): boolean {
  const sig = extractSignature(sub);
  const plain = sub.tokens.every((token) => WORD_OR_GLOB.safeParse(token).success);
  return plain && !sig.isExactMatchOnly && INERT_COMMANDS.has(sig.base);
}

function runsInBackground(sub: SubCommand): boolean {
  return sub.tokens.some((token) => BACKGROUND.safeParse(token).success);
}

/** Redirects open before their command runs, so they're judgeable only if every earlier or
 * piped-into part is inert and nothing runs in the background. */
export function redirectSettled(subs: readonly SubCommand[], index: number): boolean {
  if (subs.some(runsInBackground)) return false;
  let pipedInto = subs[index]?.pipesOn ?? false;
  return subs.every((sub, j) => {
    if (j <= index) return j === index || isInert(sub);
    const concurrent = pipedInto;
    pipedInto = pipedInto && sub.pipesOn;
    return !concurrent || isInert(sub);
  });
}

/** `settled`: from `redirectSettled`; when false, every redirect to a real file asks. */
export function hasEscapingRedirect(
  sub: SubCommand,
  roots: RedirectRoots,
  settled = true,
): boolean {
  return sub.redirections.some((redirection) => redirectionEscapes(redirection, roots, settled));
}
