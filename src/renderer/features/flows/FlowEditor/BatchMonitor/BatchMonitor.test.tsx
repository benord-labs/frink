// @vitest-environment happy-dom
/**
 * BatchMonitor: toolbar composition (summary vs not-started fallback, Active chip,
 * plan tools), the Edit-plan gate — dependency editing is only offered while the batch
 * still has pending (editable) stages — and the stage node's needs-input label.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const snap = vi.hoisted(() => ({
  stages: [] as unknown[],
  batches: [] as unknown[],
  invalidate: vi.fn(),
}));

vi.mock('../../../../lib/trpc', () => ({
  trpc: {
    flows: {
      listBatchStages: {
        useQuery: () => ({
          data: { stages: snap.stages },
          isError: false,
          isFetching: false,
          refetch: vi.fn(),
        }),
      },
      listBatches: { useQuery: () => ({ data: snap.batches }) },
    },
    useUtils: () => ({
      flows: { listBatchStages: { invalidate: snap.invalidate } },
    }),
  },
}));

vi.mock('../FlowRunHistoryPanel/BatchReportPanel', () => ({
  BatchPlanCanvas: () => <div data-testid="plan-canvas" />,
  LoadTemplatePicker: () => <div data-testid="load-template" />,
  SaveTemplatePopover: () => <div data-testid="save-template" />,
}));

vi.mock('./BatchDagCanvas', () => ({
  BatchDagCanvas: () => <div data-testid="dag-canvas" />,
}));

vi.mock('./StageDetailPanel', () => ({
  StageDetailPanel: () => <div data-testid="stage-detail" />,
}));

vi.mock('../../../../lib/utils/format-time', () => ({
  formatRelativeTime: () => '1m ago',
}));

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, className }: { children: ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
  },
}));

const { BatchMonitor } = await import('./index');
const { attentionPillLabel } = await import('./BatchDagCanvas/BatchMonitorStageNode');

const stage = (status: string, id = `s-${status}`) => ({
  id,
  status,
  run_count: 1,
  completed_count: status === 'completed' ? 1 : 0,
  failed_count: 0,
  active_count: 0,
  attention_count: 0,
  pending_count: 0,
  depends_on_stage_numbers: [] as number[],
  workstream_ids: [] as string[],
});

function renderMonitor(props: { isActiveBatch?: boolean; selectedStageId?: string } = {}) {
  render(
    <BatchMonitor
      flowId="flow-1"
      batchId="batch-1"
      isActiveBatch={props.isActiveBatch ?? false}
      isVisible
      selectedStageId={props.selectedStageId ?? null}
      onSelectStage={vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
  snap.stages = [];
  snap.batches = [];
});

describe('BatchMonitor', () => {
  it('falls back to a "not started yet" toolbar when the batch has no summary row', () => {
    renderMonitor();
    expect(screen.getByText('not started yet')).toBeInTheDocument();
    expect(screen.getByTestId('dag-canvas')).toBeInTheDocument();
  });

  it('marks the flow’s persisted run target with the Active chip', () => {
    renderMonitor({ isActiveBatch: true });
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('hides Edit plan when nothing is pending (dependency editing would be a no-op)', () => {
    snap.stages = [stage('completed', 's1'), stage('failed', 's2')];
    renderMonitor();
    expect(screen.queryByRole('button', { name: /Edit plan/ })).not.toBeInTheDocument();
  });

  it('offers Edit plan with pending stages and swaps to the editable plan canvas', async () => {
    const user = userEvent.setup();
    snap.stages = [stage('completed', 's1'), stage('pending', 's2')];
    renderMonitor();

    await user.click(screen.getByRole('button', { name: /Edit plan/ }));
    expect(screen.getByTestId('plan-canvas')).toBeInTheDocument();
    expect(screen.queryByTestId('dag-canvas')).not.toBeInTheDocument();
  });

  it('offers the load-template picker only for a batch with no stages yet', () => {
    renderMonitor();
    expect(screen.getByTestId('load-template')).toBeInTheDocument();
    expect(screen.queryByTestId('save-template')).not.toBeInTheDocument();
  });

  it('opens the stage panel on the editor glass, with no solid card of its own', () => {
    snap.stages = [stage('running', 's1')];
    renderMonitor({ selectedStageId: 's1' });
    const panel = screen.getByTestId('stage-detail').parentElement?.parentElement;
    expect(panel).toHaveClass('border-l');
    expect(panel).not.toHaveClass('bg-card');
  });
});

type MonitorStage = Parameters<typeof attentionPillLabel>[0];

function monitorStage(overrides: Partial<MonitorStage>): MonitorStage {
  return {
    id: 's1',
    stage_number: 1,
    name: 'Auth',
    status: 'running',
    failure_threshold: 0,
    depends_on_stage_ids: [],
    depends_on_stage_numbers: [],
    run_count: 2,
    completed_count: 0,
    failed_count: 0,
    active_count: 2,
    attention_count: 0,
    pending_count: 0,
    latest_chat_id: null,
    workstream_ids: [],
    ...overrides,
  };
}

describe('attentionPillLabel — members waiting on a human', () => {
  it('is empty while no member is waiting', () => {
    expect(attentionPillLabel(monitorStage({}))).toBeNull();
  });

  it('counts the waiting members while a sibling still runs', () => {
    expect(attentionPillLabel(monitorStage({ attention_count: 1, active_count: 2 }))).toBe(
      '1 needs input',
    );
  });

  it('reads blocked once every started member is waiting (pending members have not started)', () => {
    expect(
      attentionPillLabel(monitorStage({ attention_count: 2, active_count: 5, pending_count: 3 })),
    ).toBe('blocked · 2 need input');
  });
});
