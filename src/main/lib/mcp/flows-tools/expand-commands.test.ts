import { describe, expect, it } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import {
  type ExpandDeps,
  expandAgentCommandsInGraph,
  formatExpansionFailures,
  nearestCommands,
  resolveNodeProjectId,
} from './expand-commands';

const PROJECT_PATH = '/repo/proj-1';

function deps(overrides: Partial<ExpandDeps> = {}): ExpandDeps {
  return {
    resolveProjectPath: async (id) => (id === 'proj-1' ? PROJECT_PATH : null),
    listCommands: async (pp) =>
      pp === PROJECT_PATH
        ? [{ name: 'edge-cases', path: `${PROJECT_PATH}/.frink/commands/edge-cases.md` }]
        : [],
    getContent: async () => 'Review edge cases for $ARGUMENTS',
    ...overrides,
  };
}

function graphWith(instructions: string): FlowGraph {
  return {
    nodes: [
      { id: 'st', blockType: 'start_task', config: { projectId: 'proj-1' } },
      { id: 'ag', blockType: 'agent', label: 'Agent', config: { instructions } },
    ],
    edges: [{ id: 'e1', source: 'st', target: 'ag' }],
  };
}

describe('nearestCommands', () => {
  it('suggests the closest name within threshold', () => {
    expect(nearestCommands('edge-casez', ['edge-cases', 'plan', 'review'])).toEqual(['edge-cases']);
  });

  it('returns nothing when nothing is close', () => {
    expect(nearestCommands('zzz', ['plan', 'review'])).toEqual([]);
  });
});

describe('resolveNodeProjectId', () => {
  it('uses the nearest upstream start_task projectId', () => {
    expect(resolveNodeProjectId(graphWith('/edge-cases'), 'ag')).toBe('proj-1');
  });

  it('falls back to settings.defaultProjectId', () => {
    const g: FlowGraph = {
      nodes: [{ id: 'ag', blockType: 'agent', config: {} }],
      edges: [],
      settings: { defaultProjectId: 'def' } as FlowGraph['settings'],
    };
    expect(resolveNodeProjectId(g, 'ag')).toBe('def');
  });

  it('falls back to the provided fallback projectId', () => {
    const g: FlowGraph = { nodes: [{ id: 'ag', blockType: 'agent' }], edges: [] };
    expect(resolveNodeProjectId(g, 'ag', 'fb')).toBe('fb');
  });

  it('returns undefined when no project is resolvable', () => {
    const g: FlowGraph = { nodes: [{ id: 'ag', blockType: 'agent' }], edges: [] };
    expect(resolveNodeProjectId(g, 'ag')).toBeUndefined();
  });
});

