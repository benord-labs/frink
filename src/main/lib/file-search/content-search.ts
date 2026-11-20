import type { Dirent } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { escapeRegExp } from '../../../shared/utils/escape-regexp';
import { isIgnoredDirectory, isIgnoredFileByName } from './ignore-policy';

export type FileContentMatch = {
  id: string;
  filePath: string;
  lineNumber: number;
  startColumn: number;
  endColumn: number;
  lineText: string;
  /** The match's span within `lineText`, so the results list never re-runs the query. */
  previewStart: number;
  previewEnd: number;
};

export type ContentSearchJob = {
  rootPath: string;
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  limit: number;
  /** Compiled include globs, tested against `/`-separated project-relative paths. Empty means every file. */
  include: RegExp[];
  /** Compiled exclude globs. A matching folder is not walked. */
  exclude: RegExp[];
};

type LineMatch = { startColumn: number; endColumn: number };
type LineMatcher = (line: string) => LineMatch[];

const MAX_FILE_BYTES = 512 * 1024;
const MAX_LINE_LENGTH = 500;
const MAX_DEPTH = 15;
const LINE_ENDING_REGEX = /\r?\n/;

type Preview = Pick<FileContentMatch, 'lineText' | 'previewStart' | 'previewEnd'>;

/** A line cut to MAX_LINE_LENGTH around its match, with the match's span in the cut text. */
function previewLine(text: string, match: LineMatch): Preview {
  const matchIndex = match.startColumn - 1;
  const matchLength = match.endColumn - match.startColumn;
  if (text.length <= MAX_LINE_LENGTH) {
    return { lineText: text, previewStart: matchIndex, previewEnd: matchIndex + matchLength };
  }

  const preferredStart = matchIndex === 0 ? 0 : matchIndex - Math.floor(MAX_LINE_LENGTH / 2);
  const start = Math.min(Math.max(0, preferredStart), text.length - MAX_LINE_LENGTH);
  const end = start + MAX_LINE_LENGTH;
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  const previewStart = prefix.length + matchIndex - start;
  return {
    lineText: `${prefix}${text.slice(start, end)}${suffix}`,
    previewStart,
    previewEnd: Math.min(previewStart + matchLength, prefix.length + MAX_LINE_LENGTH),
  };
}

function compileQuery(job: ContentSearchJob): RegExp | null {
  const flags = job.matchCase ? 'g' : 'gi';
  if (!job.useRegex) {
    const literal = escapeRegExp(job.query);
    return new RegExp(job.wholeWord ? `\\b${literal}\\b` : literal, flags);
  }
  try {
    // Checked on its own first: whole word's wrapper can turn an invalid query such as `a)|(?:b`
    // into a valid one.
    const regex = new RegExp(job.query, flags);
    return job.wholeWord ? new RegExp(`\\b(?:${job.query})\\b`, flags) : regex;
  } catch {
    return null;
  }
}

