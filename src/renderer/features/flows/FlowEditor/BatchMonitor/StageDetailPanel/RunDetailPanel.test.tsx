// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchStageDetail } from '../../../../../../shared/types/flows/flow-batch';
import type { BatchStageRunRow } from '../../../../../../shared/types/flow';

const trpcMocks = vi.hoisted(() => {
  const invalidate = vi.fn(() => Promise.resolve());
  const updateMutate = vi.fn();
  const updateOptionsRef: {
    onError?: (err: Error) => void;
    onSettled?: () => void;
  } = {};

  return { invalidate, updateMutate, updateOptionsRef };
});

vi.mock('../../../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      flows: {
        listBatchStageRuns: {
          invalidate: trpcMocks.invalidate,
        },
      },
    }),
    flows: {
      updateStageRun: {
        useMutation: (options?: { onError?: (err: Error) => void; onSettled?: () => void }) => {
          trpcMocks.updateOptionsRef.onError = options?.onError;
          trpcMocks.updateOptionsRef.onSettled = options?.onSettled;
          return {
            mutate: trpcMocks.updateMutate,
          };
        },
      },
      reassignStageRun: {
        useMutation: () => ({
          mutate: vi.fn(),
          isPending: false,
          isError: false,
          error: null,
        }),
      },
    },
  },
}));

vi.mock('./RunAttachmentsSection', () => ({
  RunAttachmentsSection: () => null,
}));

const { RunDetailPanel } = await import('./RunDetailPanel');

function makeRun(
  id: string,
  customInstructions: string,
  status: 'pending' | 'running' = 'pending',
  overrides: Partial<BatchStageRunRow> = {},
): BatchStageRunRow {
  return {
    id,
    status,
    stage_id: 'stage-1',
    trigger_context: { customInstructions, label: `Run ${id}` },
    ...overrides,
  } as unknown as BatchStageRunRow;
}

function renderRun(run: BatchStageRunRow) {
  return render(
    <RunDetailPanel
      flowId="flow-1"
      run={run}
      runIndex={0}
      stages={stages}
      currentStageId="stage-1"
      onBack={() => {}}
      onReassigned={() => {}}
    />,
  );
}

const stages: BatchStageDetail[] = [
  { id: 'stage-1', stage_number: 1, name: 'Stage 1', status: 'pending' } as BatchStageDetail,
  { id: 'stage-2', stage_number: 2, name: 'Stage 2', status: 'pending' } as BatchStageDetail,
];

