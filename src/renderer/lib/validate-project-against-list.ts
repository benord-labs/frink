/**
 * Pure helper: validate that a selected project exists in the project list.
 * Used by useValidatedProject and useEffectiveProjectForPane to avoid duplication.
 */

type ProjectWithId = { id: string };

export function validateProjectAgainstList<T extends ProjectWithId | null>(
  project: T,
  projects: ProjectWithId[] | undefined,
  isLoading: boolean,
): T | null {
  if (project == null) return null;
  if (isLoading) return project;
  if (!Array.isArray(projects)) return null;
  const exists = projects.some((p) => p.id === project.id);
  return exists ? project : null;
}
