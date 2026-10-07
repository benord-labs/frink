// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentsSettingsDialogActiveTabAtom,
  agentsSettingsDialogOpenAtom,
} from '../../../../lib/atoms';
import type { Task } from '../../types';
import { ActionMenu } from './index';

vi.mock('./TriggerContentDialog', () => ({
  TriggerContentDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Original Trigger" /> : null,
}));

function createTriggerContext(source: 'gmail' | 'github') {
  return {
    source,
    sourceAccountId: 'account-1',
    sourceAccountName: source,
    triggerRuleId: 'rule-1',
    triggerRuleName: `${source} rule`,
    eventType: 'created',
    triggeredBy: {},
    timestamp: '2026-03-02T00:00:00.000Z',
    fullContent: {},
    autoStart: false,
  } as Task['triggerContext'];
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Task title',
    description: 'Task description',
    status: 'pending',
    source: 'manual',
    result: null,
    createdAt: '2026-03-02T00:00:00.000Z',
    ...overrides,
  };
}

function createBaseProps() {
  return {
    task: createTask(),
    status: 'pending' as const,
    chatId: null,
    isLoading: false,
    onStartExecution: vi.fn(),
    onCancel: vi.fn(),
    onDelete: vi.fn(),
    onOpenChat: vi.fn(),
    onStartTask: vi.fn(),
    onRetryTask: vi.fn(),
    onMarkComplete: vi.fn(),
  };
}

function createReviewPlanProps() {
  return {
    ...createBaseProps(),
    task: createTask({ status: 'plan_ready' }),
    status: 'plan_ready' as const,
    onStartTask: undefined,
  };
}

