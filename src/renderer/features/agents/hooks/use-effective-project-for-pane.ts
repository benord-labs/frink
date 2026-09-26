/**
 * Effective project for the current pane: global selectedProject in single-pane,
 * per-pane map entry in split view. Returns validated project (exists in DB).
 */

import { useAtom, useAtomValue } from 'jotai';
import { useCallback, useEffect, useMemo } from 'react';
import { trpc } from '../../../lib/trpc';
import { validateProjectAgainstList } from '../../../lib/validate-project-against-list';
import type { SelectedProject } from '../atoms';
import { newChatPaneProjectMapAtom, selectedProjectAtom, splitViewChatIdsAtom } from '../atoms';

export function useEffectiveProjectForPane(splitPaneIndex: number | undefined) {
  const [selectedProject, setSelectedProject] = useAtom(selectedProjectAtom);
  const [paneMap, setPaneMap] = useAtom(newChatPaneProjectMapAtom);
  const chatIds = useAtomValue(splitViewChatIdsAtom);
  const isSplitActive = chatIds.length >= 2;
  const { data: projects, isLoading: isLoadingProjects } = trpc.projects.list.useQuery();

  const project = useMemo(() => {
    if (splitPaneIndex === undefined || !isSplitActive) {
      return selectedProject;
    }
    // Explicit key check so "None (general chat)" (null) is not overwritten by global atom
    if (splitPaneIndex in paneMap) {
      return paneMap[splitPaneIndex];
    }
    return selectedProject;
  }, [splitPaneIndex, isSplitActive, paneMap, selectedProject]);

  const setProject = useCallback(
    (value: SelectedProject | ((prev: SelectedProject) => SelectedProject)) => {
      if (splitPaneIndex === undefined || !isSplitActive) {
        setSelectedProject(value);
        return;
      }
      setPaneMap((prev) => {
        const next = { ...prev };
        const resolved =
          typeof value === 'function' ? value(prev[splitPaneIndex] ?? selectedProject) : value;
        next[splitPaneIndex] = resolved;
        return next;
      });
    },
    [splitPaneIndex, isSplitActive, setSelectedProject, setPaneMap, selectedProject],
  );

  const validatedProject = useMemo(
    () => validateProjectAgainstList(project, projects, isLoadingProjects),
    [project, projects, isLoadingProjects],
  );

  useEffect(() => {
    if (!project || !projects || isLoadingProjects || validatedProject) return;
    if (splitPaneIndex === undefined || !isSplitActive) {
      setSelectedProject(null);
      return;
    }
    setPaneMap((prev) => ({ ...prev, [splitPaneIndex]: null }));
  }, [
    project,
    projects,
    isLoadingProjects,
    validatedProject,
    splitPaneIndex,
    isSplitActive,
    setSelectedProject,
    setPaneMap,
  ]);

  return {
    project,
    setProject,
    validatedProject,
    projects,
    isLoadingProjects,
  };
}
