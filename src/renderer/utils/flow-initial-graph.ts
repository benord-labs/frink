/**
 * Initial working-copy resolution for the flow editor.
 *
 * A flow's DB `project_id` is listing-only; the runtime default project lives in
 * `graph.settings.defaultProjectId`, which is version-pinned on save. New flows have no
 * saved graph yet, so the project picked at creation is seeded into the draft graph here
 * and enters the version stream on first save.
 */
import {
  type FlowGraph,
  linearFlowGraph,
  normalizeFlowGraph,
} from '../../shared/lib/validate-flow-graph';

function newDefaultGraph(): FlowGraph {
  return linearFlowGraph([
    { id: crypto.randomUUID(), blockType: 'manual_trigger', label: 'Trigger' },
    {
      id: crypto.randomUUID(),
      blockType: 'start_task',
      label: 'Start Task',
      config: { startInWorktree: true },
    },
    {
      id: crypto.randomUUID(),
      blockType: 'agent',
      config: { instructions: 'Describe what the agent should do.' },
    },
  ]);
}

/**
 * Returns the saved graph when it is substantive (>= 2 nodes — never retro-seeds existing
 * flows); otherwise a fresh default graph. Saved settings survive the node-scaffolding reset
 * (an MCP-created flow can persist sparse but carry briefing/defaultProjectId); absent any,
 * `settings.defaultProjectId` is seeded from the flow's project so per-node "set project"
 * warnings don't appear for an already-picked project.
 */
export function resolveInitialGraph(
  serverGraph: unknown,
  flowProjectId: string | null | undefined,
): FlowGraph {
  const norm = normalizeFlowGraph(serverGraph);
  if (norm !== null && norm.nodes.length >= 2) return norm;
  const fresh = newDefaultGraph();
  const pid = flowProjectId?.trim();
  if (norm?.settings !== undefined) return { ...fresh, settings: norm.settings };
  return pid ? { ...fresh, settings: { defaultProjectId: pid } } : fresh;
}
