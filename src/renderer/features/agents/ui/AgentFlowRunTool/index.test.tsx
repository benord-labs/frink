// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { MessagePart } from '../../stores/message-store';
import { AgentFlowRunTool } from './index';

function makePart(output: Record<string, unknown>): MessagePart {
  return {
    type: 'tool-frink_flows_run',
    toolCallId: 'flow-run-1',
    state: 'output-available',
    input: { flowId: 'flow-1' },
    output,
  };
}

describe('AgentFlowRunTool', () => {
  afterEach(cleanup);

  it('labels a queued run with its position and never calls it started', () => {
    render(
      <AgentFlowRunTool
        part={makePart({
          success: true,
          flowId: 'flow-1',
          flowRunId: 'run-1',
          status: 'queued',
          runStatus: 'pending',
          admissionState: 'queued',
          queuePosition: 3,
          message: 'Flow run queued.',
        })}
        chatStatus="ready"
      />,
    );

    expect(screen.getByText('Queued flow run #3')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Queued flow run #3');
    expect(screen.queryByText(/Started flow run/)).not.toBeInTheDocument();
  });

  it('labels an admitted run as started', () => {
    render(
      <AgentFlowRunTool
        part={makePart({
          success: true,
          flowId: 'flow-1',
          flowRunId: 'run-2',
          status: 'started',
          runStatus: 'running',
          admissionState: 'active',
          queuePosition: null,
          message: 'Flow run started.',
        })}
        chatStatus="ready"
      />,
    );

    expect(screen.getByText('Started flow run')).toBeInTheDocument();
    expect(screen.queryByText(/Queued flow run/)).not.toBeInTheDocument();
  });
});
