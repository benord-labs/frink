// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../types';
import { getAttentionCopy } from '../../AttentionCarousel';
import { makeTaskActions } from '../../test-fixtures';
import { QueueOverview } from '..';
import { OtherAttentionTasks } from '../OtherAttentionTasks';

/** QueueOverview renders the live queued panel by default; these tests only need its slot filled. */
const queuedAdmissionsStub = <section aria-label="Queued to run">Queued flows</section>;

const { toastError } = vi.hoisted(() => {
  Reflect.set(globalThis, 'electronTRPC', { onMessage: vi.fn(), sendMessage: vi.fn() });
  return { toastError: vi.fn() };
});
vi.mock('sonner', () => ({ toast: { error: toastError } }));
vi.mock('../../QueuePausedBanner', () => ({ QueuePausedBanner: () => null }));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-running',
    title: 'Fix flaky auth test',
    description: 'From CI',
    status: 'running',
    source: 'github',
    result: { chatId: 'chat-running' },
    createdAt: '2026-08-11T11:50:00.000Z',
    ...overrides,
  };
}

describe('QueueOverview', () => {
  it('puts the closed attention backlog after Running and resets it after selection', async () => {
    const taskActions = makeTaskActions();
    const reviewTask = makeTask({
      id: 'task-review',
      title: 'Review this plan',
      status: 'plan_ready',
      result: { chatId: 'chat-review' },
    });
    const questionTask = makeTask({
      id: 'task-question',
      title: 'Choose a deployment region',
      status: 'needs_attention',
      result: {
        chatId: 'chat-question',
        agentSignal: { state: 'awaiting_input', summary: 'Choose a region.' },
      },
    });
    render(
      <QueueOverview
        queuedAdmissions={queuedAdmissionsStub}
        attentionTasks={[reviewTask, questionTask]}
        runningTasks={[makeTask()]}
        waitingTasks={[
          makeTask({
            id: 'task-waiting',
            title: 'Ready for pickup',
            status: 'pending',
            result: null,
          }),
        ]}
        queuedCount={1}
        reviewCount={2}
        runningCount={1}
        taskActions={taskActions}
      />,
    );

    const progress = screen.getByRole('group', { name: 'Work queue by state' });
    const attention = screen.getByRole('region', { name: 'Tasks needing your attention' });
    const running = screen.getByRole('region', { name: 'Running now, across your projects' });
    const otherSummary = screen.getByRole('button', { name: 'Other tasks needing attention 1' });
    const other = otherSummary.closest('details');
    const queued = screen.getByRole('region', { name: 'Queued to run' });
    const inbox = screen.getByRole('region', { name: 'Inbox, ready to start' });

    expect(progress.compareDocumentPosition(attention)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(attention.compareDocumentPosition(running)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(running.compareDocumentPosition(otherSummary)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(otherSummary.compareDocumentPosition(queued)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(queued.compareDocumentPosition(inbox)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(other?.open).toBe(false);

    fireEvent.click(otherSummary);
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'More actions for Choose a deployment region' }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'View chat' }));
    expect(taskActions.onOpenChat).toHaveBeenCalledWith(questionTask, 'chat-question');
    expect(screen.getByRole('button', { name: 'Review' })).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Choose a deployment region, needs input, show in spotlight',
      }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Answer' })).toHaveFocus());
    expect(
      screen.getByRole('button', { name: 'Other tasks needing attention 1' }).closest('details')
        ?.open,
    ).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Other tasks needing attention 1' }));
    const nextTask = screen.getByRole('button', { name: 'Show next task needing attention' });
    nextTask.focus();
    fireEvent.click(nextTask);
    expect(nextTask).toHaveFocus();
    expect(
      screen.getByRole('button', { name: 'Other tasks needing attention 1' }).closest('details')
        ?.open,
    ).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    expect(taskActions.onStartTask).toHaveBeenCalledWith('task-waiting', 'agent');
  });

  it('opens a running task through the shared Work Queue chat handler', () => {
    const onOpenChat = vi.fn();
    const taskActions = makeTaskActions({ onOpenChat });
    const task = makeTask();
    render(
      <QueueOverview
        queuedAdmissions={queuedAdmissionsStub}
        attentionTasks={[]}
        runningTasks={[task]}
        waitingTasks={[]}
        queuedCount={0}
        reviewCount={0}
        runningCount={1}
        taskActions={taskActions}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Fix flaky auth test, running' }));
    expect(onOpenChat).toHaveBeenCalledWith(task, 'chat-running');
  });

  it('only advertises unloaded attention work when another page exists', () => {
    const tasks = [
      makeTask({ id: 'first', status: 'plan_ready' }),
      makeTask({ id: 'second', status: 'plan_ready' }),
    ];
    const props = {
      getPresentation: getAttentionCopy,
      onPromoteTask: vi.fn(),
      selectedTaskId: tasks[0].id,
      taskActions: makeTaskActions(),
      tasks,
      totalCount: 11,
    };
    const { rerender } = render(<OtherAttentionTasks {...props} canLoadMore={false} />);

    expect(
      screen.getByRole('button', { name: 'Other tasks needing attention 1' }),
    ).toBeInTheDocument();

    rerender(<OtherAttentionTasks {...props} canLoadMore />);
    expect(
      screen.getByRole('button', { name: 'Other tasks needing attention 1 shown · 10 total' }),
    ).toBeInTheDocument();
  });

  it('keeps the fallback spotlight when a polled-out task returns', () => {
    const firstTask = makeTask({ id: 'first', title: 'First review', status: 'plan_ready' });
    const secondTask = makeTask({ id: 'second', title: 'Second review', status: 'plan_ready' });
    const renderOverview = (attentionTasks: Task[]) => (
      <QueueOverview
        queuedAdmissions={queuedAdmissionsStub}
        attentionTasks={attentionTasks}
        runningTasks={[]}
        waitingTasks={[]}
        queuedCount={0}
        reviewCount={attentionTasks.length}
        runningCount={0}
        taskActions={makeTaskActions()}
      />
    );
    const { rerender } = render(renderOverview([firstTask, secondTask]));

    fireEvent.click(screen.getByRole('button', { name: 'Show next task needing attention' }));
    expect(
      within(screen.getByRole('region', { name: 'Tasks needing your attention' })).getByText(
        'Second review',
      ),
    ).toBeInTheDocument();

    rerender(renderOverview([firstTask]));
    rerender(renderOverview([firstTask, secondTask]));

    const spotlight = within(screen.getByRole('region', { name: 'Tasks needing your attention' }));
    expect(spotlight.getByText('First review')).toBeInTheDocument();
    expect(spotlight.queryByText('Second review')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Other tasks needing attention 1' }).closest('details')
        ?.open,
    ).toBe(false);
  });

  it('keeps a missing chat in place and explains why it cannot open', () => {
    const onOpenChat = vi.fn();
    const taskActions = makeTaskActions({ onOpenChat });
    const task = makeTask({ result: null, linkedChatId: null });
    render(
      <QueueOverview
        queuedAdmissions={queuedAdmissionsStub}
        attentionTasks={[]}
        runningTasks={[task]}
        waitingTasks={[]}
        queuedCount={0}
        reviewCount={0}
        runningCount={1}
        taskActions={taskActions}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Fix flaky auth test, running' }));
    expect(onOpenChat).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('Cannot open this task', {
      description: 'This task is missing its linked chat.',
    });
  });

  it('loads older rows within the selected Overview lane', () => {
    const attentionLoad = vi.fn(async () => undefined);
    const inboxLoad = vi.fn(async () => undefined);
    const runningLoad = vi.fn(async () => undefined);
    render(
      <QueueOverview
        queuedAdmissions={queuedAdmissionsStub}
        attentionTasks={[makeTask({ id: 'review', status: 'plan_ready' })]}
        pagination={{
          attention: { canLoadMore: true, isLoadingMore: false, loadMore: attentionLoad },
          inbox: { canLoadMore: true, isLoadingMore: false, loadMore: inboxLoad },
          running: { canLoadMore: true, isLoadingMore: false, loadMore: runningLoad },
        }}
        runningTasks={[makeTask()]}
        waitingTasks={[makeTask({ id: 'waiting', status: 'pending', result: null })]}
        queuedCount={0}
        reviewCount={1}
        runningCount={1}
        taskActions={makeTaskActions()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load older attention tasks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load older running tasks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load older Inbox tasks' }));
    expect(attentionLoad).toHaveBeenCalledOnce();
    expect(runningLoad).toHaveBeenCalledOnce();
    expect(inboxLoad).toHaveBeenCalledOnce();
  });
});
