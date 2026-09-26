import { describe, expect, it } from 'vitest';
import type { FlowGraph } from '../../shared/lib/validate-flow-graph';
import { resolveInitialGraph } from './flow-initial-graph';

const SAVED_GRAPH: FlowGraph = {
  nodes: [
    { id: 'n1', blockType: 'manual_trigger' },
    { id: 'n2', blockType: 'start_task' },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
};

describe('resolveInitialGraph', () => {
  it('returns the saved graph untouched when it has >= 2 nodes (never retro-seeds)', () => {
    const r = resolveInitialGraph(SAVED_GRAPH, 'proj-1');
    expect(r.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(r.settings).toBeUndefined();
  });

  it('seeds settings.defaultProjectId on the default graph when the flow has a project', () => {
    const r = resolveInitialGraph(null, 'proj-1');
    expect(r.nodes.length).toBeGreaterThanOrEqual(2);
    expect(r.settings?.defaultProjectId).toBe('proj-1');
  });

  it('defaults the scaffolded Start Task node to startInWorktree: true', () => {
    // Every new flow must start isolated by default — the dispatcher treats an absent flag
    // as no worktree, so an unconfigured out-of-box flow would otherwise run in the main checkout.
    const r = resolveInitialGraph(null, 'proj-1');
    const startTask = r.nodes.find((n) => n.blockType === 'start_task');
    expect(startTask?.config?.startInWorktree).toBe(true);
  });

  it('returns the default graph without settings when the flow has no project', () => {
    expect(resolveInitialGraph(null, null).settings).toBeUndefined();
    expect(resolveInitialGraph(undefined, '  ').settings).toBeUndefined();
  });

  // An MCP-created flow can persist with <2 nodes but real settings (briefing,
  // defaultProjectId via update_settings). Replacing the sparse graph must not
  // erase those settings — only the node scaffolding is reset.
  it('preserves saved settings when discarding a sparse (<2 node) graph', () => {
    const sparse: FlowGraph = {
      nodes: [{ id: 't1', blockType: 'manual_trigger' }],
      edges: [],
      settings: { defaultProjectId: 'agent-set', briefing: 'PRD text' },
    };
    const r = resolveInitialGraph(sparse, 'dialog-pick');
    expect(r.nodes.length).toBeGreaterThanOrEqual(2);
    expect(r.settings).toEqual({ defaultProjectId: 'agent-set', briefing: 'PRD text' });
  });
});
