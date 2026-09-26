// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { MessagePart } from '../../stores/message-store';
import { parseOutput } from './index';

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
