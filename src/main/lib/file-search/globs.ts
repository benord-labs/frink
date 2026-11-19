import picomatch from 'picomatch';

// Paths reach the matcher with `/` on every OS, so Windows mode stays off. A leading `!` is a
// character, not negation: inverting one pattern would turn an exclude into "exclude everything".
const GLOB_OPTIONS = { dot: true, nocase: true, windows: false, nonegate: true };

function bracesClose(text: string): boolean {
  let depth = 0;
  for (const char of text) {
    if (char === '{') depth++;
    else if (char === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

const tidy = (patterns: string[]) => patterns.map((p) => p.trim()).filter((p) => p !== '');

/** A comma-separated glob list split into patterns. Commas inside `{a,b}` stay put; with an
 * unclosed `{` every comma splits, so one typo can't swallow the patterns after it. */
export function splitGlobList(text: string): string[] {
  if (!bracesClose(text)) return tidy(text.split(','));
  const patterns: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (char === ',' && depth === 0) {
      patterns.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  patterns.push(current);
  return tidy(patterns);
}

/** One typed pattern as the globs it means: `*.ts` matches at any depth, `src` also
 * matches everything under a `src` folder, and `.\src\x` reads as `src/x`. */
function expandPattern(pattern: string): string[] {
  // `.` and `./` both name the project root, so neither filters anything.
  let glob = pattern
    .replaceAll('\\', '/')
    .replace(/^\.(\/|$)/, '')
    .replace(/\/+$/, '');
  if (glob === '') return [];
  if (glob.startsWith('/')) glob = glob.slice(1);
  else if (!glob.includes('/')) glob = `**/${glob}`;
  return [glob, `${glob}/**`];
}

/** The regexes a glob list compiles to, ready to test `/`-separated project-relative paths.
 * picomatch turns a pattern it cannot read into one that matches nothing, never an error. */
export function compileGlobs(text: string): RegExp[] {
  return splitGlobList(text)
    .flatMap(expandPattern)
    .map((glob) => picomatch.makeRe(glob, GLOB_OPTIONS));
}