function openMenu(): void {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions for Task title' }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('WorkQueue ActionMenu', () => {
  it('renders a discoverable more-actions trigger', () => {
    render(<ActionMenu {...createBaseProps()} />);

    expect(screen.getByRole('button', { name: 'More actions for Task title' })).toBeInTheDocument();
  });

  it('opens and closes the menu from the trigger', () => {
    render(<ActionMenu {...createBaseProps()} />);

    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Start task' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menuitem', { name: 'Start task' })).not.toBeInTheDocument();
  });

  it('renders status-based menu actions', () => {
    const reviewProps = createReviewPlanProps();

    render(<ActionMenu {...reviewProps} />);
    openMenu();

    expect(screen.getByRole('menuitem', { name: 'Start execution' })).toHaveClass(
      'text-success-fg',
    );
    expect(screen.getByRole('menuitem', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Start task' })).not.toBeInTheDocument();
  });

  // One exit per state: Cancel while the task can still do something, Delete once nothing runs.
  it.each([
    ['running', 'Cancel'],
    ['needs_attention', 'Cancel'],
    ['interrupted', 'Cancel'],
    ['done', 'Delete'],
    ['failed', 'Delete'],
    ['completed', 'Delete'],
    ['cancelled', 'Delete'],
  ] as const)('%s offers %s as its only exit', (status, exit) => {
    render(
      <ActionMenu
        {...createBaseProps()}
        task={createTask({ status: status === 'interrupted' ? 'cancelled' : status })}
        status={status}
        onStartTask={undefined}
      />,
    );
    openMenu();
    expect(screen.getByRole('menuitem', { name: exit })).toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: exit === 'Cancel' ? 'Delete' : 'Cancel' }),
    ).not.toBeInTheDocument();
  });

  it('a never-started queued task offers Delete even without a start handler', () => {
    render(<ActionMenu {...createBaseProps()} onStartTask={undefined} />);
    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('a queued task with a chat offers Cancel instead of Delete', () => {
    render(
      <ActionMenu {...createBaseProps()} task={createTask({ result: { chatId: 'chat-1' } })} />,
    );
    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Start task' })).not.toBeInTheDocument();
  });

  it('shows delete for queued tasks and hides delete for running tasks', () => {
    const queuedProps = createBaseProps();
    const { unmount } = render(<ActionMenu {...queuedProps} />);

    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();

    unmount();

    const runningProps = {
      ...createBaseProps(),
      task: createTask({ status: 'running' }),
      status: 'running' as const,
      onStartTask: undefined,
    };
    render(<ActionMenu {...runningProps} />);
    openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it.each([
    ['continue', 'Continue task', 'Retry task'],
    ['retry', 'Retry task', 'Continue task'],
  ] as const)('offers one %s item for a stopped task', (recoveryKind, shown, hidden) => {
    const props = createBaseProps();
    render(
      <ActionMenu
        {...props}
        task={createTask({ status: 'failed', recoveryKind })}
        status="failed"
      />,
    );

    openMenu();
    expect(screen.queryByRole('menuitem', { name: hidden })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: shown }));
    expect(props.onRetryTask).toHaveBeenCalledWith('task-1');
  });

  it('offers the recovery of Flow-linked work too', () => {
    const props = createBaseProps();
    render(
      <ActionMenu
        {...props}
        task={createTask({
          status: 'failed',
          source: 'flow',
          flowRunId: 'run-1',
          recoveryKind: 'continue',
        })}
        status="failed"
      />,
    );

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Continue task' }));
    expect(props.onRetryTask).toHaveBeenCalledWith('task-1');
  });

  it.each([
    ['continue', 'Continue task'],
    ['retry', 'Retry task'],
  ] as const)('offers %s beside Cancel on a restart-interrupted run', (recoveryKind, shown) => {
    const props = createBaseProps();
    const task = createTask({ status: 'cancelled', flowRunId: 'run-1', recoveryKind });
    render(<ActionMenu {...props} task={task} status="interrupted" />);

    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Cancel' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: shown }));
    expect(props.onRetryTask).toHaveBeenCalledWith('task-1');
  });

  describe('Retry of a started non-agent step', () => {
    const renderSideEffectsRetry = () => {
      const props = createBaseProps();
      const task = createTask({
        status: 'cancelled',
        flowRunId: 'run-1',
        recoveryKind: 'retry',
        confirmSideEffects: true,
        recoveryNodeRunId: 'nr-1',
      });
      const view = render(<ActionMenu {...props} task={task} status="interrupted" />);
      openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Retry task' }));
      return { ...props, task, rerender: view.rerender };
    };

    it('asks to confirm before it sends anything', () => {
      const props = renderSideEffectsRetry();
      expect(screen.getByRole('alertdialog')).toHaveTextContent('may repeat its side effects');
      expect(props.onRetryTask).not.toHaveBeenCalled();
    });

    it('sends nothing when the confirm is cancelled', async () => {
      const props = renderSideEffectsRetry();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(props.onRetryTask).not.toHaveBeenCalled();
    });

    // The confirm names the exact recovery and step, so a row that moved meanwhile is refused.
    it('retries once confirmed, as the Retry of the step that was confirmed', async () => {
      const props = renderSideEffectsRetry();
      fireEvent.click(screen.getByRole('button', { name: 'Retry anyway' }));
      await waitFor(() =>
        expect(props.onRetryTask).toHaveBeenCalledWith('task-1', {
          kind: 'retry',
          recoveryNodeRunId: 'nr-1',
        }),
      );
    });

    it("discards an open confirm when a refetch changes the row's recovery", async () => {
      const { rerender, task, ...props } = renderSideEffectsRetry();
      rerender(
        <ActionMenu {...props} task={{ ...task, recoveryKind: 'continue' }} status="interrupted" />,
      );
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(props.onRetryTask).not.toHaveBeenCalled();
    });

    // Same status and kind, but another run, chat, or attempt (another window retried meanwhile).
    it.each([
      ['rebound to another run', { flowRunId: 'run-2' }, {}],
      ['rebound to another chat', {}, { chatId: 'chat-2' }],
      ['retried elsewhere, stopped again', { recoveryNodeRunId: 'nr-2' }, {}],
    ])('discards an open confirm when the row is %s', async (_, taskChange, propChange) => {
      const { rerender, task, ...props } = renderSideEffectsRetry();
      rerender(
        <ActionMenu
          {...props}
          {...propChange}
          task={{ ...task, ...taskChange }}
          status="interrupted"
        />,
      );
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(props.onRetryTask).not.toHaveBeenCalled();
    });
  });

  it('offers only Cancel on an interrupted run the server gave no recovery', () => {
    const task = createTask({ status: 'cancelled', flowRunId: 'run-1' });
    render(<ActionMenu {...createBaseProps()} task={task} status="interrupted" />);

    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /task$/ })).not.toBeInTheDocument();
  });

  it('offers no recovery when the server sent none (a run still in flight)', () => {
    render(
      <ActionMenu
        {...createBaseProps()}
        task={createTask({ status: 'failed', source: 'flow', flowRunId: 'run-1' })}
        status="failed"
      />,
    );

    openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Retry task' })).not.toBeInTheDocument();
  });

  it('deletes without a confirmation dialog', () => {
    const props = createBaseProps();
    render(<ActionMenu {...props} />);

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    expect(props.onDelete).toHaveBeenCalledWith('task-1');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('opens the original content in the trigger dialog', () => {
    const props = createBaseProps();
    props.task = createTask({ triggerContext: createTriggerContext('github') });
    render(<ActionMenu {...props} />);

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'View original content' }));

    expect(screen.getByRole('dialog', { name: 'Original Trigger' })).toBeInTheDocument();
  });

  it('opens Models settings for an account-auth failure', () => {
    const store = createStore();
    const props = createBaseProps();
    props.task = createTask({
      status: 'failed',
      result: { errorAction: 'open-connect-account' },
    });
    render(
      <Provider store={store}>
        <ActionMenu {...props} status="failed" />
      </Provider>,
    );

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Connect account' }));

    expect(store.get(agentsSettingsDialogActiveTabAtom)).toBe('models');
    expect(store.get(agentsSettingsDialogOpenAtom)).toBe(true);
  });

  it('starts queued task in execute mode from Start task', () => {
    const props = createBaseProps();
    render(<ActionMenu {...props} />);

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start task' }));

    expect(props.onStartTask).toHaveBeenCalledWith('task-1', 'agent');
  });

  it('starts queued task in plan mode from secondary action', () => {
    const props = createBaseProps();
    render(<ActionMenu {...props} />);

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start in plan mode' }));

    expect(props.onStartTask).toHaveBeenCalledWith('task-1', 'plan');
  });

  it('disables start actions while creating chat', () => {
    const props = { ...createBaseProps(), isLoading: true };
    render(<ActionMenu {...props} />);

    openMenu();

    expect(screen.getByRole('menuitem', { name: 'Start task' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('menuitem', { name: 'Start in plan mode' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('shows needs-attention actions and wires callbacks', () => {
    const props = {
      ...createBaseProps(),
      task: createTask({ status: 'needs_attention' }),
      status: 'needs_attention' as const,
      onStartTask: undefined,
    };
    render(<ActionMenu {...props} />);

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark complete' }));
    expect(props.onMarkComplete).toHaveBeenCalledWith('task-1');

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel' }));
    expect(props.onCancel).toHaveBeenCalledWith('task-1');
  });
});
