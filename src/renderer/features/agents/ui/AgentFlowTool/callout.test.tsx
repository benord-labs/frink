// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'jotai';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLOW_PERMISSION_SUMMARIES } from '../../../../../shared/types/flows/flow-change-presentation';
import type { MessagePart } from '../../stores/message-store';
import { AgentFlowTool } from './index';

vi.mock('../../../../hooks/useFlowBaseSnapshot', () => ({
  useFlowBaseSnapshot: () => undefined,
}));

function wrap(node: ReactNode) {
  return createElement(Provider, null, node);
}

const GRAPH = {
  nodes: [
    { id: 'trigger', blockType: 'manual_trigger', label: 'Launch' },
    { id: 'agent', blockType: 'agent', label: 'Draft release' },
  ],
  edges: [{ id: 'edge', source: 'trigger', target: 'agent' }],
};

describe('AgentFlowTool — mutation artifact', () => {
  afterEach(cleanup);

  it('renders a precise partial receipt instead of a generic warning callout', () => {
    const part: MessagePart = {
      type: 'tool-frink_flows_patch',
      state: 'output-available',
      input: {
        flowId: 'flow-1',
        operations: [
          { op: 'update_node', nodeId: 'agent', label: 'Write release' },
          { op: 'remove_edge', edgeId: 'edge' },
        ],
      },
      output: {
        flowId: 'flow-1',
        name: 'Release train',
        status: 'partial',
        versionNumber: 4,
        graph: {
          ...GRAPH,
          nodes: GRAPH.nodes.map((node) =>
            node.id === 'agent' ? { ...node, label: 'Write release' } : node,
          ),
        },
        applied: [0],
        failed: [{ index: 1, error: 'route is required' }],
      },
    };

    render(wrap(createElement(AgentFlowTool, { part })));

    expect(screen.getByRole('region', { name: 'Release train' })).toBeTruthy();
    expect(screen.getByText('Flow partly updated')).toBeTruthy();
    expect(screen.getByText('Launch → Write release. 1 applied, 1 failed')).toBeTruthy();
    expect(screen.getByText('Version 4 · 2 steps · 2 changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show Flow steps for Release train' }));
    expect(screen.getByRole('heading', { name: 'How this Flow runs' })).toBeTruthy();
    expect(screen.getByText('Updated: step name')).toBeTruthy();
    expect(screen.getAllByText(/Write release/).length).toBeGreaterThan(0);
    expect(screen.getByText('Could not remove this connection')).toBeTruthy();
    expect(screen.queryByText(/retryOps/i)).toBeNull();
  });

  it('renders an applied receipt and reveals the resulting Flow on demand', () => {
    const part: MessagePart = {
      type: 'tool-frink_flows_patch',
      state: 'output-available',
      input: {
        flowId: 'flow-1',
        operations: [{ op: 'update_node', nodeId: 'agent', label: 'Write release' }],
      },
      result: {
        flowId: 'flow-1',
        name: 'Release train',
        status: 'success',
        versionNumber: 4,
        graph: {
          ...GRAPH,
          nodes: GRAPH.nodes.map((node) =>
            node.id === 'agent' ? { ...node, label: 'Write release' } : node,
          ),
        },
        applied: [0],
      },
    };

    render(wrap(createElement(AgentFlowTool, { part })));

    expect(screen.getByText('Flow updated')).toBeTruthy();
    expect(screen.getByText('Write release: step name changed')).toBeTruthy();
    expect(screen.getByText('Version 4 · 2 steps · 1 change')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show Flow steps for Release train' }));
    expect(screen.getByRole('heading', { name: 'How this Flow runs' })).toBeTruthy();
    expect(
      screen.getByText('Write release').closest('[data-slot="flow-change-step"]')?.textContent,
    ).toContain('Updated: step name');
    expect(screen.queryByText('Next')).toBeNull();
    expect(screen.queryByText('Affected topology')).toBeNull();
  });

  it('shows the user-facing Frink permission summary and refreshes it in place', () => {
    const agentMessage =
      'Permission request timed out — the user did NOT deny it. The agent can retry.';
    const part: MessagePart = {
      type: 'tool-frink_flows_patch',
      state: 'output-available',
      input: {
        name: 'Release train',
        operations: [{ op: 'add_node', node: { id: 'agent', blockType: 'agent' } }],
      },
      output: {
        status: 'failure',
        persistence: 'none',
        permissionDenied: true,
        userMessage: FLOW_PERMISSION_SUMMARIES.timedOut,
        message: agentMessage,
      },
    };
    const { rerender } = render(wrap(createElement(AgentFlowTool, { part })));

    expect(screen.getByText('Flow not updated')).toBeTruthy();
    expect(screen.getByText(FLOW_PERMISSION_SUMMARIES.timedOut)).toBeTruthy();
    expect(screen.queryByText(agentMessage)).toBeNull();

    if (!part.output || Array.isArray(part.output)) throw new Error('Expected structured output');
    part.output.userMessage = FLOW_PERMISSION_SUMMARIES.denied;
    part.output.message = 'User denied permission';
    rerender(wrap(createElement(AgentFlowTool, { part })));

    expect(screen.getByText(FLOW_PERMISSION_SUMMARIES.denied)).toBeTruthy();
    expect(screen.queryByText(FLOW_PERMISSION_SUMMARIES.timedOut)).toBeNull();
  });

  it('recomputes when a provider mutates the MessagePart in place', () => {
    const part: MessagePart = {
      type: 'tool-frink_flows_patch',
      state: 'input-available',
      input: {
        name: 'Release train',
        operations: [{ op: 'add_node', node: { id: 'agent', blockType: 'agent' } }],
      },
    };
    const { rerender } = render(wrap(createElement(AgentFlowTool, { part })));

    expect(screen.getByText('Updating Flow')).toBeTruthy();

    part.state = 'output-available';
    part.result = {
      status: 'success',
      persistence: 'saved',
      flowId: 'flow-1',
      name: 'Release train',
      versionNumber: 1,
      graph: GRAPH,
      applied: [0],
    };
    rerender(wrap(createElement(AgentFlowTool, { part })));

    expect(screen.getByText('Flow created')).toBeTruthy();
    expect(screen.queryByText('Updating Flow')).toBeNull();
    expect(screen.getByText('Version 1 · 2 steps · 1 change')).toBeTruthy();
  });

  it('recomputes safe config detail beyond 64 config keys mutated in place', () => {
    const config: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        `a-unknown-${index.toString().padStart(2, '0')}`,
        `PRIVATE-UNKNOWN-${index}`,
      ]),
    );
    config.instructions = 'PRIVATE-INSTRUCTIONS';
    const part: MessagePart = {
      type: 'tool-frink_flows_patch',
      state: 'input-available',
      input: {
        name: 'Release train',
        operations: [{ op: 'update_node', nodeId: 'agent', config }],
      },
    };
    const { rerender } = render(wrap(createElement(AgentFlowTool, { part })));
    fireEvent.click(screen.getByRole('button', { name: 'Show Flow steps for Release train' }));

    expect(screen.getByText('Will change instructions and other step settings')).toBeTruthy();
    expect(screen.queryByText('PRIVATE-INSTRUCTIONS')).toBeNull();

    delete config.instructions;
    config.model = 'PRIVATE-MODEL';
    rerender(wrap(createElement(AgentFlowTool, { part })));

    expect(screen.getByText('Will change model and other step settings')).toBeTruthy();
    expect(screen.queryByText('Will change instructions and other step settings')).toBeNull();
    expect(screen.queryByText('PRIVATE-MODEL')).toBeNull();
  });

  it('keeps an expanded settled receipt stable when streaming rehydrates an equal result', () => {
    const part: MessagePart = {
      type: 'tool-frink_flows_patch',
      state: 'output-available',
      input: {
        flowId: 'flow-1',
        operations: [{ op: 'update_node', nodeId: 'agent', label: 'Write release' }],
      },
      result: {
        status: 'success',
        persistence: 'saved',
        flowId: 'flow-1',
        name: 'Release train',
        graph: GRAPH,
        applied: [0],
      },
    };
    const { rerender } = render(wrap(createElement(AgentFlowTool, { part })));
    fireEvent.click(screen.getByRole('button', { name: 'Show Flow steps for Release train' }));
    expect(screen.getByRole('heading', { name: 'How this Flow runs' })).toBeTruthy();

    const rehydratedPart = JSON.parse(JSON.stringify(part)) as MessagePart;
    rerender(wrap(createElement(AgentFlowTool, { part: rehydratedPart })));

    expect(screen.getByRole('button', { name: 'Hide Flow steps for Release train' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'How this Flow runs' })).toBeTruthy();
  });
});
