import { getDatabase } from '../../db';
import * as projectAgentsRepo from '../../db/repos/project-agents';
import { listProjects } from '../../db/repos/projects';

type Db = ReturnType<typeof getDatabase>;
type ResourceType = 'skill' | 'agent' | 'hook';

/** Global scope = available in every project → drop all per-project rows for this resource. */
async function clearProjectScope(db: Db, name: string, type: ResourceType): Promise<void> {
  const ids = (await projectAgentsRepo.getProjectsUsingAgent(db, name, type)).map(
    (p) => p.project_id,
  );
  if (ids.length > 0) await projectAgentsRepo.bulkRemoveFromProjects(db, ids, name, type);
}

/** Project scope = usable only in one project → remove it from every OTHER project, then upsert it here. */
async function setProjectScope(
  db: Db,
  name: string,
  type: ResourceType,
  projectId: string,
): Promise<void> {
  const others = (await projectAgentsRepo.getProjectsUsingAgent(db, name, type))
    .filter((p) => p.project_id !== projectId)
    .map((p) => p.project_id);
  if (others.length > 0) await projectAgentsRepo.bulkRemoveFromProjects(db, others, name, type);
  await projectAgentsRepo.upsert(db, { projectId, agentName: name, type, enabled: true });
}

/**
 * Move a resource (skill/agent/hook) between global (all projects) and a specific project, tracked in the
 * local `project_agents` table. Single source for the skills/agents/hooks routers (was triplicated).
 */
export async function changeResourceScope(input: {
  name: string;
  type: ResourceType;
  scope: 'global' | 'project';
  projectId?: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const db = getDatabase();
    if (input.scope === 'global') {
      await clearProjectScope(db, input.name, input.type);
      return { success: true };
    }
    if (!input.projectId) return { success: false, error: 'Project ID required for project scope' };
    if (!(await listProjects(db)).some((p) => p.id === input.projectId)) {
      return { success: false, error: 'Project not found' };
    }
    await setProjectScope(db, input.name, input.type, input.projectId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}
