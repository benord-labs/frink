import { useMemo } from 'react';
import { trpc } from '@/lib/trpc';
import {
  getNodeProjectFieldError,
  type ProjectRefRules,
  toProjectRefs,
} from '../../BlockConfig/node-project-resolution';

/** The Project field's error: missing, or not on this computer by the step's runtime rules. */
export function useNodeProjectError(
  ownProjectId: string,
  flowDefaultProjectId: string | undefined,
  stepRules: ProjectRefRules,
): string | null {
  const { data } = trpc.projects.list.useQuery();
  const projects = useMemo(() => toProjectRefs(data), [data]);
  return getNodeProjectFieldError(ownProjectId, flowDefaultProjectId, projects, stepRules);
}
