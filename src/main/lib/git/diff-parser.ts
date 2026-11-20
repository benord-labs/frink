/**
 * Diff Parser - Server-side parsing of unified diff format
 *
 * Moved from renderer to main process to:
 * - Avoid blocking UI on large diffs
 * - Single source of truth for diff parsing logic
 * - Enable prefetching file contents in the same request
 */

export type ParsedDiffFile = {
  key: string;
  oldPath: string;
  newPath: string;
  diffText: string;
  isBinary: boolean;
  additions: number;
  deletions: number;
  isValid: boolean;
  fileLang: string | null;
  isNewFile: boolean;
  isDeletedFile: boolean;
};

/**
 * Language mapping for syntax highlighting
 */
const LANG_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  css: 'css',
  scss: 'scss',
  less: 'less',
  json: 'json',
  md: 'markdown',
  mdx: 'markdown',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  vue: 'vue',
  svelte: 'svelte',
};

/**
 * Regex pattern for hunk headers in unified diff format
 */
const HUNK_HEADER_REGEX = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
const DIFF_GIT_PATH_REGEX = /^diff --git a\/(.+) b\/(.+)$/;
const QUOTED_DIFF_GIT_PATH_REGEX = /^diff --git ("a\/(?:[^"\\]|\\.)*") ("b\/(?:[^"\\]|\\.)*")$/;

/**
 * Get language identifier for syntax highlighting
 */
function getFileLang(filePath: string): string | null {
  if (!filePath || filePath === '/dev/null') return null;
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return LANG_MAP[ext] || ext || null;
}

/**
 * Validate if a diff hunk has valid structure
 * This is a lenient validator - only reject clearly malformed diffs
 */
function validateDiffHunk(diffText: string): { valid: boolean; reason?: string } {
  if (!diffText || diffText.trim().length === 0) {
    return { valid: false, reason: 'empty diff' };
  }

  const lines = diffText.split('\n');

  // Find the --- and +++ lines
  const minusLineIdx = lines.findIndex((l) => l.startsWith('--- '));
  const plusLineIdx = lines.findIndex((l) => l.startsWith('+++ '));

  // Must have both header lines
  if (minusLineIdx === -1 || plusLineIdx === -1) {
    return { valid: false, reason: 'missing header lines' };
  }

  // +++ must come after ---
  if (plusLineIdx <= minusLineIdx) {
    return { valid: false, reason: 'header order wrong' };
  }

  // Check for special cases that don't have hunks
  if (
    diffText.includes('new mode') ||
    diffText.includes('old mode') ||
    diffText.includes('rename from') ||
    diffText.includes('rename to') ||
    diffText.includes('Binary files')
  ) {
    return { valid: true };
  }

  // Must have at least one hunk header after +++ line
  let hasHunk: boolean = false;
  for (let i = plusLineIdx + 1; i < lines.length; i++) {
    if (HUNK_HEADER_REGEX.test(lines[i] || '')) {
      hasHunk = true;
      break;
    }
  }

  if (!hasHunk) {
    return { valid: false, reason: 'no hunk headers found' };
  }

  return { valid: true };
}

/** Git's one-letter escapes; `\"` and `\\` stand for the character itself. */
const C_ESCAPES = new Map([
  ['a', 7],
  ['b', 8],
  ['t', 9],
  ['n', 10],
  ['v', 11],
  ['f', 12],
  ['r', 13],
]);

/** Undoes git's C-style quoting of a path with a quote, backslash, control or non-ASCII byte.
 * Bytes that are not valid UTF-8 become replacement characters, so the result is never quoted. */
export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const bytes: number[] = [];
  for (const [text, escape] of raw.slice(1, -1).matchAll(/\\([0-7]{3}|.)|[^\\]+/gs)) {
    if (escape === undefined) bytes.push(...Buffer.from(text, 'utf8'));
    else if (escape.length === 3) bytes.push(parseInt(escape, 8));
    else
      bytes.push(
        ...Buffer.from(String.fromCharCode(C_ESCAPES.get(escape) ?? escape.charCodeAt(0))),
      );
  }
  return Buffer.from(bytes).toString('utf8');
}

