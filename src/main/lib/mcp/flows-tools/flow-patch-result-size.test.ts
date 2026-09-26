import { describe, expect, it } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { validateFlowTemplateVariables } from '../../../../shared/lib/validate-flow-templates';
import type { PatchOperation, PatchResult } from './flow-patch';
import { buildFlowPatchReceipt, buildFlowPatchResult } from './flow-patch-result';

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
    // latest flow, so it must survive any future trimming of the receipt.
    expect(body.graph).toEqual(LARGE_GRAPH);
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
    expect(body.graph).toEqual(LARGE_GRAPH);
  });
});

/**
 * Agent nodes all referencing an undeclared `{{previous.*}}` below a command node with declared
 * outputs. Each warning quotes the full available-field list, so warning volume drives size.
 */
function warningProneGraph(): FlowGraph {
  const agents = Array.from({ length: 24 }, (_, index) => ({
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

describe('Flow patch result size — warning volume', () => {
  const WARNING_GRAPH = warningProneGraph();

  it('produces a warning per offending node, each quoting the available fields', () => {
    const warnings = validateFlowTemplateVariables(WARNING_GRAPH);

    expect(warnings.length).toBeGreaterThanOrEqual(24);
    expect(warnings[0]?.message).toContain('declaredOutputField0');
  });

  it('keeps a patch on a warning-heavy flow within the tool-result budget', () => {
    const result = buildFlowPatchResult({
      patch: {
        status: 'success',
        graph: WARNING_GRAPH,
        applied: [0],
        failed: [],
        skipped: [],
      },
      receipt: buildFlowPatchReceipt({
        mode: 'update',
        baseGraph: WARNING_GRAPH,
        finalGraph: WARNING_GRAPH,
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
      templateWarnings: validateFlowTemplateVariables(WARNING_GRAPH),
      webhookSetup: [],
    });

    expect(result.content[0]?.text.length).toBeLessThan(MAX_PATCH_RESULT_CHARS);
  });
});
