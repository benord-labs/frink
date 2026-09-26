/**
 * Local project_agents repo. Per-project enable/disable + config overrides
 * for filesystem-discovered agents/skills/hooks.
 *
 * Type allowlist enforced at write time + by SQL CHECK constraint:
 * ('agent','skill','hook'). UNIQUE(projectId, agentName, type) prevents
 * duplicate scope rows.
 *
 * Single-user-per-machine: local `projects` table has no userId column
 * (every row is owned by the active machine session). FK to projects +
 * ON DELETE CASCADE handles cleanup; no userId scoping needed.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { getDatabase } from '../index';
import { type NewProjectAgent, type ProjectAgent, projectAgents, projects } from '../schema';

type Db = ReturnType<typeof getDatabase>;

export type ProjectAgentType = 'agent' | 'skill' | 'hook';
const ALLOWED_TYPES: ReadonlySet<string> = new Set(['agent', 'skill', 'hook']);

class ProjectAgentTypeNotSupportedError extends Error {
  constructor(public readonly type: string) {
    super(`type '${type}' is not supported. Allowed: ${[...ALLOWED_TYPES].join(', ')}.`);
    this.name = 'ProjectAgentTypeNotSupportedError';
  }
}

function assertTypeAllowed(t: string): asserts t is ProjectAgentType {
  if (!ALLOWED_TYPES.has(t)) {
    throw new ProjectAgentTypeNotSupportedError(t);
  }
}

/**
 * Resolve "where is this agent enabled?" for the renderer's scope toggle.
 * Returns active rows joined with project metadata so the UI can list them.
 */
export async function getProjectsUsingAgent(
  db: Db,
  agentName: string,
  type: ProjectAgentType,
): Promise<Array<{ project_id: string; project_name: string; path: string }>> {
  assertTypeAllowed(type);
  const rows = await db
    .select({
      project_id: projects.id,
      project_name: projects.name,
      path: projects.path,
    })
    .from(projectAgents)
    .innerJoin(projects, eq(projects.id, projectAgents.projectId))
    .where(
      and(
        eq(projectAgents.agentName, agentName),
        eq(projectAgents.type, type),
        eq(projectAgents.enabled, true),
      ),
    )
    .orderBy(projects.name);
  return rows;
}

/**
 * Atomic upsert keyed on (projectId, agentName, type). Single-user-per-machine:
 * the FK to projects (CASCADE on delete) keeps rows consistent with the local
 * project row; no userId scoping because local projects table has no userId
 * column.
 */
export async function upsert(
  db: Db,
  input: Pick<NewProjectAgent, 'projectId' | 'agentName' | 'type'> & {
    enabled?: boolean;
    configOverrides?: unknown;
  },
): Promise<ProjectAgent> {
  assertTypeAllowed(input.type);
  const now = new Date();
  // Drizzle SQLite onConflictDoUpdate keyed on the composite UNIQUE.
  const [row] = await db
    .insert(projectAgents)
    .values({
      projectId: input.projectId,
      agentName: input.agentName,
      type: input.type,
      enabled: input.enabled ?? true,
      configOverrides: (input.configOverrides ?? null) as NewProjectAgent['configOverrides'],
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [projectAgents.projectId, projectAgents.agentName, projectAgents.type],
      set: {
        enabled: input.enabled ?? true,
        configOverrides: (input.configOverrides ?? null) as NewProjectAgent['configOverrides'],
        updatedAt: now,
      },
    })
    .returning();
  return row;
}

/**
 * Bulk delete across an explicit projectIds list. Used by `changeScopeAgent`
 * when the user moves a scope to "global" (remove from every project) or
 * narrows from many projects → one (remove from the others).
 */
export async function bulkRemoveFromProjects(
  db: Db,
  projectIds: string[],
  agentName: string,
  type: ProjectAgentType,
): Promise<number> {
  if (projectIds.length === 0) return 0;
  assertTypeAllowed(type);
  const removed = await db
    .delete(projectAgents)
    .where(
      and(
        inArray(projectAgents.projectId, projectIds),
        eq(projectAgents.agentName, agentName),
        eq(projectAgents.type, type),
      ),
    )
    .returning({ id: projectAgents.id });
  return removed.length;
}
