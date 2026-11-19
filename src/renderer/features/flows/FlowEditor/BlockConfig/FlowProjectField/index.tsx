/**
 * Project picker for flow block config — reuses agents ProjectSelector with override props.
 */

import { type ReactElement, useMemo } from 'react';
import { trpc } from '@/lib/trpc';
import type { SelectedProject } from '../../../../agents/atoms';
import { ProjectSelector } from '../../../../agents/ProjectSelector';
import {
  classifyProjectRef,
  LITERAL_PROJECT_RULES,
  type ProjectRefRules,
  pickerProject,
  projectRefMessage,
  toProjectRefs,
} from '../node-project-resolution';

type FlowProjectFieldProps = {
  projectId: string;
  onProjectIdChange: (id: string) => void;
  /** How the runtime matches this value; the flow default by id or unique name. */
  rules?: ProjectRefRules;
};

export function FlowProjectField({
  projectId,
  onProjectIdChange,
  rules = LITERAL_PROJECT_RULES,
}: FlowProjectFieldProps): ReactElement {
  const { data: allProjects } = trpc.projects.list.useQuery();

  const overrideProject = useMemo((): SelectedProject => {
    if (!projectId.trim()) return null;
    return pickerProject(projectId, allProjects, rules);
  }, [allProjects, projectId, rules]);

  // Blank is allowed here (no flow default, or no post-task scope), so only a set value is checked.
  const state = classifyProjectRef(projectId, toProjectRefs(allProjects), rules);
  const error = state === 'missing' ? null : projectRefMessage(state, projectId);

  const onOverrideProjectChange = (project: SelectedProject): void => {
    onProjectIdChange(project?.id?.trim() ?? '');
  };

  return (
    <div className="min-w-0 w-full space-y-1">
      <div className={error ? 'rounded-md ring-2 ring-destructive/50' : undefined}>
        <ProjectSelector
          overrideProject={overrideProject}
          onOverrideProjectChange={onOverrideProjectChange}
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