/** A `---`/`+++` header's path, unquoted and without its `a/` or `b/` side prefix. */
function headerPath(line: string, prefix: 'a/' | 'b/'): string {
  const path = unquoteGitPath(line.slice(4).trim());
  return path.startsWith(prefix) ? path.slice(2) : path;
}

/** The two paths on a `diff --git` line, or null when it names none. */
function diffGitPaths(line: string) {
  const quoted = line.match(QUOTED_DIFF_GIT_PATH_REGEX);
  if (quoted?.[1] && quoted[2]) {
    return {
      oldPath: unquoteGitPath(quoted[1]).slice(2),
      newPath: unquoteGitPath(quoted[2]).slice(2),
    };
  }
  const plain = line.match(DIFF_GIT_PATH_REGEX);
  return plain?.[1] && plain[2] ? { oldPath: plain[1], newPath: plain[2] } : null;
}

/** Reads a file block's paths from the lines before its first hunk; `---`/`+++` win. */
function scanHeader(headerLines: string[]) {
  let oldPath = '';
  let newPath = '';
  let isBinary = false;
  for (const line of headerLines) {
    if (line.startsWith('--- ')) oldPath = headerPath(line, 'a/');
    else if (line.startsWith('+++ ')) newPath = headerPath(line, 'b/');
    else if (line.startsWith('Binary files ') && line.endsWith(' differ')) isBinary = true;
  }
  const named = headerLines.map(diffGitPaths).find((paths) => paths !== null);
  return {
    oldPath: oldPath || named?.oldPath || '',
    newPath: newPath || named?.newPath || '',
    isBinary,
  };
}

/** Counts added and removed lines; every line here is hunk content, never a path header. */
function countChanges(hunkLines: string[]) {
  let additions = 0;
  let deletions = 0;
  for (const line of hunkLines) {
    if (HUNK_HEADER_REGEX.test(line)) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

/** Reads one file block's paths and counts. Lines after the first hunk header are content, so
 * a removed `-- note` or an added `++ x` is counted and never read as a path header. */
function scanBlock(blockLines: string[]) {
  const firstHunk = blockLines.findIndex((line) => HUNK_HEADER_REGEX.test(line));
  const split = firstHunk === -1 ? blockLines.length : firstHunk;
  return { ...scanHeader(blockLines.slice(0, split)), ...countChanges(blockLines.slice(split)) };
}

/**
 * Split a unified diff into separate file diffs
 */
export function splitUnifiedDiffByFile(diffText: string): ParsedDiffFile[] {
  if (!diffText?.trim()) {
    return [];
  }

  const normalized = diffText.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  const blocks: string[] = [];
  let current: string[] = [];

  const pushCurrent = () => {
    const text = current.join('\n').trim();
    if (
      text &&
      (text.startsWith('diff --git ') ||
        text.startsWith('--- ') ||
        text.startsWith('+++ ') ||
        text.startsWith('Binary files ') ||
        text.includes('\n+++ ') ||
        text.includes('\nBinary files '))
    ) {
      blocks.push(text);
    }
    current = [];
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ') && current.length > 0) {
      pushCurrent();
    }
    current.push(line);
  }
  pushCurrent();

  return blocks.map((blockText, index) => {
    const { oldPath, newPath, isBinary, additions, deletions } = scanBlock(blockText.split('\n'));
    const key = oldPath || newPath ? `${oldPath}->${newPath}` : `file-${index}`;
    const validation = isBinary ? { valid: true } : validateDiffHunk(blockText);
    const isValid = validation.valid;

    const isNewFile = oldPath === '/dev/null';
    const isDeletedFile = newPath === '/dev/null';

    const actualPath = isNewFile ? newPath : isDeletedFile ? oldPath : newPath || oldPath;
    const fileLang = getFileLang(actualPath);

    return {
      key,
      oldPath,
      newPath,
      diffText: blockText,
      isBinary,
      additions,
      deletions,
      isValid,
      fileLang,
      isNewFile,
      isDeletedFile,
    };
  });
}
