/** The directory a Glob/Grep call reads. Glob's pattern prefix can widen it; Grep's `glob`
 * only filters, so it never does. Pure, shared by the hook remap and `checkSearch`. */

import * as nodePath from 'node:path';
import picomatch from 'picomatch';
import { expandHomePath } from '../../../../../shared/lib/expand-home';

// Innermost brace set / extglob group: `{a,b}`, `@(a|b)`, `!(x)`, `+(x)`, `*(x)`, `?(x)`.
const GROUP = /\{[^{}]*\}|[@!?*+]\([^()]*\)/;

/** Case as the filesystem sees it: macOS and Windows are case-insensitive by default (`.SSH`
 * is `.ssh`), Linux is not. */
export function foldCase(path: string): string {
  return process.platform === 'darwin' || process.platform === 'win32' ? path.toLowerCase() : path;
}

/** A leading run of `!` negates when odd (`!!x` is positive). A `!` that opens an extglob
 * (`!(x)`) is not part of the run. */
export function splitNegation(glob: string): { negated: boolean; body: string } {
  let bangs = /^!*/.exec(glob)?.[0].length ?? 0;
  if (bangs > 0 && glob[bangs] === '(') bangs -= 1;
  return { negated: bangs % 2 === 1, body: glob.slice(bangs) };
}

export function stringArg(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** True when an alternative group spans directories (`{src,/etc}`) or has a `..` alternative
 * (`{..,src}`); a range like `{1..3}` names files, not a parent. */
function hasPathAlternative(pattern: string): boolean {
  let rest = pattern;
  for (let match = GROUP.exec(rest); match; match = GROUP.exec(rest)) {
    const body = match[0];
    const inner = body.startsWith('{') ? body.slice(1, -1) : body.slice(2, -1);
    const alternatives = inner.split(body.startsWith('{') ? ',' : '|');
    if (inner.includes('/') || alternatives.some((alt) => alt === '..')) return true;
    rest = rest.replace(body, '_');
  }
  return false;
}

/** True when a wildcard segment can match `..` (`[.][.]`, `.?`, `.*`) — it may climb. */
function canClimb(globPart: string): boolean {
  return globPart
    .split('/')
    .some(
      (segment) =>
        segment === '..' || (segment !== '' && picomatch.isMatch('..', segment, { dot: true })),
    );
}

/** Normalised Glob pattern, or undefined when the call has none. */
export function globPattern(input: unknown): string | undefined {
  const raw = stringArg(input, 'pattern');
  if (!raw) return undefined;
  // picomatch treats `\` as an escape; Windows patterns arrive with native separators.
  return expandHomePath(process.platform === 'win32' ? raw.replace(/\\/g, '/') : raw);
}

/** Root to check, `'.'` = caller cwd. A Glob whose wildcard part can leave its static prefix
 * widens to the filesystem root, which the gate always asks about. */
export function searchRootFromInput(toolName: string, input: unknown): string {
  const base = expandHomePath(stringArg(input, 'path') ?? '.');
  if (toolName !== 'Glob') return base;

  const raw = globPattern(input);
  if (!raw) return base;
  const { negated, body: pattern } = splitNegation(raw);
  const scanned = picomatch.scan(pattern);
  // A negated pattern (`!.ssh/**`) excludes its prefix: it searches from `path`, not into it.
  const staticPrefix = negated ? '' : scanned.base;
  const globPart = negated ? '' : scanned.isGlob ? pattern.slice(staticPrefix.length) : '';
  // picomatch keeps escapes in `base` (`\.\./.ssh`); the filesystem path is the unescaped text.
  const literalPrefix = staticPrefix.replace(/\\(.)/g, '$1');
  const resolved = nodePath.isAbsolute(literalPrefix)
    ? literalPrefix
    : nodePath.join(base, literalPrefix);
  if (hasPathAlternative(globPart) || canClimb(globPart)) {
    return nodePath.parse(nodePath.resolve(resolved)).root;
  }
  return resolved;
}
