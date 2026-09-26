/**
 * Shared helper for the list procedure pattern used by agents, hooks, and skills routers.
 *
 * All three routers follow the same pattern:
 * 1. Resolve CLI type for the project
 * 2. Get IDE directory priority
 * 3. Scan user-global directories
 * 4. Scan project directories
 * 5. Dedup by name within each scope
 * 6. Return [...project, ...user]
 */
import * as path from 'node:path';
import { getIdeDirPriority } from '../../agents';
import { getProjectIdByPath } from '../../git/security/path-validation';
import { resolveDefaultCliType, resolveProjectCliType } from './agent-utils';
import { frinkUserHome } from '../../platform/frink-home';

/** Minimal shape that scan functions must return. */
type NamedResource = {
  name: string;
};

/** A scan function that reads a directory and returns named resources. */
type ScanFn<T extends NamedResource> = (dir: string, source: 'user' | 'project') => Promise<T[]>;

/**
 * Generic list-and-dedup pipeline for IDE-directory-based resources.
 *
 * @param dirSuffix - subdirectory name under IDE dirs (e.g. 'agents', 'hooks', 'skills')
 * @param scanDirectory - the scan function to read resources from a directory
 * @param cwd - optional project working directory
 * @returns Deduplicated resources with project items first, then user items
 */
export async function listResources<T extends NamedResource>(
  dirSuffix: string,
  scanDirectory: ScanFn<T>,
  cwd?: string,
): Promise<T[]> {
  // Resolve CLI type so directory priority matches the project's active CLI
  let cliType = await resolveDefaultCliType();
  if (cwd) {
    const projectId = getProjectIdByPath(cwd);
    try {
      cliType = await resolveProjectCliType(projectId);
    } catch {
      // Fall through to default CLI type (e.g. Neon unreachable)
    }
  }
  const dirPriority = getIdeDirPriority(cliType);

  // Scan user-global directories in resolved priority order
  const userPromises = dirPriority.map((d) =>
    scanDirectory(path.join(frinkUserHome(), d, dirSuffix), 'user'),
  );

  // Scan project directories in resolved priority order
  const projectPromises: Promise<T[]>[] = [];
  if (cwd) {
    for (const d of dirPriority) {
      projectPromises.push(scanDirectory(path.join(cwd, d, dirSuffix), 'project'));
    }
  }

  const results = await Promise.all([...userPromises, ...projectPromises]);
  const userResults = results.slice(0, dirPriority.length);
  const projResults = results.slice(dirPriority.length);

  // Dedup by name within each scope (first occurrence wins per priority order)
  const userItems = dedup(userResults);
  const projectItems = dedup(projResults);

  // Project items override user items with the same name
  return [...projectItems, ...userItems];
}

/** Dedup batches of named resources, keeping first occurrence by name. */
function dedup<T extends NamedResource>(batches: T[][]): T[] {
  const seen = new Set<string>();
  const items: T[] = [];
  for (const batch of batches) {
    for (const item of batch) {
      if (seen.has(item.name)) continue;
      seen.add(item.name);
      items.push(item);
    }
  }
  return items;
}
