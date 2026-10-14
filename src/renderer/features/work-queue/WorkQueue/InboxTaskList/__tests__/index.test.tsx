// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import type { Task } from '../../../types';
import { makeTaskActions } from '../../test-fixtures';
import { InboxTaskList } from '..';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Triage customer report',
    description: 'Waiting for pickup',
    status: 'pending',
    source: 'gmail',
    result: null,
    createdAt: '2026-08-11T11:50:00.000Z',
    projectName: 'frink-web',
    triggerContext: {
      source: 'gmail',
      sourceAccountId: 'gmail-account',
      eventType: 'email_received',
      triggeredBy: {},
      timestamp: '2026-08-11T11:50:00.000Z',
      fullContent: { subject: 'Triage customer report', snippet: 'Waiting for pickup' },
      autoStart: false,
      _config: { startMode: 'wait' },
    },
    ...overrides,
  };
}

describe('InboxTaskList', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays hidden when nothing is waiting for pickup', () => {
    const { container } = render(
      <InboxTaskList
        tasks={[]}
        isLoading={false}
        taskActions={makeTaskActions()}
        onOpenTask={vi.fn()}
        onStartTask={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders a neutral row and starts an unlinked task through the existing action', () => {
    const onStartTask = vi.fn();
    const task = makeTask();
    const taskActions = makeTaskActions();
    const view = render(
      <InboxTaskList
        tasks={[task]}
        isLoading={false}
        taskActions={taskActions}
        onOpenTask={vi.fn()}
        onStartTask={onStartTask}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Inbox, ready to start' })).toBeInTheDocument();
    expect(view.container.querySelector('[data-state="neutral"]')).toBeInTheDocument();
    const taskRow = screen.getByText('Triage customer report').closest('li');
    expect(taskRow).not.toBeNull();
    const row = within(taskRow as HTMLElement);
    const startButton = row.getByRole('button', { name: 'Start task' });
    expect(row.getAllByRole('button')).toHaveLength(2);
    expect(startButton.closest('.activity-row-actions')).toBeInTheDocument();
    expect(row.getByText('frink-web').closest('.activity-row-meta')).toBeInTheDocument();
    expect(row.getByText('Triage customer report').previousElementSibling).not.toHaveClass(
      'motion-safe:animate-pulse',
    );
    fireEvent.click(startButton);

    expect(onStartTask).toHaveBeenCalledWith('task-1', 'agent');
    expect(taskRow?.querySelector('button button')).not.toBeInTheDocument();
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'More actions for Triage customer report' }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start in plan mode' }));
    expect(taskActions.onStartTask).toHaveBeenCalledWith('task-1', 'plan');

    view.rerender(
      <InboxTaskList
        tasks={[task]}
        isLoading
        taskActions={makeTaskActions()}
        onOpenTask={vi.fn()}
        onStartTask={onStartTask}
      />,
    );
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
  });

  it('opens a flow-linked wait task instead of creating a duplicate chat', () => {
    const onOpenTask = vi.fn();
    const task = makeTask({ linkedChatId: 'chat-1' });
    render(
      <InboxTaskList
        tasks={[task]}
        isLoading={false}
        taskActions={makeTaskActions()}
        onOpenTask={onOpenTask}
        onStartTask={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));

    expect(onOpenTask).toHaveBeenCalledWith(task);
    expect(screen.queryByRole('button', { name: 'Start task' })).not.toBeInTheDocument();
  });

  it('expands and collapses every waiting task loaded into the overview', () => {
    const onStartTask = vi.fn();
    const tasks = Array.from({ length: 7 }, (_, index) =>
      makeTask({
        id: `task-${index + 1}`,
        title: `Waiting task ${index + 1}`,
        triggerContext: null,
      }),
    );
    render(
      <InboxTaskList
        tasks={tasks}
        isLoading={false}
        taskActions={makeTaskActions()}
        onOpenTask={vi.fn()}
        onStartTask={onStartTask}
      />,
    );

    expect(screen.getByText('Waiting task 6')).toBeInTheDocument();
    expect(screen.queryByText('Waiting task 7')).not.toBeInTheDocument();
    const expand = screen.getByRole('button', { name: 'Show 1 more Inbox task' });
    expect(expand).toHaveTextContent('Show 1 more');
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(expand.getAttribute('aria-controls') ?? '')).toHaveAttribute(
      'aria-label',
      'Tasks ready to start',
    );

    fireEvent.click(expand);
    const seventhRow = screen.getByText('Waiting task 7').closest('li');
    expect(seventhRow).not.toBeNull();
    fireEvent.click(within(seventhRow as HTMLElement).getByRole('button', { name: 'Start task' }));
    expect(onStartTask).toHaveBeenCalledWith('task-7', 'agent');

    const collapse = screen.getByRole('button', { name: 'Show fewer Inbox tasks' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(collapse);
    expect(screen.queryByText('Waiting task 7')).not.toBeInTheDocument();
  });
});

const START_INPUT = z.object({ taskId: z.string() });
const startWaiting = vi.fn<(input: z.infer<typeof START_INPUT>) => Promise<{ id: string }>>();

async function answerStart(op: Operation): Promise<{ id: string }> {
  if (op.path !== 'tasks.startWaiting') throw new Error(`Unexpected test operation: ${op.path}`);
  return startWaiting(START_INPUT.parse(op.input));
}

describe('InboxTaskList for a waiting Flow step', () => {
  // Starting the only waiting step empties the Inbox, so its row unmounts before the start returns.
  it('starts the step in its own chat, then opens that chat even after its row is gone', async () => {
    let finishStart = (_task: { id: string }) => {};
    startWaiting.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStart = resolve;
        }),
    );
    const onOpenTask = vi.fn();
    const onStartTask = vi.fn();
    const task = makeTask({
      flowRunId: 'run-1',
      result: { chatId: 'chat-1', subChatId: 'sub-1' },
    });
    const list = (tasks: Task[]) => (
      <InboxTaskList
        tasks={tasks}
        isLoading={false}
        taskActions={makeTaskActions()}
        onOpenTask={onOpenTask}
        onStartTask={onStartTask}
      />
    );
    const view = renderWithTrpc(list([task]), answerStart);

    expect(screen.queryByRole('button', { name: 'Open chat' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => expect(startWaiting).toHaveBeenCalledExactlyOnceWith({ taskId: 'task-1' }));
    view.rerender(list([]));
    expect(screen.queryByRole('button', { name: 'Start task' })).toBeNull();

    finishStart({ id: 'task-1' });
    await waitFor(() => expect(onOpenTask).toHaveBeenCalledExactlyOnceWith(task));
    expect(onStartTask).not.toHaveBeenCalled();
  });
});
