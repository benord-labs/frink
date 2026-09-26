import { normalizeGitRemoteUrl } from './git-url';

/**
 * Shared codebase grouping key.
 * Projects with the same git remote are treated as one codebase.
 * If no git remote exists, fall back to path-based grouping.
 */
export function getProjectCodebaseKey(gitRemote: string | null | undefined, path: string): string {
  const remote = gitRemote?.trim();
  if (remote) {
    return normalizeGitRemoteUrl(remote);
  }
  return path;
}

/**
 * Group items by codebase key, preserving input order within each group.
 */
export function groupByCodebase<T>(
  items: T[],
  getGitRemote: (item: T) => string | null | undefined,
  getPath: (item: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const codebaseKey = getProjectCodebaseKey(getGitRemote(item), getPath(item));
    const existing = grouped.get(codebaseKey);
    if (existing) {
      existing.push(item);
    } else {
      grouped.set(codebaseKey, [item]);
    }
  }
  return grouped;
}

/**
 * Deduplicate items by codebase key — picks one representative per group.
 * - prefers entries with a non-empty description
 * - deterministic tie-break by name (alphabetically earliest wins)
 */
export function dedupeByCodebase<T extends { name: string }>(
  items: T[],
  getGitRemote: (item: T) => string | null | undefined,
  getPath: (item: T) => string,
  getDescription?: (item: T) => string | null | undefined,
): T[] {
  const grouped = groupByCodebase(items, getGitRemote, getPath);
  return Array.from(grouped.values()).map((group) => {
    if (group.length === 1) return group[0];
    return group.reduce((best, item) => {
      if (getDescription) {
        const bestHasDesc = Boolean(getDescription(best)?.trim());
        const itemHasDesc = Boolean(getDescription(item)?.trim());
        if (!bestHasDesc && itemHasDesc) return item;
        if (bestHasDesc && !itemHasDesc) return best;
      }
      return item.name.localeCompare(best.name) < 0 ? item : best;
    });
  });
}
