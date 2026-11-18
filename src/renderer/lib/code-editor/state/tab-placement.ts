import {
  isWindowsAbsolutePath,
  normalizePathForComparison,
  normalizePathSlashes,
} from '../../../../shared/lib/path-normalization';

const LEADING_SLASHES_REGEX = /^\/+/;

/** `path` relative to `projectPath` when it is an absolute path inside that folder, as the file
 *  tree names it, so a tab reads the same however its file was opened. Else `path` as given. */
export function pathInProject(path: string, projectPath: string | undefined): string {
  const project = normalizePathForComparison(projectPath);
  const comparable = normalizePathForComparison(path);
  if (!project || !comparable?.startsWith(`${project}/`)) return path;
  if (!comparable.startsWith('/') && !isWindowsAbsolutePath(comparable)) return path;
  // A doubled slash after the folder ('/repo//src/a.ts') must not leave an absolute path behind.
  return normalizePathSlashes(path)
    .slice(project.length + 1)
    .replace(LEADING_SLASHES_REGEX, '');
}

/** `tabs` with `tab` after the last tab from its folder, else at the end. Each folder's tabs stay
 *  together, so the tab bar's project groups keep their order as tabs close. */
export function withTabInProjectGroup<T extends { projectPath?: string }>(tabs: T[], tab: T): T[] {
  const last = tabs.findLastIndex((t) => t.projectPath === tab.projectPath);
  if (last === -1) return [...tabs, tab];
  return [...tabs.slice(0, last + 1), tab, ...tabs.slice(last + 1)];
}
