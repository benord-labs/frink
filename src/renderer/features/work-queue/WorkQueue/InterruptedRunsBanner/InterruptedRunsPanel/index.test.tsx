// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BulkRecoverResult } from '../../../../../../shared/types/flow-run/resume';
import { type InterruptedRun, InterruptedRunsPanel, type RecoverItem } from './index';

const run = (taskId: string, over: Partial<InterruptedRun> = {}): InterruptedRun => ({
  taskId,
  flowRunId: `run-${taskId}`,
  projectId: 'p1',
  projectName: 'devkit',
  description: `Task ${taskId}`,
  recoveryKind: 'retry',
  confirmSideEffects: false,
  recoveryNodeRunId: `nr-${taskId}`,
  ...over,
});

/** A recovery the test settles by hand, so it can change the list while the batch is in flight. */
function deferredRecovery() {
  let settle: (results: BulkRecoverResult[] | null) => void = () => {};
  const onContinueAll = vi.fn(
    (_items: RecoverItem[]) =>
      new Promise<BulkRecoverResult[] | null>((resolve) => {
        settle = resolve;
      }),
  );
  return { onContinueAll, settle: (results: BulkRecoverResult[] | null) => settle(results) };
}

afterEach(cleanup);

const openDialog = (runs: InterruptedRun[], onContinueAll = deferredRecovery().onContinueAll) => {
  const view = render(<InterruptedRunsPanel runs={runs} onContinueAll={onContinueAll} />);
  fireEvent.click(screen.getByRole('button', { name: 'Continue all' }));
  return { ...view, dialog: screen.getByRole('alertdialog') };
};

describe('InterruptedRunsPanel', () => {
  it('renders nothing while no run is interrupted', () => {
    const { container } = render(
      <InterruptedRunsPanel runs={[]} onContinueAll={deferredRecovery().onContinueAll} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('counts the interrupted runs', () => {
    render(
      <InterruptedRunsPanel
        runs={[run('a'), run('b')]}
        onContinueAll={deferredRecovery().onContinueAll}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('2 Flow runs interrupted by a restart');
  });

  it('sends every run in order, but lists a started non-agent step for its own confirm', () => {
    const { onContinueAll } = deferredRecovery();
    const { dialog } = openDialog(
      [run('a', { recoveryKind: 'continue' }), run('cmd', { confirmSideEffects: true }), run('b')],
      onContinueAll,
    );

    expect(dialog).toHaveTextContent('1 continue in their session, 1 retry their step');
    const confirmList = within(dialog).getByRole('list', { name: 'Needs individual confirmation' });
    expect(confirmList).toHaveTextContent('Task cmd');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue 2 runs' }));
    expect(onContinueAll).toHaveBeenCalledWith([
      { taskId: 'a', kind: 'continue', recoveryNodeRunId: 'nr-a' },
      { taskId: 'b', kind: 'retry', recoveryNodeRunId: 'nr-b' },
    ]);
  });

  it('scopes the batch to one project', () => {
    const { onContinueAll } = deferredRecovery();
    const { dialog } = openDialog(
      [run('a'), run('b', { projectId: 'p2', projectName: 'frink' })],
      onContinueAll,
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'frink (1)' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue 1 run' }));
    expect(onContinueAll).toHaveBeenCalledWith([
      { taskId: 'b', kind: 'retry', recoveryNodeRunId: 'nr-b' },
    ]);
  });

  it("shows each run's outcome by name, even once the list refetches without them", async () => {
    const recovery = deferredRecovery();
    const runs = [run('a'), run('b'), run('c')];
    const { dialog, rerender } = openDialog(runs, recovery.onContinueAll);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue 3 runs' }));
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();

    // The recovered runs leave the list before the dialog reads their outcomes.
    rerender(<InterruptedRunsPanel runs={[]} onContinueAll={recovery.onContinueAll} />);
    await act(async () => {
      recovery.settle([
        { taskId: 'a', flowRunId: 'run-a', outcome: 'resumed' },
        { taskId: 'b', flowRunId: 'run-b', outcome: 'queued' },
        {
          taskId: 'c',
          flowRunId: 'run-c',
          outcome: 'refused',
          reason: "This run's chat was deleted",
        },
      ]);
    });

    const results = screen.getByRole('list', { name: 'Recovery results' });
    expect(results).toHaveTextContent('Task a — Resumed');
    expect(results).toHaveTextContent('Task b — Queued');
    expect(results).toHaveTextContent("Task c — Not recovered: This run's chat was deleted");
  });

  it('keeps the confirm open when the batch fails as a whole', async () => {
    const recovery = deferredRecovery();
    const { dialog } = openDialog([run('a')], recovery.onContinueAll);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue 1 run' }));
    await act(async () => recovery.settle(null));

    expect(screen.queryByRole('list', { name: 'Recovery results' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Continue 1 run' })).toBeEnabled();
  });
});