describe('expandAgentCommandsInGraph', () => {
  it('expands a leading command into its body and records the command name', async () => {
    const g = graphWith('/edge-cases focus on auth');
    const res = await expandAgentCommandsInGraph(g, deps());
    expect(res.ok).toBe(true);
    expect(g.nodes[1].config?.instructions).toBe('Review edge cases for focus on auth');
    expect(g.nodes[1].config?.instructionsCommandName).toBe('edge-cases');
  });

  it('hard-fails an unknown command with suggestions', async () => {
    const g = graphWith('/edge-casez');
    const res = await expandAgentCommandsInGraph(g, deps());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.failures[0]).toMatchObject({
      nodeId: 'ag',
      command: 'edge-casez',
      reason: 'not_found',
    });
    expect(res.failures[0].suggestions).toContain('edge-cases');
    // graph not persisted by the caller — leaving the literal in place is fine here.
  });

  it('hard-fails when the command file is empty', async () => {
    const g = graphWith('/edge-cases');
    const res = await expandAgentCommandsInGraph(g, deps({ getContent: async () => '   ' }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.failures[0].reason).toBe('empty');
  });

  it('leaves instructions without a leading command untouched', async () => {
    const g = graphWith('just do the thing /not-a-command');
    const res = await expandAgentCommandsInGraph(g, deps());
    expect(res.ok).toBe(true);
    expect(g.nodes[1].config?.instructions).toBe('just do the thing /not-a-command');
  });

  it('leaves built-in commands literal (no expansion, no failure)', async () => {
    const g = graphWith('/review');
    const res = await expandAgentCommandsInGraph(g, deps());
    expect(res.ok).toBe(true);
    expect(g.nodes[1].config?.instructions).toBe('/review');
    expect(g.nodes[1].config?.instructionsCommandName).toBeUndefined();
  });

  it('resolves project-scoped commands against the node’s real (start_task) project', async () => {
    // Command only exists when scanning the correct project path.
    const g = graphWith('/edge-cases');
    let scannedPath: string | undefined;
    const res = await expandAgentCommandsInGraph(
      g,
      deps({
        listCommands: async (pp) => {
          scannedPath = pp;
          return pp === PROJECT_PATH
            ? [{ name: 'edge-cases', path: `${PROJECT_PATH}/.frink/commands/edge-cases.md` }]
            : [];
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(scannedPath).toBe(PROJECT_PATH);
  });

  it('scans each project only once across multiple command-referencing nodes', async () => {
    const g: FlowGraph = {
      nodes: [
        { id: 'st', blockType: 'start_task', config: { projectId: 'proj-1' } },
        { id: 'ag1', blockType: 'agent', config: { instructions: '/edge-cases' } },
        { id: 'ag2', blockType: 'agent', config: { instructions: '/edge-cases too' } },
      ],
      edges: [
        { id: 'e1', source: 'st', target: 'ag1' },
        { id: 'e2', source: 'ag1', target: 'ag2' },
      ],
    };
    let scans = 0;
    const res = await expandAgentCommandsInGraph(
      g,
      deps({
        listCommands: async (pp) => {
          scans++;
          return pp === PROJECT_PATH
            ? [{ name: 'edge-cases', path: `${PROJECT_PATH}/.frink/commands/edge-cases.md` }]
            : [];
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(scans).toBe(1); // memoized — not one full FS scan per node
  });

  it('only (re)expands nodes named in targetNodeIds', async () => {
    // ag1 holds a stale expanded body beginning with "/think" (not a command);
    // a patch that targets only ag2 must leave ag1 untouched (no re-scan, no fail).
    const g: FlowGraph = {
      nodes: [
        { id: 'st', blockType: 'start_task', config: { projectId: 'proj-1' } },
        { id: 'ag1', blockType: 'agent', config: { instructions: '/think about it' } },
        { id: 'ag2', blockType: 'agent', config: { instructions: '/edge-cases now' } },
      ],
      edges: [
        { id: 'e1', source: 'st', target: 'ag1' },
        { id: 'e2', source: 'ag1', target: 'ag2' },
      ],
    };
    const res = await expandAgentCommandsInGraph(g, deps({ targetNodeIds: new Set(['ag2']) }));
    expect(res.ok).toBe(true);
    expect(g.nodes[1].config?.instructions).toBe('/think about it'); // ag1 untouched
    expect(g.nodes[2].config?.instructions).toBe('Review edge cases for now'); // ag2 expanded
  });
});

describe('formatExpansionFailures', () => {
  it('renders an actionable message', () => {
    const msg = formatExpansionFailures([
      {
        nodeId: 'ag',
        label: 'Agent',
        command: 'edge-casez',
        reason: 'not_found',
        suggestions: ['edge-cases'],
        available: ['edge-cases', 'plan'],
      },
    ]);
    expect(msg).toContain('not found');
    expect(msg).toContain('edge-cases');
    expect(msg).toContain('frink_flows_list_catalog');
  });
});

// sc-3166: the patch validates `/cmd` while short; the expanded body must still respect the cap.
describe('expandAgentCommandsInGraph — agent prose length cap', () => {
  it('fails (flow not saved) when a command expands past the cap, naming the limit', async () => {
    const g = graphWith('/edge-cases');
    const r = await expandAgentCommandsInGraph(
      g,
      deps({ getContent: async () => 'x'.repeat(50_001) }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failures).toMatchObject([{ nodeId: 'ag', command: 'edge-cases', reason: 'too_long' }]);
    expect(formatExpansionFailures(r.failures)).toContain(
      'command "/edge-cases" expands to instructions is 50,001 characters; the limit is 50,000',
    );
    // The graph keeps the short `/command` text — nothing over the cap is written back.
    expect(g.nodes[1]?.config?.instructions).toBe('/edge-cases');
  });

  it('expands a body exactly at the cap', async () => {
    const r = await expandAgentCommandsInGraph(
      graphWith('/edge-cases'),
      deps({ getContent: async () => 'x'.repeat(50_000) }),
    );
    expect(r.ok).toBe(true);
  });
});
