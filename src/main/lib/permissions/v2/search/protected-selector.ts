/** Does a Glob pattern / Grep `glob` filter select a system-denied path? Decided by widening the
 * selector to a star-only pattern and intersecting it exactly with each deny pattern. */

import picomatch from 'picomatch';
import { SYSTEM_DENIED_PATTERNS } from '../system-denied-patterns';
import { foldCase, globPattern, splitNegation, stringArg } from './search-root';

type Segments = string[];

const MAX_ALTERNATIVES = 64;
// A plain "every file of type X" filter: `*`, `**`, `*.ts`, `*.*`.
const TYPE_FILTER = /^\*+(\.(\*|[^*?[\]{}()@!+\\]+))?$/;
const ESCAPE_BASE = 0xe000;
const ESCAPE_SPAN = 0x1000;
const GLOB_SPECIAL = '*?[]{}()!+@|';
// A widened class / extglob: a star that, unlike `*` and `?`, can match a leading dot (`[.]ssh`).
const DOT_STAR = '\uf000';
const EXTGLOB = /[@!?*+]\([^()]*\)/;
const isStar = (char: string | undefined) => char === '*' || char === DOT_STAR;

const DENIED = SYSTEM_DENIED_PATTERNS.map((pattern) => {
  const segments = pattern.toLowerCase().split('/');
  return { pattern, segments, dot: segments.some((part) => part.startsWith('.')) };
});

/** Brace-expand `{a,b}` (innermost first). A range (`{1..3}`) widens to `*`.
 * Returns undefined past MAX_ALTERNATIVES — the caller then treats the selector as protected. */
function expandBraces(selector: string): string[] | undefined {
  let pending = [selector];
  const done: string[] = [];
  while (pending.length) {
    const next = pending.pop() as string;
    const match = /\{([^{}]*)\}/.exec(next);
    if (!match) {
      done.push(next);
    } else {
      const head = next.slice(0, match.index);
      const tail = next.slice(match.index + match[0].length);
      const inner = match[1];
      const options = inner.includes(',') ? inner.split(',') : [inner.includes('..') ? '*' : inner];
      pending.push(...options.map((option) => `${head}${option}${tail}`));
    }
    if (done.length + pending.length > MAX_ALTERNATIVES) return undefined;
  }
  return done;
}

/** `@(a|b)` / `?(a|b)` become brace sets (`{a,b}` / `{,a,b}`) so they expand exactly; the
 * repeating / negating kinds widen to DOT_STAR. Undefined when a group spans directories. */
function extglobsToBraces(selector: string): string | undefined {
  let text = selector;
  for (let group = EXTGLOB.exec(text); group; group = EXTGLOB.exec(text)) {
    const [whole] = group;
    if (whole.includes('/')) return undefined;
    const alternatives = whole.slice(2, -1).split('|').join(',');
    const replacement =
      whole[0] === '@' ? `{${alternatives}}` : whole[0] === '?' ? `{,${alternatives}}` : DOT_STAR;
    text = text.replace(whole, replacement);
  }
  return text;
}

/** Escapes become sentinels that encode their character (`\*` stays a literal star, never a
 * wildcard), so every later parse step treats them as plain text. */
function hideEscapes(text: string): string {
  return text.replace(/\\([\s\S])/g, (_, char: string) =>
    String.fromCharCode(ESCAPE_BASE + (char.charCodeAt(0) % ESCAPE_SPAN)),
  );
}

/** Restore hidden plain characters; glob-special ones stay sentinels (literal, never wildcards). */
function revealEscapes(text: string, keepSpecial: boolean): string {
  return text.replace(/[\ue000-\uefff]/g, (c) => {
    const char = String.fromCharCode(c.charCodeAt(0) - ESCAPE_BASE);
    return keepSpecial && GLOB_SPECIAL.includes(char) ? c : char;
  });
}

/** Index of the `]` closing the class opened at `start`, or -1 if it never closes. A leading
 * `]` (after an optional `!`/`^`) is literal; `[:name:]` inside is skipped whole. */
function classEnd(text: string, start: number): number {
  let j = start + 1;
  if (text[j] === '!' || text[j] === '^') j += 1;
  if (text[j] === ']') j += 1;
  while (j < text.length && text[j] !== ']') {
    const posixClose = text.startsWith('[:', j) ? text.indexOf(':]', j + 2) : -1;
    j = posixClose === -1 ? j + 1 : posixClose + 2;
  }
  return j < text.length ? j : -1;
}

/** Character classes (`[.]`, `[!a]`, `[[:alpha:]]`, `[]x]`) become DOT_STAR; an unclosed `[`
 * also widens (conservative), so the result can only over-report. */
function widenClasses(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const end = text[i] === '[' ? classEnd(text, i) : i;
    out += text[i] === '[' ? DOT_STAR : text[i];
    i = Math.max(end, i) + 1;
  }
  return out;
}

/** One brace-free alternative (escapes already hidden) as star-only segments: `?` widens to
 * `*`, classes to DOT_STAR, and a whole-segment star run is `**`. */
