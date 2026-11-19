/**
 * Which projects a chat's messages name by full path, so a picker can list them first. Only a
 * folder's full path counts: a bare name such as 'app' would match far too much prose.
 */
import {
  isRootLikePath,
  isWindowsAbsolutePath,
  normalizePathForComparison,
} from '../../../shared/lib/path-normalization';
import { isRealProjectPath } from './project-paths';

/** A character that goes on with a file or folder name, rather than ending it. */
const NAME_CHAR = /[\p{L}\p{M}\p{N}_-]/u;

/** Whether the folder ending at `at` ends there, rather than going on as a longer name: '/a/app2',
 *  '/a/app-old' and '/a/app.old' don't name '/a/app'. Anything else ends it, such as a slash, a
 *  space, a quote, a dash or a full stop ending a sentence. */
function endsFolder(text: string, at: number): boolean {
  const next = text[at] ?? '';
  if (next === '.') return !NAME_CHAR.test(text[at + 1] ?? '');
  return !NAME_CHAR.test(next);
}

/** A path with each run of slashes, either way round, as one '/': JSON doubles each backslash, and
 *  a Windows network path starts with two. */
const singleSlashes = (path: string) => path.replace(/[\\/]+/g, '/');

/**
 * The ids of the projects whose folder appears in `texts`, in `projects` order. A folder counts
 * followed by '/' or as the whole path, written with either slash. Where nested projects match the
 * same path, only the deepest counts.
 */
export function findMentionedProjectIds(
  texts: readonly string[],
  projects: readonly { id: string; path: string }[],
): string[] {
  const folders = projects
    // A root-like folder would be in every path; normalized to '', it would match without end.
    .filter((project) => isRealProjectPath(project.path) && !isRootLikePath(project.path))
    .map((project) => {
      const folder = singleSlashes(normalizePathForComparison(project.path) ?? '');
      // A Windows drive folder compares lower-cased, as normalizePathForComparison writes it.
      return { id: project.id, folder, isWindows: isWindowsAbsolutePath(folder) };
    })
    // Deepest first, so a nested project claims a path before the project around it.
    .sort((a, b) => b.folder.length - a.folder.length);
  const anyWindows = folders.some(({ isWindows }) => isWindows);
  const found = new Set<string>();
  for (const raw of texts) {
    const text = singleSlashes(raw);
    const lower = anyWindows ? text.toLowerCase() : text;
    // Where each claimed path starts, so a shallower project can't claim it again.
    const claimed = new Set<number>();
    for (const { id, folder, isWindows } of folders) {
      const haystack = isWindows ? lower : text;
      for (let at = haystack.indexOf(folder); at !== -1; at = haystack.indexOf(folder, at + 1)) {
        if (claimed.has(at) || !endsFolder(haystack, at + folder.length)) continue;
        claimed.add(at);
        found.add(id);
      }
    }
  }
  return projects.filter((project) => found.has(project.id)).map((project) => project.id);
}
