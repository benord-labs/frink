/**
 * Shared hook for validating selected project against DB
 * Ensures project exists before using it, prevents stale localStorage data
 */

import { useAtom } from 'jotai';
import { useEffect, useMemo } from 'react';
import { selectedProjectAtom } from '../features/agents/atoms';
import { trpc } from '../lib/trpc';
import { validateProjectAgainstList } from '../lib/validate-project-against-list';

export function useValidatedProject() {
  const [selectedProject, setSelectedProject] = useAtom(selectedProjectAtom);
  const { data: projects, isLoading: isLoadingProjects } = trpc.projects.list.useQuery();

  const validatedProject = useMemo(
    () => validateProjectAgainstList(selectedProject, projects, isLoadingProjects),
    [selectedProject, projects, isLoadingProjects],
  );

  // Clear invalid project from storage (only after loading completes)
  useEffect(() => {
    if (selectedProject && projects && !isLoadingProjects && !validatedProject) {
      setSelectedProject(null);
    }
  }, [selectedProject, projects, isLoadingProjects, validatedProject, setSelectedProject]);

  return { validatedProject, projects, isLoadingProjects };
}
