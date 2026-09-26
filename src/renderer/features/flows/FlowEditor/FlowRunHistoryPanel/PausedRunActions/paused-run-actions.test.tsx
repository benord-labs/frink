// @vitest-environment happy-dom
/**
 * Question parks — a non-plan awaiting_input node is a QUESTION: Answer (jump to the driving
 * chat) replaces the wrong verbs Retry/Skip. A blocked park gets Answer PLUS Retry/Skip (a chat
 * reply resumes with context); failed keeps Retry/Skip only. Tests the component directly (the
 * RunDetailPane wiring is covered by FlowRunHistoryPanel.tab.test.tsx).
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const snap = vi.hoisted(() => ({
  getFlowChatData: null as { chatId: string; subChatId: string | null } | null,
  getFlowChatFetch: vi.fn(),
  requestNav: vi.fn(),
}));

vi.mock('../../../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      tasks: {
        getFlowChatForNodeRun: {
          fetch: (input: unknown) => {
            snap.getFlowChatFetch(input);
            return Promise.resolve(snap.getFlowChatData);
          },
        },
      },
    }),
  },
}));

vi.mock('../../../../../hooks/use-dirty-nav-guard', () => ({
  useDirtyNavGuard: () => ({
    showDialog: false,
    requestNav: snap.requestNav,
    confirmNav: vi.fn(),
    cancelNav: vi.fn(),
  }),
}));

vi.mock('../BatchReportPanel/DirtyNavAlertDialog', () => ({
  DirtyNavAlertDialog: () => null,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { PausedRunActions } from './index';

function questionDetail(nodeStatus = 'awaiting_input') {
  return {
    graph: {
      nodes: [{ id: 'a', blockType: 'agent', label: 'Build', config: { mode: 'agent' } }],
    },
    nodeRuns: [
      {
        id: 'nr-a',
        node_id: 'a',
        block_type: 'agent',
        status: nodeStatus,
        node_output: null,
      },
    ],
  };
}

/**
 * A plan-mode agent node parks for two different reasons that share node status `awaiting_input`:
 * a submitted plan (plan_ready, no `signal` on the output) and a question the agent asked
 * (frink_task_signal awaiting_input, which stamps `signal`). Only the former may offer Approve.
 */
