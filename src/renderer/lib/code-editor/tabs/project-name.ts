/** Extract the project folder name from a full project path */
export function getProjectName(projectPath: string | undefined): string | undefined {
  if (!projectPath) return undefined;
  return projectPath.split('/').pop();
}

/**
 * Disambiguate project display names when multiple projects share the same
 * folder name. Accepts a pre-deduped sorted array of project paths so the
 * result is referentially stable when the set of projects hasn't changed.
 *
 * Returns a map of projectPath → display name (e.g. "work/api" vs "personal/api").
 */
export function disambiguateProjectPaths(projectPaths: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const nameToProjects = new Map<string, string[]>();

  for (const p of projectPaths) {
    const name = getProjectName(p) ?? p;
    result.set(p, name);
    const existing = nameToProjects.get(name) ?? [];
    existing.push(p);
    nameToProjects.set(name, existing);
  }

  // Disambiguate duplicates by prepending the parent directory.
  // For root-level paths with only one segment, use the full path as-is.
  for (const [_name, paths] of nameToProjects) {
    if (paths.length <= 1) continue;
    for (const p of paths) {
      const parts = p.split('/').filter(Boolean);
      if (parts.length >= 2) {
        result.set(p, `${parts[parts.length - 2]}/${parts[parts.length - 1]}`);
      } else {
        // Root-level path (e.g. "/api") — use full path to disambiguate
        result.set(p, p);
      }
    }
  }

  return result;
}
