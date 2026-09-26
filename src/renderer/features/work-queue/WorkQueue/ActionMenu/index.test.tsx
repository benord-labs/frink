// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentsSettingsDialogActiveTabAtom,
  agentsSettingsDialogOpenAtom,
} from '../../../../lib/atoms';
import type { Task } from '../../types';
import { ActionMenu } from './index';

vi.mock('./EmailTriggerContentDialog', () => ({
  EmailTriggerContentDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Original Email" /> : null,
}));

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
    onDismiss: vi.fn(),
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
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveClass('text-danger-fg');
    expect(screen.queryByRole('menuitem', { name: 'Reject' })).not.toBeInTheDocument();
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

  // A restart-`interrupted` run gets NO row Delete: a per-row delete of a derived-status flow run
  // can race a chat-resume and orphan it. It leaves Active by being resumed, or via deleting its chat.
  it('does not offer Delete for interrupted runs', () => {
    render(
      <ActionMenu
        {...createBaseProps()}
        task={createTask({ status: 'cancelled' })}
        status="interrupted"
      />,
    );
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

  it('confirms in-app before deleting review-plan tasks', async () => {
    const props = createReviewPlanProps();
    render(<ActionMenu {...props} />);

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(props.onDelete).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(props.onDelete).toHaveBeenCalledWith('task-1');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('does not delete review-plan task when confirmation is cancelled', async () => {
    const props = createReviewPlanProps();
    render(<ActionMenu {...props} />);

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it('deletes non-plan_ready tasks immediately without a confirmation dialog', () => {
    const props = createBaseProps();
    render(<ActionMenu {...props} />);

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    expect(props.onDelete).toHaveBeenCalledWith('task-1');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('keeps the review-plan task when the confirmation dialog is dismissed via Escape', async () => {
    const props = createReviewPlanProps();
    render(<ActionMenu {...props} />);

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await screen.findByRole('alertdialog');

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it('can confirm deletion on a second attempt after a prior cancel', async () => {
    const props = createReviewPlanProps();
    render(<ActionMenu {...props} />);

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Cancel',
      }),
    );

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Delete',
      }),
    );

    expect(props.onDelete).toHaveBeenCalledTimes(1);
    expect(props.onDelete).toHaveBeenCalledWith('task-1');
  });

  it.each([
    ['gmail', 'Original Email'],
    ['github', 'Original Trigger'],
  ] as const)('opens the %s original content in its domain dialog', (source, dialogName) => {
    const props = createBaseProps();
    props.task = createTask({ triggerContext: createTriggerContext(source) });
    render(<ActionMenu {...props} />);

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'View original content' }));

    expect(screen.getByRole('dialog', { name: dialogName })).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'Dismiss' }));
    expect(props.onDismiss).toHaveBeenCalledWith('task-1');
  });
});
