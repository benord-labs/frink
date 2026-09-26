/**
 * `frink_flows_list_catalog` kind: 'projects' — the user's local projects.
 */

import { getDatabase } from '../../../db';
import { listProjects } from '../../../db/repos/projects';
import { type McpToolResult, toolResult } from '../../tool-result';

/**
 * Local-DB project listing for flow authoring (distinct from the cloud machine-scoped
 * fetchAllProjects base tool). Virtual rows have no usable path and are flagged.
 */
export async function handleProjectsList(): Promise<McpToolResult> {
  try {
    const rows = await listProjects(getDatabase());
    return toolResult(
      JSON.stringify(
        {
          count: rows.length,
          projects: rows.map((p) =>
            p.path.startsWith('virtual://')
              ? { id: p.id, name: p.name, virtual: true }
              : { id: p.id, name: p.name, path: p.path },
          ),
        },
        null,
        2,
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolResult(`Failed to list projects: ${message}`, true);
  }
}
