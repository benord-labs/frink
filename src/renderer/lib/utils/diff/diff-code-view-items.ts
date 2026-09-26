import { type CodeViewDiffItem, type FileDiffMetadata, parsePatchFiles } from '@pierre/diffs';
import type { ParsedDiffFile } from '../../../../shared/changes-types';
import { getDisplayPath } from '../diff-file-path';

export type RenderableDiffFile = {
  key: string;
  path: string;
  fileDiff: FileDiffMetadata;
  /** Bumped each time the file's patch is re-parsed, so CodeView re-renders changed content. */
  revision: number;
};

// A refetch keeps an unchanged file's object (react-query structural sharing), so its parse,
// highlighting and scroll position survive the refresh.
const parsedFiles = new WeakMap<ParsedDiffFile, RenderableDiffFile | null>();
let lastRevision = 0;

function parseRenderableDiffFile(file: ParsedDiffFile): RenderableDiffFile | null {
  const cached = parsedFiles.get(file);
  if (cached !== undefined) return cached;
  // No cache key: CodeView treats diffs with equal keys as unchanged and would keep stale content
  const fileDiff = parsePatchFiles(file.diffText)[0]?.files[0];
  const parsed = fileDiff
    ? { key: file.key, path: getDisplayPath(file), fileDiff, revision: ++lastRevision }
    : null;
  parsedFiles.set(file, parsed);
  return parsed;
}

/** Parses each file's patch for CodeView. Binary and malformed diffs have nothing to render. */
export function parseRenderableDiffFiles(files: readonly ParsedDiffFile[]) {
  const renderable: RenderableDiffFile[] = [];
  for (const file of files) {
    const parsed = file.isBinary || !file.isValid ? null : parseRenderableDiffFile(file);
    if (parsed) renderable.push(parsed);
  }
  return { renderable, unrenderableCount: files.length - renderable.length };
}

/** Paths the panel is narrowed to: an explicit file list wins over a sub-chat's files. */
export function resolveDiffScopePaths(
  filteredPaths: readonly string[] | null,
  subChatFiles: readonly { displayPath: string }[] | undefined,
): readonly string[] | null {
  return filteredPaths ?? subChatFiles?.map((file) => file.displayPath) ?? null;
}

/** Returns a copy of `keys` with `key` flipped in or out. */
export function toggleKey(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(keys);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** `keys` without `key`, or `keys` itself when `key` was absent (no re-render). */
export function withoutKey(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  return keys.has(key) ? toggleKey(keys, key) : keys;
}

export function areAllCollapsed(collapsed: ReadonlySet<string>, keys: readonly string[]): boolean {
  return keys.length > 0 && keys.every((key) => collapsed.has(key));
}

/** Collapse-all flips to expand-all once every listed file is collapsed. */
export function toggleAllCollapsed(
  collapsed: ReadonlySet<string>,
  keys: readonly string[],
): ReadonlySet<string> {
  return new Set(areAllCollapsed(collapsed, keys) ? [] : keys);
}

/** Narrows to the paths a sub-chat jump or a review asked for; null keeps every file. */
export function filterDiffFilesByPath<T extends { path: string }>(
  files: readonly T[],
  paths: readonly string[] | null,
): readonly T[] {
  if (!paths) return files;
  const wanted = new Set(paths);
  return files.filter((file) => wanted.has(file.path));
}

export function toCodeViewItems(
  files: readonly RenderableDiffFile[],
  collapsedKeys: ReadonlySet<string>,
): CodeViewDiffItem[] {
  return files.map(({ key, fileDiff, revision }) => {
    const collapsed = collapsedKeys.has(key);
    // CodeView ignores an item update unless its version changes
    return {
      id: key,
      type: 'diff',
      fileDiff,
      collapsed,
      version: revision * 2 + Number(collapsed),
    };
  });
}

/** Edit-tool cards name files by absolute or relative path, so the longest suffix match wins. */
export function findDiffFileByPath<T extends { path: string }>(
  files: readonly T[],
  target: string,
): T | undefined {
  // Windows tools report backslash paths; diff paths always use forward slashes
  const normalized = target.replaceAll('\\', '/');
  const exact = files.find((file) => file.path === normalized);
  if (exact) return exact;
  let best: T | undefined;
  for (const file of files) {
    if (!normalized.endsWith(`/${file.path}`)) continue;
    if (!best || file.path.length > best.path.length) best = file;
  }
  return best;
}

// Git's own message line, so a folder path that merely contains the phrase does not match
const NOT_A_GIT_REPO_REGEX = /(^|\n)fatal: not a git repository\b/i;

/** What the panel says instead of a diff, or null when there are files to show. */
export function getDiffPanelNotice({
  isLoading,
  error,
  hasChanges,
}: {
  isLoading: boolean;
  error: string | null;
  hasChanges: boolean;
}): string | null {
  if (isLoading) return 'Loading changes…';
  if (error && NOT_A_GIT_REPO_REGEX.test(error)) {
    return "This folder isn't tracked by git, so there are no changes to show.";
  }
  if (error)
    return "Couldn't read the changes in this folder. Close and reopen this panel to retry.";
  if (!hasChanges) return 'No uncommitted changes. Files the agent edits show up here.';
  return null;
}

const UNREADABLE = 'The changes could not be read.';

/** The part of a getParsedDiff response that reports a failed read. */
type DiffReadResponse = { totalAdditions: number; error?: string };

/** Why reading the diff failed, or null. An empty error string is still a failure. */
export function getDiffReadError(
  response: DiffReadResponse | undefined,
  queryError: { message: string } | null,
): string | null {
  if (queryError) return queryError.message || UNREADABLE;
  if (response && 'error' in response) return response.error || UNREADABLE;
  return null;
}

/** Which PR hand-offs the Ask agent menu offers. While the live status is loading or failed,
 * whether a PR exists is unknown, so no PR action is offered. */
export function getPrHandoffState(
  pr: { state: string; mergeable?: string } | null,
  isKnown: boolean,
) {
  const isPrOpen = isKnown && (pr?.state === 'open' || pr?.state === 'draft');
  return {
    isPrKnown: isKnown,
    isPrOpen,
    hasMergeConflicts: isPrOpen && pr?.mergeable === 'CONFLICTING',
  };
}
