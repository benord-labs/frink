import { realpathSync } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { z } from 'zod';
import { isPathWithinProject, resolveToRealPath } from '../permissions/path-check';
import type { CodexApprovalRequest } from './codex/codex-events';
import { envFileAsks, envGlobAsks } from './env-file-reads';

/** Any JSON value, as an agent sends a tool's input. */
export type JsonValue = z.infer<ReturnType<typeof z.json>>;

export const textSchema = z.string().trim().min(1);
// Agents read a leading ~ as a folder name or as their own home, and some trim outer spaces
// while others keep them, so a path with either is refused rather than judged as another.
export const pathSchema = z
  .string()
  .refine((file) => file !== '' && file.trim() === file && !file.startsWith('~'));
const pathsSchema = z.union([pathSchema, z.array(pathSchema)]).optional();

const GLOB_CHARS = /[*?[\]{}()!]/;
// A group holding a / or ~ can name any folder, wherever it sits.
const GROUP_LEAVES = /[{(][^})]*[/~]/;
// A segment that can stand for .., however it is spelled, steps out of the folder before it.
const stepsUp = (segment: string) =>
  segment.includes('..') || picomatch.isMatch('..', segment, { dot: true });
// A leading ! only leaves files out, and never un-hides or un-ignores one, so it counts as no
// glob; !( and !! are judged as written, and `!(x)` can stand for .., so stepsUp refuses it.
const EXCLUSION = /^!(?![!(])/;
const judgedGlob = (pattern: JsonValue | undefined) =>
  EXCLUSION.test(pathSchema.safeParse(pattern).data ?? '') ? undefined : pattern;

export const editQuestion = (cwd: string, file: string): CodexApprovalRequest => ({
  toolName: 'Edit',
  input: { file_path: path.resolve(cwd, file) },
});

/** The folder a glob starts from: the segments before its first wildcard. */
function globRoot(pattern: JsonValue | undefined): string | undefined {
  if (pattern === undefined) return '.';
  const parsed = pathSchema.safeParse(pattern);
  // A backslash is an escape to one glob reader and a folder break to another, so it is refused.
  if (!parsed.success || GROUP_LEAVES.test(parsed.data) || parsed.data.includes('\\'))
    return undefined;
  const segments = parsed.data.split('/');
  const wild = segments.findIndex((segment) => GLOB_CHARS.test(segment));
  if (wild !== -1 && segments.slice(wild).some(stepsUp)) return undefined;
  const root = segments.slice(0, wild === -1 ? undefined : wild).join('/');
  return root || (parsed.data.startsWith('/') ? '/' : '.');
}

/** The real place behind a path, or undefined when nothing there can be opened. */
function realOrMissing(file: string): string | undefined {
  try {
    return realpathSync.native(file);
  } catch {
    return undefined;
  }
}

/** Where the tool really opens a path: the system follows a link before a later .. climbs. */
function openedPath(cwd: string, given: string, start: string): string | undefined {
  if (path.isAbsolute(start)) return realOrMissing(start);
  // Joined as text: path.resolve would drop the .. before the link is followed.
  const root = realOrMissing(path.isAbsolute(given) ? given : `${cwd}/${given}`);
  // A start that cannot open below the real root, as under a file, is judged as text there.
  return root && (realOrMissing(`${root}/${start}`) ?? path.resolve(root, start));
}

/** Every folder or file a read starts from, or undefined when one can't be named. */
export function readStarts(
  paths: JsonValue | undefined,
  cwd: string,
  pattern?: JsonValue,
): { root: string; file: string; opened: string | undefined }[] | undefined {
  const parsed = pathsSchema.safeParse(paths);
  const start = globRoot(judgedGlob(pattern));
  if (!parsed.success || start === undefined) return undefined;
  const roots = [parsed.data ?? []].flat();
  return (roots.length > 0 ? roots : [cwd]).map((given) => {
    const root = path.resolve(cwd, given);
    return { root, file: path.resolve(root, start), opened: openedPath(cwd, given, start) };
  });
}

/** Reads ask outside the chat's folder, and before opening or searching an env file in it. */
export function readQuestions(
  paths: JsonValue | undefined,
  cwd: string,
  pattern?: JsonValue,
  namesOnly = false,
): CodexApprovalRequest[] | undefined {
  const glob = namesOnly ? undefined : pathSchema.safeParse(judgedGlob(pattern)).data;
  return readStarts(paths, cwd, pattern)
    ?.flatMap(({ root, file, opened }) => {
      // A link can make the text and the real folder differ: a search opens one, a view the other.
      const places = opened && opened !== resolveToRealPath(file) ? [file, opened] : [file];
      const outside = places.filter((place) => !isPathWithinProject(place, cwd));
      if (outside.length > 0) return outside;
      if (envFileAsks(path.relative(cwd, root))) return [root];
      const filter = glob === undefined ? undefined : path.resolve(root, glob);
      // Judged from the root, so folder names before it are not read as glob syntax.
      return filter && envGlobAsks(path.relative(root, filter)) ? [filter] : [];
    })
    .map((file) => ({ toolName: 'Read', input: { file_path: file } }));
}