function toStarSegments(alternative: string): Segments | undefined {
  // Extglobs were turned into braces or DOT_STAR upstream; a leftover `(` is unparseable.
  if (/[@!?*+]\(/.test(alternative)) return undefined;
  return revealEscapes(widenClasses(alternative).replace(/\?/g, '*'), true)
    .split('/')
    .filter(Boolean)
    .map((segment) =>
      /^\*{2,}$/.test(segment)
        ? '**'
        : segment.replace(/[*\uf000]+/g, (run) => (run.includes(DOT_STAR) ? DOT_STAR : '*')),
    );
}

type IntersectRules<T> = {
  /** A wildcard on the selector side (it may absorb any number of denied-side items). */
  selectorStar: (item: T | undefined) => boolean;
  /** A wildcard on the denied side. */
  deniedStar: (item: T | undefined) => boolean;
  /** Whether a selector wildcard may absorb this denied-side item. */
  absorbs: (item: T) => boolean;
  /** Two non-wildcard items can name the same thing. */
  match: (selector: T, denied: T) => boolean;
};

/** Do two wildcard sequences share a member? Memoised two-pointer walk; each step is tiny. */
function intersects<T>(selector: readonly T[], denied: readonly T[], rules: IntersectRules<T>) {
  const memo = new Map<string, boolean>();
  const walk = (i: number, j: number): boolean => {
    const key = `${i}:${j}`;
    if (!memo.has(key)) memo.set(key, step(i, j));
    return memo.get(key) as boolean;
  };
  const selectorStep = (i: number, j: number) =>
    walk(i + 1, j) || (j < denied.length && rules.absorbs(denied[j]) && walk(i, j + 1));
  const deniedStep = (i: number, j: number) =>
    walk(i, j + 1) || (i < selector.length && walk(i + 1, j));
  const literalStep = (i: number, j: number) =>
    i < selector.length &&
    j < denied.length &&
    rules.match(selector[i], denied[j]) &&
    walk(i + 1, j + 1);
  const step = (i: number, j: number): boolean => {
    if (i === selector.length && j === denied.length) return true;
    if (rules.selectorStar(selector[i])) return selectorStep(i, j);
    return rules.deniedStar(denied[j]) ? deniedStep(i, j) : literalStep(i, j);
  };
  return walk(0, 0);
}

/** Two star-only segment patterns share a name. A selector `*` (not DOT_STAR) skips a leading dot. */
function segmentsIntersect(selector: string, denied: string): boolean {
  if (selector.startsWith('*') && denied.startsWith('.')) return false;
  return intersects([...selector], [...denied], {
    selectorStar: isStar,
    deniedStar: (char) => char === '*',
    absorbs: () => true,
    match: (a, b) => a === b,
  });
}

/** The selector's segments can select a path the denied segments match (`**` spans segments;
 * a selector `**` never enters a literal dot-directory). */
function pathsIntersect(selector: Segments, denied: Segments): boolean {
  return intersects(selector, denied, {
    selectorStar: (segment) => segment === '**',
    deniedStar: (segment) => segment === '**',
    absorbs: (segment) => segment === '**' || !segment.startsWith('.'),
    match: segmentsIntersect,
  });
}

/** One alternative selects a denied path (exact), bar `.env.example`; a plain type filter counts
 * against a non-dot secret only if every file it selects is protected. */
function alternativeSelects(alternative: string, deniedList: typeof DENIED): boolean {
  const segments = toStarSegments(foldCase(alternative));
  if (!segments) return true;
  if (!segments.length) return false;
  const last = revealEscapes(alternative, true).split('/').filter(Boolean).at(-1) ?? '';
  if (foldCase(revealEscapes(last, false)) === '.env.example') return false;
  const typeFilter = TYPE_FILTER.test(last);
  const everyMatchProtected = (pattern: string) =>
    picomatch.isMatch(last.replace(/\*/g, 'frink-any'), pattern, {
      dot: true,
      nocase: foldCase('A') === 'a',
    });
  return deniedList.some(
    (denied) =>
      (denied.dot || !typeFilter || everyMatchProtected(denied.pattern)) &&
      pathsIntersect(segments, denied.segments),
  );
}

/** True when the Glob pattern (below its root) or Grep's `glob` filter selects a protected
 * path. Glob lists names only, so it counts dot-paths; Grep reads contents, so it counts all. */
export function searchTargetsProtectedPath(toolName: string, input: unknown): boolean {
  const raw = toolName === 'Glob' ? globPattern(input) : stringArg(input, 'glob');
  if (!raw) return false;
  const { negated, body: filter } = splitNegation(hideEscapes(raw));
  // Negated selectors select everything else, protected paths included.
  if (negated) return true;
  const scanned = picomatch.scan(filter);
  const selector = (toolName === 'Glob' ? filter.slice(scanned.base.length) : filter).replace(
    /^\/+/,
    '',
  );
  if (!selector) return false;
  const deniedList = toolName === 'Glob' ? DENIED.filter((denied) => denied.dot) : DENIED;
  const braced = extglobsToBraces(selector);
  const alternatives = braced === undefined ? undefined : expandBraces(braced);
  if (!alternatives) return true;
  return alternatives.some((alternative) => alternativeSelects(alternative, deniedList));
}
