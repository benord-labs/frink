// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import type { FlowChangeGraph } from '../../../../../shared/types/flows/flow-change-presentation';
import { toSafeFlowChangeGraph } from '../../../../lib/flows/flow-change-graph';
import type { MessagePart } from '../../stores/message-store';
import { outputPresentationRevision, parseOutput } from './index';

const BASE_GRAPH = { nodes: [], edges: [] };

function makePart(
  output: Record<string, unknown> | undefined,
  state: MessagePart['state'] = 'output-available',
): MessagePart {
  return { type: 'tool-frink_flows_patch', state, output };
}

describe('parseOutput', () => {
  describe('MCP content array format (part.output["0"].text)', () => {
    it('unwraps and parses the JSON string from the array item', () => {
      const part = makePart({
        '0': {
          type: 'text',
          text: JSON.stringify({ flowId: 'abc', name: 'My Flow', graph: BASE_GRAPH }),
        },
      });
      const result = parseOutput(part);
      expect(result).toEqual({ flowId: 'abc', name: 'My Flow', graph: BASE_GRAPH });
    });

    it('returns null when the text is not valid JSON', () => {
      const part = makePart({ '0': { type: 'text', text: 'not json' } });
      expect(parseOutput(part)).toBeNull();
    });

    it('includes graph when it has both nodes and edges arrays', () => {
      const graph = { nodes: [{ id: 'n1', blockType: 'manual_trigger', config: {} }], edges: [] };
      const part = makePart({
        '0': { type: 'text', text: JSON.stringify({ flowId: 'id1', name: 'Test', graph }) },
      });
      const result = parseOutput(part);
      expect(result?.graph).toEqual(graph);
    });

    it('keeps a topology-only receipt graph, so no base snapshot is fetched and every node renders', () => {
      const fullGraph = {
        nodes: [
          { id: 'trigger', blockType: 'manual_trigger', label: 'Launch' },
          ...Array.from({ length: 24 }, (_, index) => ({
            id: `agent-${index}`,
            blockType: 'agent',
            label: `Step ${index}`,
            config: { instructions: 'x'.repeat(8 * 1024) },
          })),
        ],
        edges: [{ id: 'e0', source: 'trigger', target: 'agent-0' }],
      };
      const topology = toSafeFlowChangeGraph(fullGraph);
      const receipt = (graph: FlowGraph | FlowChangeGraph | undefined) =>
        makePart({
          '0': { type: 'text', text: JSON.stringify({ flowId: 'f', name: 'F', graph }) },
        });

      const parsed = parseOutput(receipt(topology));

      // AgentFlowTool skips the base-snapshot refetch whenever the receipt carries a graph.
      expect(parsed?.graph).toBeDefined();
      expect(toSafeFlowChangeGraph(parsed?.graph)?.nodes).toHaveLength(fullGraph.nodes.length);
      // A message persisted before the receipt was narrowed projects to the same topology.
      expect(toSafeFlowChangeGraph(parseOutput(receipt(fullGraph))?.graph)).toEqual(
        toSafeFlowChangeGraph(parsed?.graph),
      );
    });

    it('re-projects a server-normalized receipt without changing labels or branch routes', () => {
      const fullGraph = {
        nodes: [
          { id: 'gate', blockType: 'condition', label: `Check\n${'very long label '.repeat(20)}` },
          { id: 'yes', blockType: 'agent', label: 'Approve' },
        ],
        edges: [{ id: 'e-yes', source: 'gate', target: 'yes', sourceHandle: 'true', label: 'Yes' }],
      };
      const topology = toSafeFlowChangeGraph(fullGraph);
      const part = makePart({
        '0': { type: 'text', text: JSON.stringify({ flowId: 'f', name: 'F', graph: topology }) },
      });

      // The server truncates and strips control characters once; the renderer's second pass
      // must be a no-op or the artifact's labels and revision key drift from the receipt.
      expect(toSafeFlowChangeGraph(parseOutput(part)?.graph)).toEqual(topology);
      expect(topology?.nodes[0]?.label).toHaveLength(96);
      expect(topology?.edges).toEqual([
        { id: 'e-yes', source: 'gate', target: 'yes', sourceHandle: 'true', label: 'Yes' },
      ]);
    });

    it('sets graph to undefined when graph has nodes but no edges (prevents useFlowLayout crash)', () => {
      const part = makePart({
        '0': {
          type: 'text',
          text: JSON.stringify({ flowId: 'id1', name: 'Test', graph: { nodes: [] } }),
        },
      });
      const result = parseOutput(part);
      expect(result).not.toBeNull();
      expect(result?.graph).toBeUndefined();
    });
  });

  describe('direct object format (part.output.flowId)', () => {
    it('reads flowId and name from top-level fields', () => {
      const part = makePart({ flowId: 'direct-id', name: 'Direct Flow', graph: BASE_GRAPH });
      const result = parseOutput(part);
      expect(result).toEqual({ flowId: 'direct-id', name: 'Direct Flow', graph: BASE_GRAPH });
    });

    it('sets status to partial when payload has status: partial', () => {
      const part = makePart({
        flowId: 'x',
        name: 'N',
        status: 'partial',
        graph: BASE_GRAPH,
      });
      expect(parseOutput(part)).toEqual({
        flowId: 'x',
        name: 'N',
        graph: BASE_GRAPH,
        status: 'partial',
      });
    });
  });

  describe('null / invalid output', () => {
    it('returns null when part.output is undefined', () => {
      expect(parseOutput(makePart(undefined))).toBeNull();
    });

    it('returns null when flowId is missing', () => {
      const part = makePart({ name: 'No ID', graph: BASE_GRAPH });
      expect(parseOutput(part)).toBeNull();
    });

    it('falls back to Untitled flow when name is missing', () => {
      const part = makePart({ flowId: 'id2' });
      const result = parseOutput(part);
      expect(result?.name).toBe('Untitled flow');
    });
  });
});

describe('outputPresentationRevision', () => {
  const SPILL =
    'Error: result (87,548 characters) exceeds maximum allowed tokens. Output has been saved to /sessions/abc/tool-results/patch.txt. Format: JSON with schema: {status: string}';

  it('changes when a string output becomes a spill note, without carrying its text', () => {
    const part: MessagePart = {
      type: 'tool-frink_flows_patch',
      state: 'output-available',
      result: 'ok',
    };
    const before = outputPresentationRevision(part);
    part.result = SPILL;
    const after = outputPresentationRevision(part);

    expect(after).not.toBe(before);
    expect(after).not.toContain('/sessions/');
  });

  it('reads the spill through the MCP text-block wrapper', () => {
    const blocks = makePart({ '0': { type: 'text', text: SPILL } });
    const plain = makePart({ '0': { type: 'text', text: 'ok' } });

    expect(outputPresentationRevision(blocks)).not.toBe(outputPresentationRevision(plain));
  });

  it('does not key a non-text body as a spill, matching the phase', () => {
    const wrapped = { type: 'tool-frink_flows_patch', state: 'output-available', result: [SPILL] };
    const other = { type: 'tool-frink_flows_patch', state: 'output-available', result: ['ok'] };

    expect(outputPresentationRevision(wrapped)).toBe(outputPresentationRevision(other));
  });
});
