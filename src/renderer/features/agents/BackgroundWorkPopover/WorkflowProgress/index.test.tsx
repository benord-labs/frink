// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowProgressView } from '../../../../../shared/types/wake-hold/workflow-progress';
import { WorkflowProgress } from './index';

let progress: WorkflowProgressView | null = null;
const useQuery = vi.fn((_input: unknown, _opts: unknown) => ({ data: progress }));
vi.mock('../../../../lib/trpc', () => ({
  trpc: {
    socket: { getWorkflowProgress: { useQuery: (i: unknown, o: unknown) => useQuery(i, o) } },
  },
}));

const NOW = 1_790_000_000_000;

describe('WorkflowProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    useQuery.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('polls this workflow while mounted', () => {
    progress = null;
    render(<WorkflowProgress subChatId="sc1" taskId="w1" />);

    expect(useQuery).toHaveBeenCalledWith(
      { subChatId: 'sc1', taskId: 'w1' },
      expect.objectContaining({ refetchInterval: 2000 }),
    );
  });

  it('shows each phase with its agents, their state and how long they have taken', () => {
    progress = {
      phases: [
        { index: 1, title: 'Implement' },
        { index: 2, title: 'Verify' },
      ],
      agents: [
        { index: 1, label: 'impl:PR2', phaseIndex: 1, state: 'done', durationMs: 1_065_000 },
        {
          index: 2,
          label: 'impl:PR3',
          phaseIndex: 1,
          state: 'running',
          startedAt: NOW - 45_000,
          activity: 'Bash · bun test',
        },
        { index: 3, label: 'verify:PR2', phaseIndex: 2, state: 'error', error: 'stalled' },
        { index: 4, label: 'verify:PR3', phaseIndex: 2, state: 'queued' },
      ],
    };
    render(<WorkflowProgress subChatId="sc1" taskId="w1" />);

    expect(screen.getByText('Implement')).toBeInTheDocument();
    expect(screen.getByText('1/2')).toBeInTheDocument();
    expect(screen.getByText('0/2')).toBeInTheDocument();
    expect(screen.getByText('17m 45s')).toBeInTheDocument();
    expect(screen.getByText('45s')).toBeInTheDocument();
    expect(screen.getByText('Bash · bun test')).toBeInTheDocument();
    expect(screen.getByText('stalled')).toBeInTheDocument();
    expect(screen.getByLabelText('Done')).toBeInTheDocument();
    expect(screen.getByLabelText('Running')).toBeInTheDocument();
    expect(screen.getByLabelText('Failed')).toBeInTheDocument();
    expect(screen.getByLabelText('Queued')).toBeInTheDocument();

    // The running agent's clock ticks without waiting for the next snapshot.
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByText('47s')).toBeInTheDocument();
  });

  it('shows a phase no agent has reached yet as up next', () => {
    progress = {
      phases: [
        { index: 1, title: 'Alpha' },
        { index: 2, title: 'Beta' },
      ],
      agents: [{ index: 1, label: 'a1', phaseIndex: 1, state: 'running', startedAt: NOW }],
    };
    render(<WorkflowProgress subChatId="sc1" taskId="w1" />);

    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('Up next')).toBeInTheDocument();
  });

  it('lists agents with no known phase after the phased ones', () => {
    progress = {
      phases: [],
      agents: [{ index: 1, label: 'solo', state: 'done', durationMs: 3_000 }],
    };
    render(<WorkflowProgress subChatId="sc1" taskId="w1" />);

    expect(screen.getByText('solo')).toBeInTheDocument();
    expect(screen.getByText('3s')).toBeInTheDocument();
  });

  it('renders nothing until a snapshot arrives', () => {
    progress = null;
    const { container } = render(<WorkflowProgress subChatId="sc1" taskId="w1" />);

    expect(container).toBeEmptyDOMElement();
  });
});
