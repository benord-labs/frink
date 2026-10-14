// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type {
  ApprovalActions,
  AwaitingApproval,
} from '../../../../../lib/work-queue/approvals/use-work-queue-approvals';
import type { Task } from '../../../types';
import { makeTaskActions } from '../../test-fixtures';
import { AttentionCarousel } from '..';

function makeGate(overrides: Partial<AwaitingApproval> = {}): AwaitingApproval {
  return {
    flowRunId: 'run-1',
    flowId: 'flow-1',
    flowName: 'Release train',
    projectName: 'frink-oss',
    gateCount: 1,
    nodeRunId: 'gate-1',
    message: 'Deploy the release branch to staging?',
    waitingSince: new Date(2026, 9, 14, 14, 41),
    ...overrides,
  };
}

function makeActions(pending: ApprovalActions['pending'] = new Map()): ApprovalActions {
  return { approve: vi.fn(), cancel: vi.fn(), openRun: vi.fn(), pending };
}

const task: Task = {
  id: 'task-1',
  title: 'Add Stripe webhook handler',
  description: null,
  status: 'plan_ready',
  source: 'slack',
  result: { chatId: 'chat-1' },
  createdAt: '2026-08-11T12:00:00.000Z',
};

function renderCarousel(
  gates: AwaitingApproval[],
  options: { actions?: ApprovalActions; selectedId?: string; tasks?: Task[] } = {},
) {
  const actions = options.actions ?? makeActions();
  const onSelectTask = vi.fn();
  const spotlightActionRef = createRef<HTMLButtonElement>();
  const { unmount } = render(
    <AttentionCarousel
      approvals={{ gates, actions }}
      tasks={options.tasks ?? []}
      onOpenTask={vi.fn()}
      onSelectTask={onSelectTask}
      selectedTaskId={options.selectedId ?? gates[0]?.flowRunId ?? ''}
      spotlightActionRef={spotlightActionRef}
      taskActions={makeTaskActions()}
    />,
  );
  return { actions, onSelectTask, spotlightActionRef, unmount };
}

describe('AttentionCarousel approvals', () => {
  it("asks with the gate's own message and answers through the run's actions", () => {
    const gate = makeGate();
    const { actions, spotlightActionRef } = renderCarousel([gate]);

    expect(screen.getByText('Waiting for your approval')).toBeInTheDocument();
    expect(screen.getByText('Deploy the release branch to staging?')).toBeInTheDocument();
    const metadata = screen.getByText(/Waiting since/);
    expect(metadata).toHaveTextContent(/^Release train · frink-oss · Waiting since /);
    expect(metadata).not.toHaveClass('hidden');
    expect(screen.queryByRole('button', { name: /More actions/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open run of Release train' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run of Release train' }));
    expect(actions.approve).toHaveBeenCalledWith(gate);
    expect(actions.openRun).toHaveBeenCalledWith(gate);
    expect(actions.cancel).toHaveBeenCalledWith(gate);
    expect(spotlightActionRef.current).toBe(
      screen.getByRole('button', { name: 'Open run of Release train' }),
    );
  });

  it('names the Flow when the gate has no message and holds only the run being answered', () => {
    const answering = makeGate({ message: null });
    const other = makeGate({ flowRunId: 'run-2', nodeRunId: 'gate-2', flowName: 'Nightly' });
    const actions = makeActions(new Map([['run-1', 'approve']]));
    const { unmount } = renderCarousel([answering, other], { actions });

    expect(screen.getByText('Release train')).toBeInTheDocument();
    expect(screen.getByText(/Waiting since/)).toHaveTextContent(/^frink-oss · Waiting since /);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel run of Release train' })).toBeDisabled();

    unmount();
    renderCarousel([answering, other], { actions, selectedId: 'run-2' });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('answers a run with several waiting gates from the run itself', () => {
    renderCarousel([makeGate({ gateCount: 2, nodeRunId: null, message: null })]);

    expect(screen.getByText('2 approvals waiting')).toBeInTheDocument();
    expect(screen.getByText(/Waiting since/)).toHaveTextContent(/^Release train · frink-oss/);
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open run of Release train' })).toBeInTheDocument();
  });

  it('pages through approvals before tasks', () => {
    const { onSelectTask, unmount } = renderCarousel([makeGate()], { tasks: [task] });

    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show next task needing attention' }));
    expect(onSelectTask).toHaveBeenCalledWith('task-1');

    unmount();
    renderCarousel([makeGate()], { tasks: [task], selectedId: 'task-1' });
    expect(screen.getByText('Add Stripe webhook handler')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review' })).toBeInTheDocument();
  });
});
