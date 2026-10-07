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

  describe('a result the harness spilled to disk', () => {
    // Literal harness text from claude-agent-sdk 0.3.278. Re-check when the SDK is upgraded.
    const SPILL =
      'Error: result (87,548 characters) exceeds maximum allowed tokens. Output has been saved to /sessions/abc/tool-results/mcp-frink_flows_patch-1.txt. Format: JSON with schema: {status: string}';
    const input = {
      flowId: 'flow-1',
      operations: [
        { op: 'add_node', node: { id: 'review', blockType: 'agent', label: 'Review' } },
        { op: 'update_node', nodeId: 'review', label: 'Review changes' },
        { op: 'update_settings', settings: { pauseOnFailure: true } },
      ],
    };

    it.each([
      { label: 'an error part', part: { state: 'output-error', errorText: SPILL } },
      { label: 'an available string output', part: { state: 'output-available', output: SPILL } },
      {
        label: 'an available text block output',
        part: { state: 'output-available', output: [{ type: 'text', text: SPILL }] },
      },
      { label: 'a persisted result', part: { state: 'output-available', result: SPILL } },
    ])('reads $label as finished but unread, not unconfirmed', ({ part }) => {
      const presentation = buildFlowChangePresentation({ ...part, input });

      expect(presentation.phase).toBe('unread');
      expect(presentation.changes).toHaveLength(3);
      expect(presentation.changes.map((change) => change.status)).toEqual([
        'unknown',
        'unknown',
        'unknown',
      ]);
      expect(presentation.flowId).toBe('flow-1');
      expect(presentation.versionNumber).toBeUndefined();
    });

    it('keeps an error it cannot recognise as unconfirmed', () => {
      expect(
        buildFlowChangePresentation({
          state: 'output-error',
          input,
          errorText: 'Error: result exceeds maximum allowed tokens.',
        }).phase,
      ).toBe('unconfirmed');
      expect(
        buildFlowChangePresentation({ state: 'output-available', input, output: 'ok' }).phase,
      ).toBe('unconfirmed');
    });

    it.each([
      {
        label: 'a no-write failure',
        receipt: { status: 'failure', persistence: 'none', message: SPILL },
        phase: 'failed',
      },
      {
        label: 'a denial',
        receipt: { status: 'failure', persistence: 'none', permissionDenied: true, message: SPILL },
        phase: 'denied',
      },
      {
        label: 'a version conflict',
        receipt: { errorCode: 'FLOW_VERSION_CONFLICT', message: SPILL },
        phase: 'stale',
      },
      {
        label: 'a failure without no-write proof',
        receipt: { status: 'failure', message: SPILL },
        phase: 'unconfirmed',
      },
    ])('lets $label that quotes the spill text win', ({ receipt, phase }) => {
      expect(
        buildFlowChangePresentation({
          state: 'output-error',
          input,
          errorText: JSON.stringify(receipt),
        }).phase,
      ).toBe(phase);
    });

    it.each([
      {
        label: 'an indexed text block (post JSON round-trip)',
        output: { '0': { type: 'text', text: SPILL } },
      },
      {
        label: 'a CallToolResult content envelope',
        output: { content: [{ type: 'text', text: SPILL }] },
      },
      {
        label: 'the persisted-output note',
        output:
          '<persisted-output>\nOutput too large (112.4KB). Full output saved to: /sessions/abc/tool-results/toolu_1.txt\n\nPreview (first 2KB):\n{"status":"success"',
      },
    ])('reads $label as unread', ({ output }) => {
      expect(buildFlowChangePresentation({ state: 'output-available', input, output }).phase).toBe(
        'unread',
      );
    });

    it.each([
      { label: 'a string error field', output: { error: SPILL } },
      { label: 'an error message object', output: { error: { message: SPILL } } },
      {
        label: 'a status-less wrapper that also carries a message',
        output: { error: SPILL, message: 'x' },
      },
    ])('reads a spill nested as $label in an error part as unread', ({ output }) => {
      expect(buildFlowChangePresentation({ state: 'output-error', input, output }).phase).toBe(
        'unread',
      );
    });

    it.each([
      {
        label: 'a failure receipt',
        output: { status: 'failure', error: SPILL },
        phase: 'unconfirmed',
      },
      {
        label: 'a no-write failure receipt',
        output: { status: 'failure', persistence: 'none', error: SPILL },
        phase: 'failed',
      },
      {
        label: 'a success receipt',
        output: { status: 'success', persistence: 'saved', flowId: 'flow-1', error: SPILL },
        phase: 'applied',
      },
    ])('lets $label win over a nested spill error', ({ output, phase }) => {
      expect(buildFlowChangePresentation({ state: 'output-available', input, output }).phase).toBe(
        phase,
      );
    });

    it('keeps a spill unread when the chat was interrupted after the result arrived', () => {
      expect(
        buildFlowChangePresentation(
          { state: 'output-available', input, output: SPILL },
          { interrupted: true },
        ).phase,
      ).toBe('unread');
    });

    it('reads a spill with no operations as unread with nothing listed', () => {
      const presentation = buildFlowChangePresentation({
        state: 'output-available',
        input: { flowId: 'flow-1', operations: [] },
        output: SPILL,
      });

      expect(presentation.phase).toBe('unread');
      expect(presentation.changes).toEqual([]);
    });

    it('does not duplicate a step that the spilled write already saved to the Flow', () => {
      // After a successful spilled write the only base available is the Flow as it is now.
      const presentation = buildFlowChangePresentation(
        {
          state: 'output-available',
          input: {
            flowId: 'flow-1',
            operations: [
              { op: 'add_node', node: { id: 'review', blockType: 'agent', label: 'Review' } },
              { op: 'add_edge', edge: { id: 'start-review', source: 'start', target: 'review' } },
            ],
          },
          output: SPILL,
        },
        {
          baseFlow: {
            id: 'flow-1',
            name: 'Release train',
            graph: {
              nodes: [
                { id: 'start', blockType: 'manual_trigger', label: 'Start' },
                { id: 'review', blockType: 'agent', label: 'Review' },
              ],
              edges: [{ id: 'start-review', source: 'start', target: 'review' }],
            },
            versionNumber: 9,
          },
        },
      );

      expect(presentation.phase).toBe('unread');
      expect(presentation.graph?.nodes.map((node) => node.id)).toEqual(['start', 'review']);
      expect(presentation.graph?.edges.map((edge) => edge.id)).toEqual(['start-review']);
      expect(presentation.versionNumber).toBeUndefined();
      expect(presentation.name).toBe('Release train');
    });

    it('does not invent a Flow id for a spilled create', () => {
      const presentation = buildFlowChangePresentation({
        state: 'output-available',
        input: { name: 'Release train', operations: input.operations },
        output: SPILL,
      });

      expect(presentation.phase).toBe('unread');
      expect(presentation.mode).toBe('create');
      expect(presentation.flowId).toBeUndefined();
    });
  });
});
