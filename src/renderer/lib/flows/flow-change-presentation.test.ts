import { describe, expect, it } from 'vitest';
import { FLOW_PERMISSION_SUMMARIES } from '../../../shared/types/flows/flow-change-presentation';
import { buildFlowChangePresentation } from './flow-change-presentation';

describe('buildFlowChangePresentation', () => {
  it('classifies an explicit version-conflict receipt as stale without relying on prose', () => {
    const presentation = buildFlowChangePresentation({
      state: 'output-error',
      input: { name: 'Release train', operations: [] },
      errorText: JSON.stringify({
        status: 'failure',
        persistence: 'none',
        errorCode: 'FLOW_VERSION_CONFLICT',
        message: 'Remote write rejected',
      }),
    });

    expect(presentation.phase).toBe('stale');
  });

  it('keeps the surviving Flow reachable when an auto-create conflict cannot roll back', () => {
    const presentation = buildFlowChangePresentation({
      state: 'output-error',
      input: { name: 'Release train', operations: [] },
      errorText: JSON.stringify({
        status: 'failure',
        errorCode: 'FLOW_VERSION_CONFLICT',
        flowId: 'surviving-flow',
        message: 'Remote write rejected and cleanup could not be confirmed',
      }),
    });

    expect(presentation).toEqual(
      expect.objectContaining({ phase: 'stale', flowId: 'surviving-flow' }),
    );
  });

  it('projects a pending create without carrying config or instruction values into UI state', () => {
    const presentation = buildFlowChangePresentation({
      state: 'input-available',
      input: {
        name: 'Release train',
        operations: [
          {
            op: 'add_node',
            node: {
              id: 'agent',
              blockType: 'agent',
              label: 'Draft release',
              config: { instructions: 'PRIVATE-INSTRUCTION', token: 'PRIVATE-TOKEN' },
            },
          },
        ],
      },
    });

    expect(presentation.phase).toBe('applying');
    expect(presentation.name).toBe('Release train');
    expect(presentation.changes[0]).toEqual(
      expect.objectContaining({ action: 'add', label: 'Draft release', status: 'pending' }),
    );
    expect(presentation.graph?.nodes[0]).toEqual(
      expect.objectContaining({ id: 'agent', label: 'Draft release' }),
    );
    expect(JSON.stringify(presentation)).not.toMatch(/PRIVATE|instructions|token|config/);
  });

  it('uses the server receipt from persisted result state', () => {
    const presentation = buildFlowChangePresentation({
      state: 'output-available',
      input: { flowId: 'flow-1', operations: [] },
      result: {
        status: 'success',
        persistence: 'saved',
        flowId: 'flow-1',
        name: 'Release train',
        versionNumber: 4,
        graph: { nodes: [], edges: [] },
        flowChange: {
          schemaVersion: 1,
          mode: 'update',
          baseVersionNumber: 3,
          versionNumber: 4,
          changes: [
            {
              operationIndex: 0,
              action: 'update',
              kind: 'settings',
              status: 'applied',
              label: 'Flow settings',
              detail: 'Flow briefing',
            },
          ],
        },
      },
    });

    expect(presentation).toEqual(
      expect.objectContaining({
        phase: 'applied',
        baseVersionNumber: 3,
        versionNumber: 4,
      }),
    );
    expect(presentation.changes[0]?.detail).toBe('Flow briefing');
  });

  it('refines a legacy generic setup receipt from redaction-safe operation keys', () => {
    const presentation = buildFlowChangePresentation({
      state: 'output-available',
      input: {
        flowId: 'flow-1',
        operations: [
          {
            op: 'update_node',
            nodeId: 'agent',
            config: { instructions: 'PRIVATE-INSTRUCTION', privateToken: 'PRIVATE-TOKEN' },
          },
        ],
      },
      result: {
        status: 'success',
        persistence: 'saved',
        flowId: 'flow-1',
        name: 'Release train',
        graph: {
          nodes: [{ id: 'agent', blockType: 'agent', label: 'Draft release' }],
          edges: [],
        },
        flowChange: {
          schemaVersion: 1,
          mode: 'update',
          baseVersionNumber: 3,
          versionNumber: 4,
          changes: [
            {
              operationIndex: 0,
              action: 'update',
              kind: 'node',
              status: 'applied',
              label: 'Draft release',
              detail: 'Step setup',
              nodeId: 'agent',
            },
          ],
        },
      },
    });

    expect(presentation.changes[0]?.detail).toBe('Instructions · Other step setup');
    expect(JSON.stringify(presentation)).not.toMatch(/PRIVATE-INSTRUCTION|PRIVATE-TOKEN/);
  });

  it('resolves update targets from a fetched base snapshot while applying', () => {
    const presentation = buildFlowChangePresentation(
      {
        state: 'input-available',
        input: {
          flowId: 'flow-1',
          operations: [{ op: 'update_node', nodeId: 'agent', config: { instructions: 'secret' } }],
        },
      },
      {
        baseFlow: {
          id: 'flow-1',
          name: 'Release train',
          versionNumber: 6,
          graph: {
            nodes: [{ id: 'agent', blockType: 'agent', label: 'Draft release' }],
            edges: [],
          },
        },
      },
    );

    expect(presentation.name).toBe('Release train');
    expect(presentation.changes[0]?.label).toBe('Draft release');
    expect(presentation.changes[0]?.detail).toBe('Instructions');
  });

  it('distinguishes known no-write outcomes from unconfirmed errors', () => {
    const input = {
      flowId: 'flow-1',
      operations: [{ op: 'update_settings', settings: { pauseOnFailure: true } }],
    };

    expect(
      buildFlowChangePresentation({
        state: 'output-error',
        input,
        output: {
          permissionDenied: true,
          message: 'User denied permission',
          userMessage: FLOW_PERMISSION_SUMMARIES.denied,
        },
      }),
    ).toEqual(
      expect.objectContaining({
        phase: 'denied',
        denialReason: FLOW_PERMISSION_SUMMARIES.denied,
      }),
    );
    expect(
      buildFlowChangePresentation({
        state: 'output-error',
        input,
        errorText: 'Failed to save patched flow version (conflict): Version conflict.',
      }).phase,
    ).toBe('stale');
    expect(
      buildFlowChangePresentation({
        state: 'output-error',
        input,
        errorText: 'Connection closed after tool execution',
      }).phase,
    ).toBe('unconfirmed');
    expect(
      buildFlowChangePresentation({ state: 'input-available', input }, { interrupted: true }).phase,
    ).toBe('interrupted');
  });

  it.each([
    {
      label: 'denied',
      receipt: { output: { permissionDenied: true } },
      phase: 'denied',
    },
    {
      label: 'failed before save',
      receipt: {
        errorText: JSON.stringify({
          status: 'failure',
          persistence: 'none',
          message: 'Operation failed before save',
        }),
      },
      phase: 'failed',
    },
  ])('keeps the connected base graph after a $label removal', ({ phase, receipt }) => {
    const baseGraph = {
      nodes: [
        { id: 'start', blockType: 'manual_trigger', label: 'Start' },
        { id: 'work', blockType: 'agent', label: 'Work' },
        { id: 'done', blockType: 'agent', label: 'Done' },
      ],
      edges: [
        { id: 'start-work', source: 'start', target: 'work' },
        { id: 'work-done', source: 'work', target: 'done' },
      ],
    };
    const presentation = buildFlowChangePresentation(
      {
        state: 'output-error',
        input: { flowId: 'flow-1', operations: [{ op: 'remove_node', nodeId: 'work' }] },
        ...receipt,
      },
      {
        baseFlow: { id: 'flow-1', name: 'Release train', graph: baseGraph },
      },
    );

    expect(presentation.phase).toBe(phase);
    expect(presentation.graph?.edges).toEqual(baseGraph.edges);
    expect(presentation.graph?.nodes.map((node) => node.id)).toEqual(['start', 'work', 'done']);
  });

  it('does not resurrect a denied addition through a later update of the same node', () => {
    const presentation = buildFlowChangePresentation(
      {
        state: 'output-error',
        input: {
          flowId: 'flow-1',
          operations: [
            {
              op: 'add_node',
              node: { id: 'draft', blockType: 'agent', label: 'Draft release' },
            },
            { op: 'update_node', nodeId: 'draft', label: 'Rename draft' },
          ],
        },
        output: { permissionDenied: true },
      },
      {
        baseFlow: {
          id: 'flow-1',
          name: 'Release train',
          graph: {
            nodes: [{ id: 'start', blockType: 'manual_trigger', label: 'Start' }],
            edges: [],
          },
        },
      },
    );

    expect(presentation.phase).toBe('denied');
    expect(presentation.changes).toHaveLength(2);
    expect(presentation.graph?.nodes.map((node) => node.id)).toEqual(['start']);
  });

  it('keeps the confirmed receipt graph for an unchanged result without a base snapshot', () => {
    const graph = {
      nodes: [
        { id: 'start', blockType: 'manual_trigger', label: 'Start' },
        { id: 'work', blockType: 'agent', label: 'Work' },
        { id: 'done', blockType: 'agent', label: 'Done' },
      ],
      edges: [
        { id: 'start-work', source: 'start', target: 'work' },
        { id: 'work-done', source: 'work', target: 'done' },
      ],
    };
    const presentation = buildFlowChangePresentation({
      state: 'output-available',
      input: { flowId: 'flow-1', operations: [] },
      result: {
        status: 'success',
        persistence: 'unchanged',
        flowId: 'flow-1',
        name: 'Release train',
        graph,
      },
    });

    expect(presentation.phase).toBe('unchanged');
    expect(presentation.graph).toEqual(graph);
  });

  it('fails closed when an explicit failure includes a Flow id but no no-write proof', () => {
    const presentation = buildFlowChangePresentation({
      state: 'output-available',
      input: {
        flowId: 'flow-1',
        operations: [{ op: 'update_settings', settings: { pauseOnFailure: true } }],
      },
      result: { status: 'failure', flowId: 'flow-1' },
    });

    expect(presentation.phase).toBe('unconfirmed');
    expect(presentation.changes[0]?.status).toBe('unknown');
  });

  it('keeps a surviving auto-created Flow reachable without claiming its outcome', () => {
    const presentation = buildFlowChangePresentation({
      state: 'output-available',
      input: {
        name: 'Recovery flow',
        operations: [{ op: 'add_node', node: { id: 'start', blockType: 'manual_trigger' } }],
      },
      result: {
        status: 'failure',
        flowId: 'surviving-flow',
        message: 'Save failed and rollback could not be confirmed.',
      },
    });

    expect(presentation).toEqual(
      expect.objectContaining({
        phase: 'unconfirmed',
        flowId: 'surviving-flow',
      }),
    );
    expect(presentation.changes[0]?.status).toBe('unknown');
  });

  it.each([
    { status: 'success', persistence: 'none' },
    { status: 'success', persistence: 'unexpected' },
    { status: 'partial', persistence: 'none' },
  ])('fails closed for contradictory success persistence: %o', (output) => {
    const presentation = buildFlowChangePresentation({
      state: 'output-available',
      input: {
        flowId: 'flow-1',
        operations: [{ op: 'update_settings', settings: { pauseOnFailure: true } }],
      },
      result: { ...output, flowId: 'flow-1' },
    });

    expect(presentation.phase).toBe('unconfirmed');
    expect(presentation.changes[0]?.status).toBe('unknown');
  });

  it('unwraps the standard Codex CallToolResult envelope', () => {
    const presentation = buildFlowChangePresentation({
      state: 'output-available',
      input: {
        flowId: 'flow-1',
        operations: [{ op: 'update_settings', settings: { pauseOnFailure: true } }],
      },
      output: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'success',
              persistence: 'saved',
              flowId: 'flow-1',
              name: 'Release train',
              versionNumber: 4,
            }),
          },
        ],
      },
    });

    expect(presentation.phase).toBe('applied');
    expect(presentation.versionNumber).toBe(4);
  });

  it.each([
    {
      label: 'Codex conflict error',
      part: {
        state: 'output-available',
        result: {
          error: {
            message:
              'Failed to save patched flow version (conflict): Flow version conflict for flow flow-1',
          },
        },
      },
      expected: 'stale',
    },
    {
      label: 'Codex plain denial error',
      part: {
        state: 'output-available',
        result: { error: { message: 'User denied the MCP tool call.' } },
      },
      expected: 'denied',
    },
    {
      label: 'Codex structured denial error',
      part: {
        state: 'output-available',
        result: {
          error: {
            message: JSON.stringify({
              status: 'failure',
              persistence: 'none',
              permissionDenied: true,
            }),
          },
        },
      },
      expected: 'denied',
    },
    {
      label: 'Claude structured denial error',
      part: {
        state: 'output-error',
        errorText: JSON.stringify({
          status: 'failure',
          persistence: 'none',
          permissionDenied: true,
        }),
      },
      expected: 'denied',
    },
    {
      label: 'Claude structured no-write failure',
      part: {
        state: 'output-error',
        errorText: JSON.stringify({
          status: 'failure',
          persistence: 'none',
          message: 'Operation 1 failed before save',
        }),
      },
      expected: 'failed',
    },
  ])('classifies $label without claiming an unproved write', ({ part, expected }) => {
    const presentation = buildFlowChangePresentation({
      ...part,
      input: {
        flowId: 'flow-1',
        operations: [{ op: 'update_settings', settings: { pauseOnFailure: true } }],
      },
    });

    expect(presentation.phase).toBe(expected);
  });

  it('represents a successful idempotent patch as already current', () => {
    const presentation = buildFlowChangePresentation({
      state: 'output-available',
      input: {
        flowId: 'flow-1',
        operations: [{ op: 'update_settings', settings: { pauseOnFailure: true } }],
      },
      result: {
        status: 'success',
        persistence: 'unchanged',
        flowId: 'flow-1',
        name: 'Release train',
        versionNumber: 4,
        flowChange: {
          schemaVersion: 1,
          mode: 'update',
          baseVersionNumber: 4,
          versionNumber: 4,
          changes: [
            {
              operationIndex: 0,
              action: 'update',
              kind: 'settings',
              status: 'unchanged',
              label: 'Flow settings',
            },
          ],
        },
      },
    });

    expect(presentation.phase).toBe('unchanged');
    expect(presentation.changes[0]?.status).toBe('unchanged');
    expect(presentation.baseVersionNumber).toBe(4);
    expect(presentation.versionNumber).toBe(4);
  });

  it('drops malformed graph entries without crashing the topology contract', () => {
    const presentation = buildFlowChangePresentation({
      state: 'output-available',
      input: { flowId: 'flow-1', operations: [] },
      result: {
        status: 'success',
        persistence: 'saved',
        flowId: 'flow-1',
        graph: { nodes: [{ id: {}, blockType: {} }], edges: [] },
      },
    });

    expect(presentation.graph).toEqual({ nodes: [], edges: [] });
  });
});