function planNodeDetail(opts: { autoApprove?: boolean; signal?: string } = {}) {
  return {
    graph: {
      nodes: [
        {
          id: 'a',
          blockType: 'agent',
          label: 'Plan',
          config: { mode: 'plan', autoApprove: opts.autoApprove },
        },
      ],
    },
    nodeRuns: [
      {
        id: 'nr-a',
        node_id: 'a',
        block_type: 'agent',
        status: 'awaiting_input',
        node_output: {
          status: 'awaiting_input',
          outputs: {},
          durationMs: 10,
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
      },
    ],
  };
}

/**
 * The Agent block's mode field defaults to unset = "inherit the start_task mode", so the effective
 * mode of a plan-gated flow lives on the UPSTREAM start_task, not on the agent node. `hops` puts a
 * pass-through node between the two to prove the walk is not limited to a direct predecessor.
 */
function inheritedPlanDetail(
  opts: { agentMode?: string; autoApprove?: boolean; signal?: string; hops?: number } = {},
) {
  const hops = opts.hops ?? 0;
  const middleIds = Array.from({ length: hops }, (_, i) => `c${i}`);
  const chain = ['start', ...middleIds, 'a'];
  return {
    graph: {
      nodes: [
        { id: 'start', blockType: 'start_task', label: 'Start', config: { startMode: 'plan' } },
        ...middleIds.map((id) => ({ id, blockType: 'condition', label: id, config: {} })),
        {
          id: 'a',
          blockType: 'agent',
          label: 'Plan',
          config: {
            ...(opts.agentMode ? { mode: opts.agentMode } : {}),
            ...(opts.autoApprove ? { autoApprove: true } : {}),
          },
        },
      ],
      edges: chain.slice(0, -1).map((source, i) => ({ source, target: chain[i + 1] })),
    },
    nodeRuns: [
      {
        id: 'nr-a',
        node_id: 'a',
        block_type: 'agent',
        status: 'awaiting_input',
        node_output: {
          status: 'awaiting_input',
          outputs: {},
          durationMs: 10,
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
      },
    ],
  };
}

function renderActions(detail: Parameters<typeof PausedRunActions>[0]['detail']) {
  const onResumeRun = vi.fn();
  render(<PausedRunActions detail={detail} onResumeRun={onResumeRun} resumePending={false} />);
  return { onResumeRun };
}

describe('PausedRunActions — question-park Answer jump', () => {
  afterEach(() => {
    cleanup();
    snap.getFlowChatData = null;
    snap.getFlowChatFetch.mockReset();
    snap.requestNav.mockReset();
  });

  it('offers Answer (not Retry/Skip) for a non-plan awaiting_input agent node', () => {
    renderActions(questionDetail());
    expect(screen.getByRole('button', { name: 'Answer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();
  });

  it('blocked node (signal blocked|partial) gets the Answer jump PLUS Retry/Skip', () => {
    // A chat reply resumes the park with context; Retry re-runs fresh. Both must be offered.
    renderActions(questionDetail('blocked'));
    expect(screen.getByRole('button', { name: 'Answer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();
  });

  it('failed node keeps Retry/Skip only — no parked reply pipe to answer into', () => {
    renderActions(questionDetail('failed'));
    expect(screen.queryByRole('button', { name: 'Answer' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();
  });

  it('resolves the node chat and requests navigation on Answer', async () => {
    snap.getFlowChatData = { chatId: 'chat-9', subChatId: 'sub-9' };
    renderActions(questionDetail());

    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    await waitFor(() => expect(snap.requestNav).toHaveBeenCalledWith('chat-9'));
    expect(snap.getFlowChatFetch).toHaveBeenCalledWith({ nodeRunId: 'nr-a' });
  });

  it('offers Approve for a plan-mode park carrying no agent signal (a submitted plan)', () => {
    renderActions(planNodeDetail());
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Answer' })).not.toBeInTheDocument();
  });

  it('offers Answer, NOT Approve, when a plan-mode node parked to ask a question', () => {
    // Approving would mark the node completed and advance the run with no plan and no answer,
    // skipping the plan_ready gate. The agent signal on the output is what distinguishes them.
    renderActions(planNodeDetail({ signal: 'awaiting_input' }));
    expect(screen.getByRole('button', { name: 'Answer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('offers Answer for an auto-approve plan node park (it never waits on approval)', () => {
    renderActions(planNodeDetail({ autoApprove: true, signal: 'awaiting_input' }));
    expect(screen.getByRole('button', { name: 'Answer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('offers Approve for a node INHERITING plan mode from its start_task', () => {
    // The Agent block's default is "Inherit from Start Task" (mode unset), so gating on the node's
    // own config.mode would strip Approve from the configuration users are steered toward.
    renderActions(inheritedPlanDetail());
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByText('Plan — plan ready')).toBeInTheDocument();
  });

  it('inherits through an intermediate node, not just a direct predecessor', () => {
    renderActions(inheritedPlanDetail({ hops: 2 }));
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('an explicit agent-mode override beats the inherited plan mode', () => {
    renderActions(inheritedPlanDetail({ agentMode: 'agent' }));
    expect(screen.getByRole('button', { name: 'Answer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('an inherited-plan park carrying an agent signal is a question, not a plan', () => {
    renderActions(inheritedPlanDetail({ signal: 'awaiting_input' }));
    expect(screen.getByRole('button', { name: 'Answer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('an inherited-plan node with autoApprove never waits on approval', () => {
    renderActions(inheritedPlanDetail({ autoApprove: true }));
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('resolves mode PER PARKED NODE — only the plan one gets Approve', () => {
    // Two agent nodes parked in the same run off one plan start_task: 'a' inherits, 'b' overrides
    // to agent. The gate resolves per node_id, so passing the wrong id would give both rows the
    // same verb — the failure a per-node unit test cannot see.
    const detail = {
      graph: {
        nodes: [
          { id: 'start', blockType: 'start_task', label: 'Start', config: { startMode: 'plan' } },
          { id: 'a', blockType: 'agent', label: 'Planner', config: {} },
          { id: 'b', blockType: 'agent', label: 'Builder', config: { mode: 'agent' } },
        ],
        edges: [
          { source: 'start', target: 'a' },
          { source: 'a', target: 'b' },
        ],
      },
      nodeRuns: ['a', 'b'].map((nodeId) => ({
        id: `nr-${nodeId}`,
        node_id: nodeId,
        block_type: 'agent',
        status: 'awaiting_input',
        node_output: { status: 'awaiting_input', outputs: {}, durationMs: 10 },
      })),
    };
    renderActions(detail);
    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(1);
    expect(screen.getByText('Planner — plan ready')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Answer' })).toBeInTheDocument();
  });

  it('Approve on an inheriting node resumes THAT node run', () => {
    const { onResumeRun } = renderActions(inheritedPlanDetail());
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onResumeRun).toHaveBeenCalledWith('approve', 'nr-a');
  });

  it('a non-agent block downstream of a plan start_task never gets Approve', () => {
    // Inheritance describes agent turns only; approving a parked run_command would advance the run
    // past a step that never produced a plan.
    const detail = {
      graph: {
        nodes: [
          { id: 'start', blockType: 'start_task', label: 'Start', config: { startMode: 'plan' } },
          { id: 'a', blockType: 'run_command', label: 'Build', config: {} },
        ],
        edges: [{ source: 'start', target: 'a' }],
      },
      nodeRuns: [
        {
          id: 'nr-a',
          node_id: 'a',
          block_type: 'run_command',
          status: 'awaiting_input',
          node_output: { status: 'awaiting_input', outputs: {}, durationMs: 10 },
        },
      ],
    };
    renderActions(detail);
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Answer' })).toBeInTheDocument();
  });

  it('renders a park with no graph snapshot instead of throwing', () => {
    // getRun returns `graph: FlowGraph | null` — a run whose flow version is gone still has to show
    // its parked nodes. Mode is then unknowable, so the row falls back to the question treatment.
    const detail = { ...inheritedPlanDetail(), graph: null };
    renderActions(detail);
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Answer' })).toBeInTheDocument();
  });

  it('shows an error toast and does not navigate when no chat resolves', async () => {
    snap.getFlowChatData = null;
    renderActions(questionDetail());

    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    const { toast } = await import('sonner');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('No chat found for this step'));
    expect(snap.requestNav).not.toHaveBeenCalled();
  });
});
