// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

  it('does not offer task-level Carry on for Flow-linked work', () => {
    render(
      <ActionMenu
        {...createBaseProps()}
        task={createTask({ status: 'failed', source: 'flow', flowRunId: 'run-1' })}
        status="failed"
      />,
    );

    openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Carry on task' })).not.toBeInTheDocument();
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