function createLineMatcher(regex: RegExp): LineMatcher {
  return (line) => {
    regex.lastIndex = 0;
    const matches: LineMatch[] = [];
    let match = regex.exec(line);
    while (match) {
      const length = match[0]?.length ?? 0;
      const startColumn = match.index + 1;
      matches.push({ startColumn, endColumn: startColumn + length });
      // Step past zero-length matches so the loop always advances.
      if (length === 0) regex.lastIndex += 1;
      match = regex.exec(line);
    }
    return matches;
  };
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

/** Both paths are realpaths, so a plain prefix test is exact: no `..`, no repeated separators. */
function isUnder(realRoot: string, realTarget: string): boolean {
  return realTarget.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`);
}

type Walk = {
  job: ContentSearchJob;
  realRoot: string;
  matcher: LineMatcher;
  found: number;
  emit: (batch: FileContentMatch[]) => void;
};

function matchLines(walk: Walk, content: string, filePath: string): FileContentMatch[] {
  const batch: FileContentMatch[] = [];
  for (const [i, line] of content.split(LINE_ENDING_REGEX).entries()) {
    if (walk.found + batch.length >= walk.job.limit) break;
    for (const [m, { startColumn, endColumn }] of walk.matcher(line).entries()) {
      if (walk.found + batch.length >= walk.job.limit) return batch;
      batch.push({
        id: `content:local:${filePath}:${i + 1}:${startColumn}:${m}`,
        filePath,
        lineNumber: i + 1,
        startColumn,
        endColumn,
        ...previewLine(line, { startColumn, endColumn }),
      });
    }
  }
  return batch;
}

/** Whether a link's target, inside the project, sits where the walk would also search: not in an
 * ignored folder, not an ignored file, not excluded. */
function targetSearchable(walk: Walk, target: string): boolean {
  const relativeTarget = toPosix(relative(walk.realRoot, target));
  const parts = relativeTarget.split('/');
  if (parts.slice(0, -1).some(isIgnoredDirectory)) return false;
  if (isIgnoredFileByName(parts.at(-1) ?? '')) return false;
  return !walk.job.exclude.some((re) => re.test(relativeTarget));
}

/** The path to read for a file row, or null to skip it. A link is read only when its target is
 * a file inside the project that the walk would search, so a link to ~ or to `dist` is not. */
async function readablePath(walk: Walk, entry: Dirent, fullPath: string): Promise<string | null> {
  if (entry.isFile()) return fullPath;
  if (!entry.isSymbolicLink()) return null;
  try {
    const target = await realpath(fullPath);
    if (!isUnder(walk.realRoot, target) || !targetSearchable(walk, target)) return null;
    return (await stat(target)).isFile() ? target : null;
  } catch {
    return null;
  }
}

function passesGlobs(job: ContentSearchJob, filePath: string): boolean {
  if (job.exclude.some((re) => re.test(filePath))) return false;
  return job.include.length === 0 || job.include.some((re) => re.test(filePath));
}

async function searchFile(walk: Walk, readPath: string, filePath: string): Promise<void> {
  try {
    const fileStat = await stat(readPath);
    if (fileStat.size > MAX_FILE_BYTES) return;
    const content = await readFile(readPath, 'utf-8');
    if (content.includes('\u0000')) return;
    const batch = matchLines(walk, content, filePath);
    if (batch.length === 0) return;
    walk.found += batch.length;
    walk.emit(batch);
  } catch {
    // Unreadable files are skipped.
  }
}

function byName(a: Dirent, b: Dirent): number {
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

async function walkDirectory(walk: Walk, currentPath: string, depth: number): Promise<void> {
  if (depth > MAX_DEPTH || walk.found >= walk.job.limit) return;
  let entries: Dirent[];
  try {
    entries = await readdir(currentPath, { withFileTypes: true });
  } catch {
    return;
  }

  // Name order, so the first `limit` matches are the same on every OS and filesystem.
  for (const entry of [...entries].sort(byName)) {
    if (walk.found >= walk.job.limit) return;
    await visitEntry(walk, entry, join(currentPath, entry.name), depth);
  }
}

async function visitEntry(walk: Walk, entry: Dirent, fullPath: string, depth: number) {
  const relativePath = relative(walk.job.rootPath, fullPath);
  const globPath = toPosix(relativePath);
  if (entry.isDirectory()) {
    const excluded = walk.job.exclude.some((re) => re.test(globPath));
    if (!excluded && !isIgnoredDirectory(entry.name))
      await walkDirectory(walk, fullPath, depth + 1);
    return;
  }
  if (isIgnoredFileByName(entry.name) || !passesGlobs(walk.job, globPath)) return;
  const readPath = await readablePath(walk, entry, fullPath);
  if (readPath) await searchFile(walk, readPath, relativePath);
}

/**
 * Find-in-files over a project with the shared ignore policy (not .gitignore).
 * Matches are handed to `emit` one file at a time, so a stopped search keeps what it found.
 */
export async function searchContents(
  job: ContentSearchJob,
  emit: (batch: FileContentMatch[]) => void,
): Promise<{ invalidRegex: boolean }> {
  const regex = compileQuery(job);
  if (!regex) return { invalidRegex: true };
  const realRoot = await realpath(job.rootPath).catch(() => job.rootPath);
  await walkDirectory(
    { job, realRoot, matcher: createLineMatcher(regex), found: 0, emit },
    job.rootPath,
    0,
  );
  return { invalidRegex: false };
}
