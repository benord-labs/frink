// @vitest-environment happy-dom
/**
 * Behaviour tests for the Runs-tab master/detail pair: the rail (batch/run selection,
 * Active chip, Stop) and the RunDetailPane (View on canvas, restart-interrupted recovery,
 * plan-approval gating).
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Stable mock state (vi.hoisted runs before vi.mock factories)
// ---------------------------------------------------------------------------

const snap = vi.hoisted(() => ({
  listRunsData: [] as unknown[],
  listBatchesData: [] as unknown[],
  cancelRunMutate: vi.fn(),
  cancelRunIsPending: false,
  cancelRunVariables: undefined as { runId?: string } | undefined,
  resumeRunMutate: vi.fn(),
  resumeRunIsPending: false,
  resumeRunVariables: undefined as
    | { runId?: string; action?: string; nodeRunId?: string }
    | undefined,
  retryRunMutate: vi.fn(),
  retryRunIsPending: false,
  retryRunUseMutation: vi.fn((_options: { onError?: (err: { message: string }) => void }) => ({
    mutate: snap.retryRunMutate,
    isPending: snap.retryRunIsPending,
  })),
  getRunData: undefined as unknown,
  isListRunsLoading: false,
  isListRunsError: false,
  invalidate: vi.fn(),
  // Answer jump: chat resolved for a parked node + the dirty-guarded navigation request.
  getFlowChatData: null as { chatId: string; subChatId: string | null } | null,
  getFlowChatFetch: vi.fn(),
  requestNav: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../../../lib/trpc', () => ({
  trpc: {
    flows: {
      listRuns: {
        useQuery: () => ({
          data: snap.listRunsData,
          isLoading: snap.isListRunsLoading,
          isError: snap.isListRunsError,
        }),
      },
      listBatches: {
        useQuery: () => ({ data: snap.listBatchesData }),
      },
      getRun: {
        useQuery: () => ({ data: snap.getRunData, isLoading: false }),
      },
      cancelRun: {
        useMutation: () => ({
          mutate: snap.cancelRunMutate,
          isPending: snap.cancelRunIsPending,
          variables: snap.cancelRunVariables,
        }),
      },
      resumeRun: {
        useMutation: () => ({
          mutateAsync: snap.resumeRunMutate,
          isPending: snap.resumeRunIsPending,
          variables: snap.resumeRunVariables,
        }),
      },
      retryRunFromLastNode: { useMutation: snap.retryRunUseMutation },
    },
    useUtils: () => ({
      flows: {
        listRuns: { invalidate: snap.invalidate },
        listBatches: { invalidate: snap.invalidate },
        listBatchRuns: { invalidate: snap.invalidate },
        listBatchStages: { invalidate: snap.invalidate },
        getRun: { invalidate: snap.invalidate },
        list: { invalidate: snap.invalidate },
        get: { invalidate: snap.invalidate },
      },
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

vi.mock('../../atoms', () => ({
  flowLoopProgressAtomFamily: () => ({ init: null }),
}));

vi.mock('jotai', () => ({
  useAtomValue: () => null,
  useSetAtom: () => vi.fn(),
  atom: (init: unknown) => ({ init }),
  atomFamily: (fn: (id: unknown) => unknown) => fn,
}));

vi.mock('../../../../lib/utils/platform', () => ({
  isDesktopApp: () => false,
}));

vi.mock('../../../../lib/utils/format-time', () => ({
  formatRelativeTime: () => '1m ago',
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../FlowRunStatusIcon', () => ({
  FlowRunStatusIcon: () => <span>icon</span>,
  isLiveFlowAdmissionState: (state?: string | null) =>
    state != null && ['queued', 'claimed', 'active', 'releasing'].includes(state),
  shouldShowPausedActions: (status: string) => status === 'paused',
  shouldPollFlowAdmission: (status?: string | null, admissionState?: string | null) =>
    admissionState === 'queued' ||
    (status != null &&
      ['completed', 'failed', 'cancelled'].includes(status) &&
      ['claimed', 'active', 'releasing'].includes(admissionState ?? '')),
}));

vi.mock('./RunStatusLabel', () => ({
  RunStatusLabel: ({ status, suffix }: { status: string; suffix?: string }) => (
    <span>
      {status}
      {suffix}
    </span>
  ),
}));

// The Answer jump goes through the shared dirty-nav guard; stub it so the test asserts the
// navigation REQUEST (requestNav) without pulling the real jotai atoms / alert dialog in.
vi.mock('../../../../hooks/use-dirty-nav-guard', () => ({
  useDirtyNavGuard: () => ({
    showDialog: false,
    requestNav: snap.requestNav,
    confirmNav: vi.fn(),
    cancelNav: vi.fn(),
  }),
}));

vi.mock('./BatchReportPanel/DirtyNavAlertDialog', () => ({
  DirtyNavAlertDialog: () => null,
}));

vi.mock('../../LoopIterationBadge', () => ({
  LoopIterationBadge: () => null,
}));

vi.mock('./node-run-list', () => ({
  NodeRunList: () => null,
}));

vi.mock('@benord-labs/frink-primitives', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@benord-labs/frink-primitives')>()),
  Button: ({
    children,
    onClick,
    disabled,
    type,
    ...rest
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: 'button' | 'submit' | 'reset';
    [k: string]: unknown;
  }) => (
    <button type={type ?? 'button'} onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));

// Dynamic import after mocks are set up.
const { FlowRunHistoryPanel, RunDetailPane } = await import('./index');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FLOW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BATCH_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BATCH_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function renderRail(
  props: {
    activeBatchId?: string;
    selectedBatchId?: string | null;
    selectedRunId?: string | null;
    onSelectBatch?: (batchId: string) => void;
    onSelectRun?: (runId: string) => void;
  } = {},
) {
  const onSelectBatch = props.onSelectBatch ?? vi.fn();
  const onSelectRun = props.onSelectRun ?? vi.fn();
  render(
    <FlowRunHistoryPanel
      flowId={FLOW_ID}
      activeBatchId={props.activeBatchId}
      selectedBatchId={props.selectedBatchId ?? null}
      onSelectBatch={onSelectBatch}
      selectedRunId={props.selectedRunId ?? null}
      onSelectRun={onSelectRun}
    />,
  );
  return { onSelectBatch, onSelectRun };
}

function batchSummary(batchId: string, firstRunAt: string) {
  return {
    batch_id: batchId,
    run_count: 2,
    completed_count: 2,
    errored_count: 0,
    active_count: 0,
    first_run_at: firstRunAt,
    last_activity_at: firstRunAt,
  };
}

function runRow(id: string, status: string, batchId: string | null = null) {
  return {
    id,
    flow_id: FLOW_ID,
    status,
    started_at: '2026-06-04T00:00:00.000Z',
    completed_at: status === 'running' || status === 'paused' ? null : '2026-06-04T00:00:05.000Z',
    active_task_status: null,
    batch_id: batchId,
  };
}

afterEach(() => {
  cleanup();
  snap.listRunsData = [];
  snap.listBatchesData = [];
  snap.getRunData = undefined;
  snap.cancelRunMutate.mockReset();
  snap.resumeRunMutate.mockReset().mockResolvedValue(undefined);
  snap.retryRunMutate.mockReset();
  snap.invalidate.mockReset();
  snap.isListRunsLoading = false;
  snap.isListRunsError = false;
  snap.getFlowChatData = null;
  snap.getFlowChatFetch.mockReset();
  snap.requestNav.mockReset();
});

// ---------------------------------------------------------------------------
// Rail — batch selection, Active chip, run selection, Stop
// ---------------------------------------------------------------------------

describe('FlowRunHistoryPanel rail — selection', () => {
  it('selects a batch on header click and marks the selected group', async () => {
    const user = userEvent.setup();
    snap.listRunsData = [runRow('r1', 'completed', BATCH_A), runRow('r2', 'completed', BATCH_B)];
    snap.listBatchesData = [
      batchSummary(BATCH_A, '2026-06-01T00:00:00.000Z'),
      batchSummary(BATCH_B, '2026-06-02T00:00:00.000Z'),
    ];
    const { onSelectBatch } = renderRail({ selectedBatchId: BATCH_A });

    // Batch A (older) = ordinal 1, selected; Batch B = ordinal 2.
    const batchB = screen.getByText('Batch 2').closest('button') as HTMLButtonElement;
    await user.click(batchB);
    expect(onSelectBatch).toHaveBeenCalledWith(BATCH_B);

    const batchA = screen.getByText('Batch 1').closest('button') as HTMLButtonElement;
    expect(batchA).toHaveAttribute('aria-current', 'true');
    expect(batchB).not.toHaveAttribute('aria-current');
  });

  it('shows the Active chip only on the flow’s persisted run target', () => {
    snap.listRunsData = [runRow('r1', 'completed', BATCH_A), runRow('r2', 'completed', BATCH_B)];
    snap.listBatchesData = [
      batchSummary(BATCH_A, '2026-06-01T00:00:00.000Z'),
      batchSummary(BATCH_B, '2026-06-02T00:00:00.000Z'),
    ];
    renderRail({ activeBatchId: BATCH_B, selectedBatchId: BATCH_A });

    const chips = screen.getAllByText('Active');
    expect(chips).toHaveLength(1);
    expect(chips[0]?.closest('button')).toBe(screen.getByText('Batch 2').closest('button'));
  });

  it('selects a run on row click and marks the selected row', async () => {
    const user = userEvent.setup();
    snap.listRunsData = [runRow(RUN_ID, 'completed')];
    const { onSelectRun } = renderRail({ selectedRunId: null });

    const row = screen.getByText('completed').closest('button') as HTMLButtonElement;
    await user.click(row);
    expect(onSelectRun).toHaveBeenCalledWith(RUN_ID);

    cleanup();
    snap.listRunsData = [runRow(RUN_ID, 'completed')];
    renderRail({ selectedRunId: RUN_ID });
    expect(screen.getByText('completed').closest('button')).toHaveAttribute('aria-current', 'true');
  });

  it('stops a running run from the row without selecting it', async () => {
    const user = userEvent.setup();
    snap.listRunsData = [runRow(RUN_ID, 'running')];
    const { onSelectRun } = renderRail();

    await user.click(screen.getByRole('button', { name: 'Stop this run' }));
    expect(snap.cancelRunMutate).toHaveBeenCalledWith({ runId: RUN_ID });
    expect(onSelectRun).not.toHaveBeenCalled();
  });

  it('shows queue position and age and cancels a queued run', async () => {
    const user = userEvent.setup();
    snap.listRunsData = [
      {
        ...runRow(RUN_ID, 'pending'),
        admission_state: 'queued',
        queue_position: 3,
        admission_requested_at: '2026-06-04T00:00:00.000Z',
      },
    ];
    renderRail();

    expect(screen.getByText('queued · #3')).toBeInTheDocument();
    expect(screen.getByText('Queued 1m ago')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel queued run' }));
    expect(snap.cancelRunMutate).toHaveBeenCalledWith({ runId: RUN_ID });
  });
});

// ---------------------------------------------------------------------------
// RunDetailPane — View on canvas, restart-interrupted recovery, approval gating
// ---------------------------------------------------------------------------

const RESTART_REASON = 'Interrupted by app restart';

function cancelledDetail(
  markerOnNode: boolean,
  recovery: { kind: 'continue' | 'retry'; confirmSideEffects: boolean } = {
    kind: 'continue',
    confirmSideEffects: false,
  },
) {
  return {
    ...runRow(RUN_ID, 'cancelled'),
    // The server reports a recovery only for a restart-marked run.
    recoveries: markerOnNode ? [{ nodeRunId: 'nr-a', ...recovery }] : [],
    graph: { nodes: [{ id: 'a', blockType: 'agent', label: 'Triage' }], edges: [] },
    nodeRuns: [
      {
        id: 'nr-a',
        flow_run_id: RUN_ID,
        node_id: 'a',
        block_type: 'agent',
        status: 'cancelled',
        node_output: markerOnNode
          ? { status: 'cancelled', error: { message: RESTART_REASON, retryable: true } }
          : { status: 'cancelled', error: { message: 'Cancelled by user' } },
        attempt_number: 1,
        started_at: '2026-06-04T00:00:00.000Z',
        completed_at: '2026-06-04T00:00:05.000Z',
        created_at: '2026-06-04T00:00:00.000Z',
        lane_index: null,
        parent_fan_out_node_run_id: null,
      },
    ],
  };
}

function renderPane(props: { onViewOnCanvas?: (run: never) => void; runSummary?: never } = {}) {
  render(
    <RunDetailPane
      flowId={FLOW_ID}
      runId={RUN_ID}
      runSummary={props.runSummary}
      onViewOnCanvas={props.onViewOnCanvas as never}
    />,
  );
}

describe('RunDetailPane — View on canvas', () => {
  it('offers "View on canvas" on a terminal run and fires with the run detail', async () => {
    const user = userEvent.setup();
    const onViewOnCanvas = vi.fn();
    snap.getRunData = cancelledDetail(false);
    renderPane({ onViewOnCanvas });

    await user.click(screen.getByRole('button', { name: /View on canvas/i }));
    expect(onViewOnCanvas).toHaveBeenCalledWith(snap.getRunData);
  });

  it('hides "View on canvas" for an in-flight run', () => {
    const onViewOnCanvas = vi.fn();
    snap.getRunData = { ...cancelledDetail(false), status: 'running' };
    renderPane({ onViewOnCanvas });

    expect(screen.queryByRole('button', { name: /View on canvas/i })).not.toBeInTheDocument();
  });
});

describe('RunDetailPane — restart-interrupted recovery', () => {
  const CONTINUE = { name: /^Continue$/ };
  const RETRY = { name: /^Retry$/ };

  it('offers one Continue button that recovers the run straight away', async () => {
    const user = userEvent.setup();
    snap.getRunData = cancelledDetail(true);
    renderPane();

    expect(screen.queryByRole('button', RETRY)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', CONTINUE));
    expect(snap.retryRunMutate).toHaveBeenCalledWith({ runId: RUN_ID, kind: 'continue' });
  });

  it('retries an agent step that never started without a confirm', async () => {
    const user = userEvent.setup();
    snap.getRunData = cancelledDetail(true, { kind: 'retry', confirmSideEffects: false });
    renderPane();

    expect(screen.queryByRole('button', CONTINUE)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', RETRY));
    expect(snap.retryRunMutate).toHaveBeenCalledWith({ runId: RUN_ID, kind: 'retry' });
  });

  it('confirms before retrying a started step that may repeat its side effects', async () => {
    const user = userEvent.setup();
    snap.getRunData = cancelledDetail(true, { kind: 'retry', confirmSideEffects: true });
    renderPane();

    await user.click(screen.getByRole('button', RETRY));
    expect(snap.retryRunMutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('may repeat its side effects');
    await user.click(screen.getByRole('button', { name: /Retry anyway/ }));
    expect(snap.retryRunMutate).toHaveBeenCalledWith({ runId: RUN_ID, kind: 'retry' });
  });

  it("toasts the server's plain refusal when the run's chat was deleted", async () => {
    const { toast } = await import('sonner');
    snap.getRunData = cancelledDetail(true);
    renderPane();

    snap.retryRunUseMutation.mock.lastCall?.[0].onError?.({
      message: "This run's chat was deleted — start the flow again to re-run it.",
    });

    expect(toast.error).toHaveBeenCalledWith(
      "This run's chat was deleted — start the flow again to re-run it.",
    );
  });

  it('hides recovery for a user-cancelled run (no restart marker)', () => {
    snap.getRunData = cancelledDetail(false);
    renderPane();

    expect(screen.queryByRole('button', CONTINUE)).not.toBeInTheDocument();
  });

  it('shows queued detail and hides terminal recovery while its resume waits', () => {
    snap.getRunData = cancelledDetail(true);
    renderPane({
      runSummary: {
        ...runRow(RUN_ID, 'cancelled'),
        admission_state: 'queued',
        queue_position: 2,
        admission_requested_at: '2026-06-04T00:00:00.000Z',
      } as never,
    });

    expect(screen.getByText('queued · #2')).toBeInTheDocument();
    expect(screen.getByText('Queued 1m ago')).toBeInTheDocument();
    expect(screen.queryByRole('button', CONTINUE)).not.toBeInTheDocument();
  });

  it('keeps manual recovery available for a crash-recovered claimed resume', () => {
    snap.getRunData = {
      ...cancelledDetail(true),
      admission_state: 'claimed',
      queue_position: null,
      admission_requested_at: '2026-06-04T00:00:00.000Z',
    };
    renderPane();

    expect(screen.getByRole('button', CONTINUE)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Plan-approval Approve gating (autoApprove) — an auto-approve plan node must
// NOT offer Approve; a non-auto-approve plan node must. Retry/Skip stay either way.
// ---------------------------------------------------------------------------

function awaitingAgentNodeRun() {
  return {
    id: 'nr-a',
    flow_run_id: RUN_ID,
    node_id: 'a',
    block_type: 'agent',
    status: 'awaiting_input',
    node_output: null,
    attempt_number: 1,
    started_at: '2026-06-04T00:00:00.000Z',
    completed_at: null,
    created_at: '2026-06-04T00:00:00.000Z',
    lane_index: null,
    parent_fan_out_node_run_id: null,
  };
}

// `graphNodes` defaults to a single plan agent node carrying `nodeConfig`; pass `[]` to simulate a
// node deleted from the graph mid-run while its node_run still references it.
function pausedPlanDetail(nodeConfig: Record<string, unknown>, graphNodes?: unknown[]) {
  return {
    ...runRow(RUN_ID, 'paused'),
    active_task_status: 'plan_ready',
    graph: {
      nodes: graphNodes ?? [{ id: 'a', blockType: 'agent', label: 'Triage', config: nodeConfig }],
      edges: [],
    },
    nodeRuns: [awaitingAgentNodeRun()],
  };
}

describe('RunDetailPane — plan-approval Approve gating (autoApprove)', () => {
  it('offers Approve for an awaiting_input plan node when autoApprove is off', () => {
    snap.getRunData = pausedPlanDetail({ mode: 'plan', autoApprove: false });
    renderPane();

    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();
  });

  it('offers Approve for a plan node with autoApprove unset (common default config)', () => {
    snap.getRunData = pausedPlanDetail({ mode: 'plan' });
    renderPane();

    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('treats an auto-approve plan node’s residual awaiting_input as a question — Answer, no Approve', () => {
    // Auto-approve plan nodes resolve `done`, not `plan_ready`; a residual awaiting_input is a
    // genuine agent question, so the question verb (Answer) replaces Retry/Skip.
    snap.getRunData = pausedPlanDetail({ mode: 'plan', autoApprove: true });
    renderPane();

    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Answer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();
  });

  it('renders Answer (no Approve, no crash) when the graph node was deleted mid-run', () => {
    // Without a graph node there is no plan-approval config, so the awaiting_input park reads as a
    // question; the chat jump still resolves through the node_run's task, not the graph.
    snap.getRunData = pausedPlanDetail({}, []);
    renderPane();

    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Answer' })).toBeInTheDocument();
  });

  it('fires resumeRun with the action and node when Approve is clicked', async () => {
    const user = userEvent.setup();
    snap.getRunData = pausedPlanDetail({ mode: 'plan' });
    renderPane();

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(snap.resumeRunMutate).toHaveBeenCalledWith({
      runId: RUN_ID,
      action: 'approve',
      nodeRunId: 'nr-a',
    });
  });
});
