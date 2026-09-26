// @vitest-environment happy-dom
/**
 * StageRunList — above-LOW severity edge case: pagination offset must reset when the
 * stage (or batch / flow) context changes so we do not request a stale page against a
 * different stage's total run count.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const FLOW_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const BATCH_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STAGE_1 = '11111111-1111-4111-8111-111111111111';
const STAGE_2 = '22222222-2222-4222-8222-222222222222';

const TOTAL = 120;

const snap = vi.hoisted(() => ({
  queryInputs: [] as Array<{
    flowId: string;
    stageId: string;
    limit: number;
    offset: number;
  }>,
}));

const useListBatchStageRunsQuery = vi.fn(
  (input: { flowId: string; stageId: string; limit: number; offset: number }) => {
    snap.queryInputs.push({ ...input });
    const pageLen = Math.min(input.limit, Math.max(0, TOTAL - input.offset));
    return {
      data: {
        runs: Array.from({ length: pageLen }, (_, i) => ({
          id: `run-${input.stageId.slice(0, 8)}-${input.offset + i}`,
          stage_id: input.stageId,
          status: 'completed',
          trigger_context: { label: `Run ${input.offset + i}` },
          started_at: null as string | null,
          completed_at: null as string | null,
          chat_id: null as string | null,
          needs_input: false,
        })),
        total: TOTAL,
      },
      isLoading: false,
      isError: false,
    };
  },
);

vi.mock('../../../../../lib/trpc', () => ({
  trpc: {
    flows: {
      listBatchStageRuns: {
        useQuery: (input: Parameters<typeof useListBatchStageRunsQuery>[0]) =>
          useListBatchStageRunsQuery(input),
      },
    },
    useUtils: () => ({}),
  },
}));

vi.mock('../../../../../hooks/use-dirty-nav-guard', () => ({
  useDirtyNavGuard: () => ({
    showDialog: false,
    requestNav: vi.fn(),
    confirmNav: vi.fn(),
    cancelNav: vi.fn(),
  }),
}));

vi.mock('../../FlowRunHistoryPanel/BatchReportPanel/DirtyNavAlertDialog', () => ({
  DirtyNavAlertDialog: () => null,
}));

vi.mock('../../FlowRunHistoryPanel/format-duration', () => ({
  formatDuration: () => '1s',
}));

vi.mock('../../../../../lib/utils/format-time', () => ({
  formatRelativeTime: () => '1m ago',
}));

vi.mock('../../FlowRunStatusIcon', () => ({
  FlowRunStatusIcon: () => null,
}));

vi.mock('@benord-labs/frink-primitives', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@benord-labs/frink-primitives')>()),
  Button: ({
    children,
    onClick,
    disabled,
    type,
    'aria-label': ariaLabel,
    ...rest
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: 'button' | 'submit' | 'reset';
    'aria-label'?: string;
    [k: string]: unknown;
  }) => (
    <button
      type={type ?? 'button'}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      {...rest}
    >
      {children}
    </button>
  ),
}));

const { StageRunList } = await import('./StageRunList');
const { deriveRunLabel } = await import('./utils');

afterEach(() => {
  cleanup();
  snap.queryInputs.length = 0;
  useListBatchStageRunsQuery.mockClear();
});

describe('deriveRunLabel', () => {
  it('returns label when present', () => {
    expect(deriveRunLabel({ label: 'My Task' }, 0)).toBe('My Task');
  });

  it('falls through to ticketId when label is an empty string', () => {
    expect(deriveRunLabel({ label: '', ticketId: 'sc-100' }, 0)).toBe('sc-100');
  });

  it('falls through to title when label and ticketId are absent', () => {
    expect(deriveRunLabel({ title: 'Sprint cleanup' }, 3)).toBe('Sprint cleanup');
  });

  it('returns "Run N+1" when triggerContext is null', () => {
    expect(deriveRunLabel(null, 2)).toBe('Run 3');
  });

  it('returns "Run N+1" when all string fields are empty', () => {
    expect(deriveRunLabel({ label: '', ticketId: '', title: '' }, 0)).toBe('Run 1');
  });

  it('returns ticketId when label absent but ticketId present', () => {
    expect(deriveRunLabel({ ticketId: 'sc-200' }, 5)).toBe('sc-200');
  });
});

describe('StageRunList', () => {
  it('resets pagination offset to 0 when stageId changes after advancing pages', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <StageRunList flowId={FLOW_ID} batchId={BATCH_ID} stageId={STAGE_1} />,
    );

    await waitFor(() => {
      expect(snap.queryInputs.some((q) => q.stageId === STAGE_1 && q.offset === 0)).toBe(true);
    });

    await user.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() => {
      expect(snap.queryInputs.some((q) => q.stageId === STAGE_1 && q.offset === 50)).toBe(true);
    });

    rerender(<StageRunList flowId={FLOW_ID} batchId={BATCH_ID} stageId={STAGE_2} />);

    await waitFor(() => {
      const stage2Zero = snap.queryInputs.filter((q) => q.stageId === STAGE_2 && q.offset === 0);
      expect(stage2Zero.length).toBeGreaterThan(0);
    });

    const lastForStage2 = [...snap.queryInputs].reverse().find((q) => q.stageId === STAGE_2);
    expect(lastForStage2?.offset).toBe(0);
  });

  it('resets pagination offset to 0 when batchId changes', async () => {
    const user = userEvent.setup();
    const BATCH_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const { rerender } = render(
      <StageRunList flowId={FLOW_ID} batchId={BATCH_ID} stageId={STAGE_1} />,
    );

    await waitFor(() => {
      expect(snap.queryInputs.some((q) => q.stageId === STAGE_1 && q.offset === 0)).toBe(true);
    });

    await user.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() => {
      expect(snap.queryInputs.some((q) => q.stageId === STAGE_1 && q.offset === 50)).toBe(true);
    });

    rerender(<StageRunList flowId={FLOW_ID} batchId={BATCH_B} stageId={STAGE_1} />);

    await waitFor(() => {
      // batchId is not part of the query (listBatchStageRuns keys on stageId), but
      // changing batchId resets the offset via the useEffect dependency array.
      const afterReset = snap.queryInputs.filter((q) => q.stageId === STAGE_1 && q.offset === 0);
      expect(afterReset.length).toBeGreaterThan(1); // initial + post-reset
    });

    const lastForStage1 = [...snap.queryInputs].reverse().find((q) => q.stageId === STAGE_1);
    expect(lastForStage1?.offset).toBe(0);
  });
});

describe('RunRow park states', () => {
  function mockPage(run: Record<string, unknown>) {
    useListBatchStageRunsQuery.mockReturnValueOnce({
      data: { runs: [run], total: 1 },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useListBatchStageRunsQuery>);
  }

  const baseRun = {
    id: 'run-1',
    stage_id: STAGE_1,
    status: 'dispatched',
    trigger_context: { label: 'Run 1' },
    started_at: null,
    completed_at: null,
    chat_id: null,
    needs_input: false,
  };

  it('shows the raw status for a normal dispatched run', () => {
    mockPage(baseRun);
    render(<StageRunList flowId={FLOW_ID} batchId={BATCH_ID} stageId={STAGE_1} />);
    expect(screen.getByText('dispatched')).toBeInTheDocument();
    expect(screen.queryByText('merge conflict — needs input')).not.toBeInTheDocument();
  });

  it('derives a needs-input state while the start_task is parked on a conflict', () => {
    mockPage({ ...baseRun, merge_conflict: true, start_task_status: 'awaiting_input' });
    render(<StageRunList flowId={FLOW_ID} batchId={BATCH_ID} stageId={STAGE_1} />);
    expect(screen.getByText('merge conflict — needs input')).toBeInTheDocument();
    expect(screen.queryByText('dispatched')).not.toBeInTheDocument();
  });

  it('returns to the raw status once the start_task has resumed past the conflict', () => {
    mockPage({ ...baseRun, merge_conflict: true, start_task_status: 'completed' });
    render(<StageRunList flowId={FLOW_ID} batchId={BATCH_ID} stageId={STAGE_1} />);
    expect(screen.getByText('dispatched')).toBeInTheDocument();
  });

  it('reads needs input when the server flagged the run as waiting on a human', () => {
    mockPage({ ...baseRun, needs_input: true });
    render(<StageRunList flowId={FLOW_ID} batchId={BATCH_ID} stageId={STAGE_1} />);
    expect(screen.getByText('needs input')).toBeInTheDocument();
    expect(screen.queryByText('dispatched')).not.toBeInTheDocument();
  });

  it('keeps the conflict label, which names the reason, over the generic flag', () => {
    mockPage({
      ...baseRun,
      needs_input: true,
      merge_conflict: true,
      start_task_status: 'awaiting_input',
    });
    render(<StageRunList flowId={FLOW_ID} batchId={BATCH_ID} stageId={STAGE_1} />);
    expect(screen.getByText('merge conflict — needs input')).toBeInTheDocument();
    expect(screen.queryByText('needs input')).not.toBeInTheDocument();
  });
});