describe('RunDetailPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    trpcMocks.updateMutate.mockReset();
    trpcMocks.invalidate.mockClear();
    trpcMocks.updateOptionsRef.onError = undefined;
    trpcMocks.updateOptionsRef.onSettled = undefined;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('offers only stages that can still dispatch as a move target', () => {
    const finished: BatchStageDetail = {
      ...stages[1],
      id: 'stage-3',
      stage_number: 3,
      name: 'Stage 3',
      status: 'completed',
    };
    render(
      <RunDetailPanel
        flowId="flow-1"
        run={makeRun('run-1', '')}
        runIndex={0}
        stages={[...stages, finished]}
        currentStageId="stage-1"
        onBack={() => {}}
        onReassigned={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Select a stage/ }));

    expect(screen.getByText('Stage 2')).toBeInTheDocument();
    expect(screen.queryByText('Stage 3')).not.toBeInTheDocument();
  });

  it('cancels pending autosave and resets save state when switching runs', () => {
    const { rerender } = render(
      <RunDetailPanel
        flowId="flow-1"
        run={makeRun('run-1', 'first')}
        runIndex={0}
        stages={stages}
        currentStageId="stage-1"
        onBack={() => {}}
        onReassigned={() => {}}
      />,
    );

    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: 'edited' } });

    act(() => {
      vi.advanceTimersByTime(400);
    });

    rerender(
      <RunDetailPanel
        flowId="flow-1"
        run={makeRun('run-2', 'second')}
        runIndex={1}
        stages={stages}
        currentStageId="stage-1"
        onBack={() => {}}
        onReassigned={() => {}}
      />,
    );

    expect(screen.getByRole('textbox')).toHaveValue('second');
    expect(screen.queryByText('Saving…')).not.toBeInTheDocument();
    expect(screen.queryByText('Failed to save')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(trpcMocks.updateMutate).not.toHaveBeenCalled();
  });

  it('clears stale saving indicator when selecting a different run', () => {
    const { rerender } = render(
      <RunDetailPanel
        flowId="flow-1"
        run={makeRun('run-1', 'first')}
        runIndex={0}
        stages={stages}
        currentStageId="stage-1"
        onBack={() => {}}
        onReassigned={() => {}}
      />,
    );

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'first x' } });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(trpcMocks.updateMutate).toHaveBeenCalledOnce();
    expect(screen.getByText('Saving…')).toBeInTheDocument();

    rerender(
      <RunDetailPanel
        flowId="flow-1"
        run={makeRun('run-2', 'second')}
        runIndex={1}
        stages={stages}
        currentStageId="stage-1"
        onBack={() => {}}
        onReassigned={() => {}}
      />,
    );

    expect(screen.queryByText('Saving…')).not.toBeInTheDocument();
    expect(screen.queryByText('Failed to save')).not.toBeInTheDocument();
  });

  it('renders a Branch section with each dependency branch and the merge note', () => {
    renderRun(
      makeRun('run-1', '', 'running', {
        trigger_context: {
          label: 'Run run-1',
          baseBranch: 'frink/b',
          baseBranches: ['frink/b', 'frink/a'],
          mergeStrategy: 'most-recent',
        },
      }),
    );

    expect(screen.getByText('Base Branches')).toBeInTheDocument();
    expect(screen.getByText('frink/b')).toBeInTheDocument();
    expect(screen.getByText('frink/a')).toBeInTheDocument();
    expect(screen.getByText('Merged automatically, most-recent first')).toBeInTheDocument();
    // Branch keys must not double-render as dynamic trigger context rows
    expect(screen.queryByText('Base Branch')).not.toBeInTheDocument();
    expect(screen.queryByText('Merge Strategy')).not.toBeInTheDocument();
  });

  it('renders a single Base Branch without a merge note', () => {
    renderRun(
      makeRun('run-1', '', 'running', {
        trigger_context: { label: 'Run run-1', baseBranch: 'frink/a', baseBranches: ['frink/a'] },
      }),
    );

    expect(screen.getByText('Base Branch')).toBeInTheDocument();
    expect(screen.getByText('frink/a')).toBeInTheDocument();
    expect(screen.queryByText('Merged automatically, most-recent first')).not.toBeInTheDocument();
  });

  it('shows the merge-conflict callout only while the start_task awaits input', () => {
    const conflictFields = {
      merge_conflict: true,
      conflicting_branch: 'frink/b',
      conflicted_files: ['src/x.ts'],
      merged_branches: ['frink/a'],
    };
    const { rerender } = renderRun(
      makeRun('run-1', '', 'running', { ...conflictFields, start_task_status: 'awaiting_input' }),
    );

    expect(screen.getByText('Merge conflict — run paused for input')).toBeInTheDocument();
    expect(screen.getByText('frink/b')).toBeInTheDocument();
    expect(screen.getByText('src/x.ts')).toBeInTheDocument();
    expect(screen.getByText('Merged before the conflict: frink/a')).toBeInTheDocument();
    // Header status must agree with the callout, not read the raw 'running' status
    expect(screen.getByText('merge conflict — needs input')).toBeInTheDocument();
    expect(screen.queryByText('running')).not.toBeInTheDocument();

    // Resumed run (start_task no longer awaiting input) — stale flag must not show
    rerender(
      <RunDetailPanel
        flowId="flow-1"
        run={makeRun('run-1', '', 'running', { ...conflictFields, start_task_status: 'completed' })}
        runIndex={0}
        stages={stages}
        currentStageId="stage-1"
        onBack={() => {}}
        onReassigned={() => {}}
      />,
    );
    expect(screen.queryByText('Merge conflict — run paused for input')).not.toBeInTheDocument();
  });
});
