import { useMemo } from 'react';
import { trpc } from '@/lib/trpc';
import {
  getNodeProjectFieldError,
  type ProjectRefRules,
  resolveNodeProjectId,
  toProjectRefs,
} from '../../BlockConfig/node-project-resolution';

type NodeProjectState = { error: string | null; projectId: string | undefined };

/**
 * A step's Project field: its error (missing, or not on this computer by the step's runtime
 * rules), and the project id it resolves to, so lookups keyed by id work for a stored name.
 */
export function useNodeProject(
  ownProjectId: string,
  flowDefaultProjectId: string | undefined,
  stepRules: ProjectRefRules,
): NodeProjectState {
  const { data } = trpc.projects.list.useQuery();
  const projects = useMemo(() => toProjectRefs(data), [data]);
  return {
    error: getNodeProjectFieldError(ownProjectId, flowDefaultProjectId, projects, stepRules),
    projectId: resolveNodeProjectId(ownProjectId, flowDefaultProjectId, projects, stepRules),
  };
}
