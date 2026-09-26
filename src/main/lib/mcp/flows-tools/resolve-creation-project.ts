/**
 * Project resolution for agent-created flows (frink_flows_patch creation).
 *
 * An explicit projectId always wins. When omitted, the chat session's project path is
 * resolved to a project row so a flow authored "from inside" a project lands in it without
 * the agent having to know the id. We never guess: an unresolvable or virtual path yields
 * no project (workspace-wide flow) and the tool response states the outcome.
 */

import { resolveProjectPathFromWorktree } from '../../claude-config';
import { getDatabase } from '../../db';
import { getProjectByPath } from '../../db/repos/projects';

export type CreationProjectResolution = {
  projectId: string | null;
  outcome: 'explicit' | 'session-default' | 'none';
  projectName?: string;
};

export async function resolveCreationProject(input: {
  explicitProjectId?: string;
  sessionProjectPath?: string;
}): Promise<CreationProjectResolution> {
  const explicit = input.explicitProjectId?.trim();
  if (explicit) return { projectId: explicit, outcome: 'explicit' };

  const rawPath = input.sessionProjectPath?.trim();
  if (!rawPath || rawPath.startsWith('virtual://')) return { projectId: null, outcome: 'none' };

  // Agent sessions often run inside a worktree; map it back to the project root first.
  // A lookup failure must not abort flow creation (or leak the session's create slot) —
  // discovery fails open to no project.
  try {
    const projectPath = resolveProjectPathFromWorktree(rawPath) ?? rawPath;
    const row = await getProjectByPath(getDatabase(), projectPath);
    if (!row || row.path.startsWith('virtual://')) return { projectId: null, outcome: 'none' };
    return { projectId: row.id, outcome: 'session-default', projectName: row.name };
  } catch {
    return { projectId: null, outcome: 'none' };
  }
}
