import { describe, expect, it } from 'vitest';
import { toSafeFlowChangeGraph } from '../../../../shared/lib/flows/flow-change-topology';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { validateFlowTemplateVariables } from '../../../../shared/lib/validate-flow-templates';
import type { PatchOperation, PatchResult } from './flow-patch';
import { buildFlowPatchReceipt, buildFlowPatchResult } from './flow-patch-result';
import { MAX_TEMPLATE_WARNINGS } from './patch';

type PersistedPatch = Extract<PatchResult, { status: 'success' | 'partial' }>;

const UPDATE_OPERATION: PatchOperation = {
  op: 'update_node',
  nodeId: 'agent-0',
  config: { instructions: 'PATCHED' },
};

function parseResult(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

/**
 * A receipt above the harness token cap is discarded, so a successful patch reports as a failure.
 * Character proxy for that cap, with headroom.
 */
const MAX_PATCH_RESULT_CHARS = 40_000;

const LONG_INSTRUCTIONS = 'Investigate the ticket and summarise the outcome. '.repeat(20);

/**
 * A flow large enough that per-flow fields, not the patch, dominate the payload. Instruction
 * length scales the receipt fastest, so nodes carry realistic instructions rather than labels.
 */
function largeGraph(): FlowGraph {
  const agents = Array.from({ length: 24 }, (_, index) => ({
    id: `agent-${index}`,
    blockType: 'agent',
    label: `Step ${index}`,
    config: { instructions: LONG_INSTRUCTIONS },
  }));
  return {
    nodes: [{ id: 'trigger', blockType: 'manual_trigger', label: 'Launch' }, ...agents],
    edges: agents.map((agent, index) => ({
      id: `edge-${index}`,
      source: index === 0 ? 'trigger' : `agent-${index - 1}`,
      target: agent.id,
    })),
  };
}

const LARGE_GRAPH = largeGraph();

const LARGE_OPERATIONS: PatchOperation[] = [
  { op: 'update_node', nodeId: 'missing', config: {} },
  { op: 'update_node', nodeId: 'agent-0', config: { instructions: LONG_INSTRUCTIONS } },
];

function largeResultFor(patch: PersistedPatch) {
  return buildFlowPatchResult({
    patch,
    receipt: buildFlowPatchReceipt({
      mode: 'update',
      baseGraph: LARGE_GRAPH,
      finalGraph: patch.graph,
      operations: LARGE_OPERATIONS,
      applied: patch.applied,
      failed: patch.failed,
      skipped: patch.skipped,
      baseVersionNumber: 3,
      persistedVersionNumber: 4,
    }),
    flowId: 'flow-large',
    versionId: 'version-4',
    name: 'Large flow',
    operationCount: LARGE_OPERATIONS.length,
    creationProjectNote: null,
    createdFlow: false,
    templateWarnings: [],
    webhookSetup: [],
  });
}

describe('Flow patch result size', () => {
  it('keeps a successful patch on a large flow within the tool-result budget', () => {
    const result = largeResultFor({
      status: 'success',
      graph: LARGE_GRAPH,
      applied: [0, 1],
      failed: [],
      skipped: [],
    });
    const body = parseResult(result);

    expect(result.content[0]?.text.length).toBeLessThan(MAX_PATCH_RESULT_CHARS);
    // Per-node template variables are derived data with no reader on either side of the receipt.
    expect(body).not.toHaveProperty('nodeVariables');
    expect(body).toEqual(
      expect.objectContaining({ status: 'success', applied: [0, 1], failed: [], skipped: [] }),
    );
    expect(body.flowChange).toBeDefined();
    // The chat artifact renders from this version-pinned topology rather than refetching the
    // latest flow, so every node must stay in it.
    expect(body.graph).toEqual(toSafeFlowChangeGraph(LARGE_GRAPH));
    expect((body.graph as FlowGraph).nodes).toHaveLength(LARGE_GRAPH.nodes.length);
  });

  it('keeps a partial patch on a large flow within the same budget', () => {
    const result = largeResultFor({
      status: 'partial',
      graph: LARGE_GRAPH,
      applied: [1],
      failed: [{ index: 0, error: 'missing' }],
      skipped: [],
    });
    const body = parseResult(result);

    expect(result.content[0]?.text.length).toBeLessThan(MAX_PATCH_RESULT_CHARS);
    expect(body).not.toHaveProperty('nodeVariables');
    expect(body.retryOps).toEqual([0]);
    expect(body.templateWarnings).toEqual([expect.stringContaining('graph is partial')]);
    expect(body.graph).toEqual(toSafeFlowChangeGraph(LARGE_GRAPH));
  });

  it('echoes topology only, so instruction bytes do not grow the receipt', () => {
    const resultWith = (instructions: string, status: 'success' | 'partial') => {
      const graph: FlowGraph = {
        ...LARGE_GRAPH,
        nodes: LARGE_GRAPH.nodes.map((node) =>
          node.blockType === 'agent' ? { ...node, config: { instructions } } : node,
        ),
      };
      return largeResultFor(
        status === 'success'
          ? { status, graph, applied: [0, 1], failed: [], skipped: [] }
          : { status, graph, applied: [1], failed: [{ index: 0, error: 'missing' }], skipped: [] },
      );
    };

    for (const status of ['success', 'partial'] as const) {
      const heavy = resultWith('x'.repeat(8 * 1024), status);
      const light = resultWith('Short.', status);
      const heavyText = heavy.content[0]?.text ?? '';
      const graph = parseResult(heavy).graph as { nodes: Record<string, unknown>[] };

      expect(heavyText.length).toBeLessThan(MAX_PATCH_RESULT_CHARS);
      expect(heavyText.length).toBe(light.content[0]?.text.length);
      expect(graph.nodes).toHaveLength(LARGE_GRAPH.nodes.length);
      for (const node of graph.nodes) {
        expect(Object.keys(node).sort()).toEqual(['blockType', 'id', 'label']);
      }
    }
  });

  it('keeps a flow with many long-labelled nodes within the budget', () => {
    const agents = Array.from({ length: 120 }, (_, index) => ({
      id: `agent-${index}`,
      blockType: 'agent',
      label: `Step ${index} `.repeat(40),
      config: { instructions: LONG_INSTRUCTIONS },
    }));
    const graph: FlowGraph = {
      nodes: agents,
      edges: agents.slice(1).map((agent, index) => ({
        id: `edge-${index}`,
        source: `agent-${index}`,
        target: agent.id,
      })),
    };
    const result = largeResultFor({
      status: 'success',
      graph,
      applied: [0, 1],
      failed: [],
      skipped: [],
    });

    expect(result.content[0]?.text.length).toBeLessThan(MAX_PATCH_RESULT_CHARS);
  });
});

/**
 * Agent nodes all referencing an undeclared `{{previous.*}}` below a command node with declared
 * outputs. Each warning quotes the full available-field list, so warning volume drives size.
 */
function warningProneGraph(agentCount = 24): FlowGraph {
  const agents = Array.from({ length: agentCount }, (_, index) => ({
    id: `agent-${index}`,
    blockType: 'agent',
    label: `Step ${index}`,
    config: { instructions: `Use {{previous.undeclaredField}} for step ${index}.` },
  }));
  return {
    nodes: [
      { id: 'trigger', blockType: 'manual_trigger', label: 'Launch' },
      {
        id: 'collect',
        blockType: 'run_command',
        label: 'Collect',
        config: {
          command: './collect.sh',
          expectedOutputs: Object.fromEntries(
            Array.from({ length: 8 }, (_, index) => [
              `declaredOutputField${index}`,
              { type: 'string', description: `Declared output field number ${index}` },
            ]),
          ),
        },
      },
      ...agents,
    ],
    edges: [
      { id: 'launch-collect', source: 'trigger', target: 'collect' },
      ...agents.map((agent) => ({
        id: `collect-${agent.id}`,
        source: 'collect',
        target: agent.id,
      })),
    ],
  };
}

function warningPatchResult(graph: FlowGraph) {
  return buildFlowPatchResult({
    patch: { status: 'success', graph, applied: [0], failed: [], skipped: [] },
    receipt: buildFlowPatchReceipt({
      mode: 'update',
      baseGraph: graph,
      finalGraph: graph,
      operations: [UPDATE_OPERATION],
      applied: [0],
      failed: [],
      skipped: [],
      baseVersionNumber: 3,
      persistedVersionNumber: 4,
    }),
    flowId: 'flow-warnings',
    versionId: 'version-4',
    name: 'Warning flow',
    operationCount: 1,
    creationProjectNote: null,
    createdFlow: false,
    templateWarnings: validateFlowTemplateVariables(graph),
    webhookSetup: [],
  });
}

type WarningBody = {
  message: string;
  templateWarnings: Array<{ placeholder: string; message: string }>;
  availableFields: Record<string, string[]>;
  templateWarningsSuppressed?: number;
};

function warningBytes(body: WarningBody): number {
  return JSON.stringify([body.templateWarnings, body.availableFields]).length;
}

describe('Flow patch result size — warning volume', () => {
  const WARNING_GRAPH = warningProneGraph();
  const DECLARED = Array.from({ length: 8 }, (_, index) => `previous.declaredOutputField${index}`);

  it('produces a warning per offending node, each quoting the available fields', () => {
    const warnings = validateFlowTemplateVariables(WARNING_GRAPH);

    expect(warnings.length).toBeGreaterThanOrEqual(24);
    expect(warnings[0]?.message).toContain('declaredOutputField0');
  });

  it('keeps a patch on a warning-heavy flow within the tool-result budget', () => {
    const result = warningPatchResult(WARNING_GRAPH);

    expect(result.content[0]?.text.length).toBeLessThan(MAX_PATCH_RESULT_CHARS);
  });

  it('grows far less than the warning count, quoting a shared field list once', () => {
    const small = parseResult(warningPatchResult(WARNING_GRAPH)) as WarningBody;
    const large = parseResult(warningPatchResult(warningProneGraph(96))) as WarningBody;

    expect(warningBytes(large) / warningBytes(small)).toBeLessThan(1.5);
    expect(Object.values(small.availableFields)).toEqual([expect.arrayContaining(DECLARED)]);
  });

  it('names the valid fields for every bad {{previous.*}} it shows, with no further call', () => {
    const body = parseResult(warningPatchResult(warningProneGraph(96))) as WarningBody;
    const previousWarnings = body.templateWarnings.filter((w) =>
      w.placeholder.startsWith('{{previous.'),
    );

    expect(previousWarnings.length).toBeGreaterThan(0);
    for (const warning of previousWarnings) {
      const key = /availableFields\.(\w+)/.exec(warning.message)?.[1] ?? '';
      expect(body.availableFields[key]).toEqual(expect.arrayContaining(DECLARED));
    }
  });

  it('counts the warnings past the cap and tells the agent how to see them', () => {
    const graph = warningProneGraph(96);
    const total = validateFlowTemplateVariables(graph).length;
    const body = parseResult(warningPatchResult(graph)) as WarningBody;

    expect(body.templateWarnings).toHaveLength(MAX_TEMPLATE_WARNINGS);
    expect(body.templateWarningsSuppressed).toBe(total - MAX_TEMPLATE_WARNINGS);
    expect(body.message).toContain(
      `${total - MAX_TEMPLATE_WARNINGS} more template warnings not shown`,
    );
  });
});
