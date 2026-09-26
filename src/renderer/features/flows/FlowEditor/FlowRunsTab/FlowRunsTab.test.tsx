// @vitest-environment happy-dom
/**
 * FlowRunsTab pane routing: newest run auto-selected when no batch (pane never empty),
 * batch monitor when a batch is selected, run selection overriding it with a
 * back-to-batch path, and the batch-vocabulary-free empty state.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const snap = vi.hoisted(() => ({
  runs: [] as Array<{ id: string }>,
}));

vi.mock('../../../../lib/trpc', () => ({
  trpc: {
    flows: {
      listRuns: { useQuery: () => ({ data: snap.runs }) },
    },
  },
}));

vi.mock('../FlowRunHistoryPanel', () => ({
  FlowRunHistoryPanel: ({
    onSelectRun,
    onSelectBatch,
  }: {
    onSelectRun: (id: string) => void;
    onSelectBatch: (id: string) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onSelectRun('r-2')}>
        rail-select-run
      </button>
      <button type="button" onClick={() => onSelectBatch('b-1')}>
        rail-select-batch
      </button>
    </div>
  ),
  RunDetailPane: ({ runId, onBack }: { runId: string; onBack?: () => void }) => (
    <div data-testid="run-detail" data-run-id={runId}>
      {onBack && (
        <button type="button" onClick={onBack}>
          pane-back
        </button>
      )}
    </div>
  ),
}));

vi.mock('../BatchMonitor', () => ({
  BatchMonitor: ({ batchId }: { batchId: string }) => (
    <div data-testid="batch-monitor" data-batch-id={batchId} />
  ),
}));

const { FlowRunsTab } = await import('./index');

function renderTab(props: { selectedBatchId?: string | null } = {}) {
  const onSelectBatch = vi.fn();
  render(
    <FlowRunsTab
      flowId="flow-1"
      isVisible
      selectedBatchId={props.selectedBatchId ?? null}
      activeBatchId={props.selectedBatchId ?? null}
      onSelectBatch={onSelectBatch}
      selectedStageId={null}
      onSelectStage={vi.fn()}
      onViewRunOnCanvas={vi.fn()}
      onRequestEditorTab={vi.fn()}
      railShellClassName="shell"
    />,
  );
  return { onSelectBatch };
}

afterEach(() => {
  cleanup();
  snap.runs = [];
});

describe('FlowRunsTab', () => {
  it('auto-selects the newest run when no batch exists — the pane is never empty', () => {
    snap.runs = [{ id: 'r-newest' }, { id: 'r-old' }];
    renderTab();
    expect(screen.getByTestId('run-detail')).toHaveAttribute('data-run-id', 'r-newest');
  });

  it('shows the batch monitor for the selected batch by default', () => {
    snap.runs = [{ id: 'r-1' }];
    renderTab({ selectedBatchId: 'b-1' });
    expect(screen.getByTestId('batch-monitor')).toHaveAttribute('data-batch-id', 'b-1');
    expect(screen.queryByTestId('run-detail')).not.toBeInTheDocument();
  });

  it('run selection overrides the batch view; Back returns to the batch', async () => {
    const user = userEvent.setup();
    snap.runs = [{ id: 'r-2' }];
    renderTab({ selectedBatchId: 'b-1' });

    await user.click(screen.getByRole('button', { name: 'rail-select-run' }));
    expect(screen.getByTestId('run-detail')).toHaveAttribute('data-run-id', 'r-2');

    await user.click(screen.getByRole('button', { name: 'pane-back' }));
    expect(screen.getByTestId('batch-monitor')).toBeInTheDocument();
  });

  it('selecting a batch from the rail clears the run selection', async () => {
    const user = userEvent.setup();
    snap.runs = [{ id: 'r-2' }];
    const { onSelectBatch } = renderTab({ selectedBatchId: 'b-1' });

    await user.click(screen.getByRole('button', { name: 'rail-select-run' }));
    await user.click(screen.getByRole('button', { name: 'rail-select-batch' }));
    expect(onSelectBatch).toHaveBeenCalledWith('b-1');
    expect(screen.getByTestId('batch-monitor')).toBeInTheDocument();
  });

  it('empty state never mentions batches (progressive disclosure)', () => {
    renderTab();
    const title = screen.getByText('No runs yet.');
    const emptyStateCopy = title.parentElement?.textContent ?? '';
    expect(emptyStateCopy).not.toMatch(/batch/i);
    expect(emptyStateCopy).toContain('Press Run to execute this flow');
  });
});
