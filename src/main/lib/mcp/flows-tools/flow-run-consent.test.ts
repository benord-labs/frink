/**
 * Terminal enforcement of the per-flow agent-run grant on `frink_flows_run`.
 *
 * The gate that raises the consent card is covered in `flow-tool-dispatch.test.ts`,
 * but that suite mocks the handler wholesale — these tests prove the REAL handler
 * honours (and requires) the decision the gate passes it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetFlow = vi.fn();
const mockStartFlowRun = vi.fn();

vi.mock('../../flows/mcp-cloud-shim', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getFlow: (...args: unknown[]) => mockGetFlow(...args),
    startFlowRun: (...args: unknown[]) => mockStartFlowRun(...args),
  };
});

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { handleFlowsToolCall, resetFlowsRunCount } = await import('./index');

const FLOW_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

function flow(agentInvocable: boolean) {
  return {
    id: FLOW_ID,
    name: 'Nightly digest',
    is_enabled: true,
    agent_invocable: agentInvocable,
    graph: {
      nodes: [
        { id: 't1', blockType: 'manual_trigger' },
        { id: 'st1', blockType: 'start_task', config: { projectId: 'p1' } },
        { id: 'a1', blockType: 'agent', config: { instructions: 'do work' } },
      ],
      edges: [
        { id: 'e1', source: 't1', target: 'st1' },
        { id: 'e2', source: 'st1', target: 'a1' },
      ],
    },
  };
}

describe('frink_flows_run — per-flow agent-run grant', () => {
  beforeEach(() => {
    resetFlowsRunCount();
    mockGetFlow.mockReset();
    mockStartFlowRun.mockReset();
    mockStartFlowRun.mockResolvedValue({
      flowRunId: 'run-1',
      status: 'running',
      started_at: '2026-08-03T10:00:00.000Z',
    });
  });

  it('runs a flow that carries the standing grant', async () => {
    mockGetFlow.mockResolvedValue(flow(true));

    const result = await handleFlowsToolCall('frink_flows_run', { flowId: FLOW_ID });

    expect(result?.isError).toBeFalsy();
    expect(mockStartFlowRun).toHaveBeenCalledWith(FLOW_ID, { triggerContext: null });
  });

  it('refuses an ungranted flow when the call carries no consent', async () => {
    mockGetFlow.mockResolvedValue(flow(false));

    const result = await handleFlowsToolCall('frink_flows_run', { flowId: FLOW_ID });

    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/does not allow agent runs yet/);
    expect(mockStartFlowRun).not.toHaveBeenCalled();
  });

  it('runs an ungranted flow when the caller consented to this one invocation', async () => {
    mockGetFlow.mockResolvedValue(flow(false));

    const result = await handleFlowsToolCall(
      'frink_flows_run',
      { flowId: FLOW_ID },
      undefined,
      undefined,
      { invocationConsented: true },
    );

    expect(result?.isError).toBeFalsy();
    expect(mockStartFlowRun).toHaveBeenCalledWith(FLOW_ID, { triggerContext: null });
  });

  it('still refuses a disabled flow the user consented to run', async () => {
    // Consent answers "may an agent run this flow", not "is this flow runnable".
    mockGetFlow.mockResolvedValue({ ...flow(false), is_enabled: false });

    const result = await handleFlowsToolCall(
      'frink_flows_run',
      { flowId: FLOW_ID },
      undefined,
      undefined,
      { invocationConsented: true },
    );

    expect(result?.isError).toBe(true);
    expect(mockStartFlowRun).not.toHaveBeenCalled();
  });
});
