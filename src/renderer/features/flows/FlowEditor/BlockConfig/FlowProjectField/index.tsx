/**
 * Project picker for flow block config — reuses agents ProjectSelector with override props.
 */

import { type ReactElement, useMemo } from 'react';
import { trpc } from '@/lib/trpc';
import type { SelectedProject } from '../../../../agents/atoms';
import { ProjectSelector } from '../../../../agents/ProjectSelector';
import { isProjectRow } from '../shared';

type FlowProjectFieldProps = {
  projectId: string;
  onProjectIdChange: (id: string) => void;
};

export function FlowProjectField({
  projectId,
  onProjectIdChange,
}: FlowProjectFieldProps): ReactElement {
  const { data: allProjects } = trpc.projects.list.useQuery();

  const overrideProject = useMemo((): SelectedProject => {
    if (!projectId.trim()) return null;
    const list = Array.isArray(allProjects) ? allProjects : [];
    const found = list.find((p) => isProjectRow(p) && p.id === projectId);
    if (found && isProjectRow(found)) {
      return { id: found.id, name: found.name, path: found.path };
    }
    return {
      id: projectId,
      name: `${projectId.slice(0, 8)}…`,
      path: '',
    };
  }, [allProjects, projectId]);

  const onOverrideProjectChange = (project: SelectedProject): void => {
    onProjectIdChange(project?.id?.trim() ?? '');
  };

  return (
    <div className="min-w-0 w-full">
      <ProjectSelector
        overrideProject={overrideProject}
        onOverrideProjectChange={onOverrideProjectChange}
      />
    </div>
  );
}
