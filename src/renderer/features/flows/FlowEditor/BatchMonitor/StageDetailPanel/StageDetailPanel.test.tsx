// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BatchStageDetail } from '../../../../../../shared/types/flows/flow-batch';
import type { BatchStageRunRow } from '../../../../../../shared/types/flow';

vi.mock('./RunDetailPanel', () => ({
  RunDetailPanel: ({ run }: { run: BatchStageRunRow }) => (
    <div data-testid="run-detail-panel">{run.id}</div>
  ),
}));

vi.mock('./StageRunList', () => ({
  StageRunList: ({
    onRunSelect,
    stageId,
  }: {
    onRunSelect: (r: BatchStageRunRow, i: number) => void;
    stageId: string;
  }) => (
    <button
      type="button"
      onClick={() =>
        onRunSelect(
          {
            id: `run-for-${stageId}`,
            stage_id: stageId,
            status: 'pending',
          } as BatchStageRunRow,
          0,
        )
      }
    >
      Open run
    </button>
  ),
}));

const { StageDetailPanel } = await import('./index');

function makeStage(
  id: string,
  stageNumber: number,
  name: string,
  overrides?: Partial<BatchStageDetail>,
): BatchStageDetail {
  return {
    id,
    stage_number: stageNumber,
    name,
    status: 'pending',
    run_count: 0,
    completed_count: 0,
    ...overrides,
  } as BatchStageDetail;
}

describe('StageDetailPanel', () => {
  afterEach(() => {
    cleanup();
  });

  it('clears run drill-in when the selected stage changes (monitor DAG switch)', async () => {
    const stageA = makeStage('stage-a', 1, 'Stage A');
    const stageB = makeStage('stage-b', 2, 'Stage B');
    const stages: BatchStageDetail[] = [stageA, stageB];

    const { rerender } = render(
      <StageDetailPanel
        flowId="flow-1"
        batchId="batch-1"
        stage={stageA}
        stages={stages}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open run' }));

    await waitFor(() => {
      expect(screen.getByTestId('run-detail-panel')).toHaveTextContent('run-for-stage-a');
    });

    rerender(
      <StageDetailPanel
        flowId="flow-1"
        batchId="batch-1"
        stage={stageB}
        stages={stages}
        onClose={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByTestId('run-detail-panel')).not.toBeInTheDocument();
    });

    expect(screen.getByText('Runs')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Stage B' })).toBeInTheDocument();
  });

  it('clears run drill-in when batchId changes', async () => {
    const stage = makeStage('stage-a', 1, 'Stage A');
    const stages: BatchStageDetail[] = [stage];

    const { rerender } = render(
      <StageDetailPanel
        flowId="flow-1"
        batchId="batch-1"
        stage={stage}
        stages={stages}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open run' }));

    await waitFor(() => {
      expect(screen.getByTestId('run-detail-panel')).toBeInTheDocument();
    });

    rerender(
      <StageDetailPanel
        flowId="flow-1"
        batchId="batch-2"
        stage={stage}
        stages={stages}
        onClose={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByTestId('run-detail-panel')).not.toBeInTheDocument();
    });
  });

  it('keeps run drill-in when the same stage id is refreshed (progress/status from socket refetch)', async () => {
    const stageBefore = makeStage('stage-a', 1, 'Stage A', {
      run_count: 10,
      completed_count: 3,
      status: 'running',
    });
    const stageAfter = makeStage('stage-a', 1, 'Stage A', {
      run_count: 10,
      completed_count: 7,
      status: 'running',
    });
    const stagesBefore: BatchStageDetail[] = [stageBefore];
    const stagesAfter: BatchStageDetail[] = [stageAfter];

    const { rerender } = render(
      <StageDetailPanel
        flowId="flow-1"
        batchId="batch-1"
        stage={stageBefore}
        stages={stagesBefore}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open run' }));

    await waitFor(() => {
      expect(screen.getByTestId('run-detail-panel')).toHaveTextContent('run-for-stage-a');
    });

    rerender(
      <StageDetailPanel
        flowId="flow-1"
        batchId="batch-1"
        stage={stageAfter}
        stages={stagesAfter}
        onClose={() => {}}
      />,
    );

    expect(screen.getByTestId('run-detail-panel')).toHaveTextContent('run-for-stage-a');
  });

  it('slides a run in over the panel glass, with no solid card of its own', async () => {
    const stage = makeStage('stage-a', 1, 'Stage A');
    render(
      <StageDetailPanel
        flowId="flow-1"
        batchId="batch-1"
        stage={stage}
        stages={[stage]}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open run' }));
    const run = await screen.findByTestId('run-detail-panel');
    expect(run.parentElement).toHaveClass('absolute', 'inset-0');
    expect(run.parentElement).not.toHaveClass('bg-card');
  });
});
