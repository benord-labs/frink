// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../types';
import { makeTaskActions } from '../../test-fixtures';
import { HistoryTaskList } from '..';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Shipped task',
    description: 'Released from CI',
    status: 'completed',
    source: 'github',
    result: { chatId: 'chat-1' },
    createdAt: '2026-08-11T11:30:00.000Z',
    completedAt: '2026-08-11T11:55:00.000Z',
    projectName: 'frink-web',
    ...overrides,
  };
}

function renderHistory(
  tasks: Task[],
  overrides: Partial<Parameters<typeof HistoryTaskList>[0]> = {},
) {
  const props = {
    canLoadMore: false,
    onLoadMore: vi.fn(async () => undefined),
    taskActions: makeTaskActions(),
    tasks,
    ...overrides,
  };
  return { ...render(<HistoryTaskList {...props} />), props };
}

describe('HistoryTaskList', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T12:00:00.000Z'));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders mixed history in controller order with explicit terminal semantics', () => {
    const tasks = [
      makeTask(),
      makeTask({
        id: 'task-2',
        title: 'Stopped task',
        status: 'cancelled',
        result: null,
        completedAt: null,
        createdAt: '2026-08-11T11:40:00.000Z',
      }),
    ];
    renderHistory(tasks);

    expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument();
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => within(row).getByText(/task$/).textContent)).toEqual([
      'Shipped task',
      'Stopped task',
    ]);
    expect(rows[0]).toHaveAttribute('data-state', 'success');
    expect(rows[1]).toHaveAttribute('data-state', 'neutral');
    expect(within(rows[0]).getByText('Status: Completed')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Status: Cancelled')).toBeInTheDocument();
    expect(within(rows[1]).queryByText('Status: Neutral')).not.toBeInTheDocument();
    expect(screen.getByText('5m')).toBeInTheDocument();
    expect(screen.getByText('20m')).toBeInTheDocument();
  });

  it('filters loaded rows without changing their controller order', () => {
    renderHistory([
      makeTask(),
      makeTask({ id: 'task-2', title: 'Stopped task', status: 'cancelled' }),
      makeTask({ id: 'task-3', title: 'Another shipped task' }),
    ]);

    const all = screen.getByRole('tab', { name: 'All 3 loaded' });
    const completed = screen.getByRole('tab', { name: 'Completed 2 loaded' });
    const cancelled = screen.getByRole('tab', { name: 'Cancelled 1 loaded' });
    expect(all).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(cancelled);
    expect(cancelled).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getAllByRole('listitem').map((row) => within(row).getByText(/task$/).textContent),
    ).toEqual(['Stopped task']);

    fireEvent.click(completed);
    expect(
      screen.getAllByRole('listitem').map((row) => within(row).getByText(/task$/).textContent),
    ).toEqual(['Shipped task', 'Another shipped task']);

    fireEvent.click(all);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('keeps remote pagination available when a loaded filter is empty', () => {
    renderHistory([makeTask()], { canLoadMore: true });

    fireEvent.click(screen.getByRole('tab', { name: 'Cancelled 0 loaded' }));

    expect(screen.getByRole('status')).toHaveTextContent(
      'No loaded cancelled tasks. Load older history to keep looking.',
    );
    expect(screen.getByRole('button', { name: 'Load older history' })).toBeInTheDocument();
  });

  it('activates only rows with a linked chat and keeps actions outside the row button', () => {
    const taskActions = makeTaskActions();
    const linkedTask = makeTask();
    const staticTask = makeTask({
      id: 'task-2',
      title: 'Static task',
      status: 'cancelled',
      result: null,
      linkedChatId: null,
    });
    renderHistory([linkedTask, staticTask], { taskActions });

    fireEvent.click(screen.getByRole('button', { name: 'Shipped task, completed' }));
    expect(taskActions.onOpenChat).toHaveBeenCalledWith(linkedTask, 'chat-1');
    expect(
      screen.queryByRole('button', { name: 'Static task, cancelled' }),
    ).not.toBeInTheDocument();
    for (const row of screen.getAllByRole('listitem')) {
      expect(row.querySelector('button button')).not.toBeInTheDocument();
    }
  });

  it('preserves terminal delete, chat, and original-content actions', () => {
    const taskActions = makeTaskActions();
    const task = makeTask({
      triggerContext: {
        source: 'github',
        sourceAccountId: 'account-1',
        eventType: 'issue_opened',
        triggeredBy: {},
        timestamp: '2026-08-11T11:30:00.000Z',
        fullContent: { issue: { title: 'Shipped task' } },
        autoStart: true,
      },
    });
    renderHistory([task], { taskActions });

    const openMenu = () =>
      fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions for Shipped task' }));
    openMenu();
    expect(screen.getByRole('menuitem', { name: 'View chat' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'View original content' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'View original content' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'View chat' }));
    expect(taskActions.onOpenChat).toHaveBeenCalledWith(task, 'chat-1');

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(taskActions.onDelete).toHaveBeenCalledWith('task-1');
  });

  it('offers deletion but not chat navigation for unlinked cancelled history', () => {
    const taskActions = makeTaskActions();
    renderHistory([makeTask({ status: 'cancelled', result: null, linkedChatId: null })], {
      taskActions,
    });

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions for Shipped task' }));
    expect(screen.queryByRole('menuitem', { name: 'View chat' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(taskActions.onDelete).toHaveBeenCalledWith('task-1');
  });

  it('loads older controller rows only while a next cursor exists', async () => {
    let resolveLoad: () => void = () => {};
    const onLoadMore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = () => resolve();
        }),
    );
    const view = renderHistory([makeTask()], { canLoadMore: true, onLoadMore });
    const loadOlder = screen.getByRole('button', { name: 'Load older history' });

    fireEvent.click(loadOlder);
    fireEvent.click(loadOlder);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(loadOlder).toBeDisabled();
    resolveLoad();
    await vi.waitFor(() => expect(loadOlder).not.toBeDisabled());

    view.rerender(<HistoryTaskList {...view.props} canLoadMore={false} />);
    expect(screen.queryByRole('button', { name: 'Load older history' })).not.toBeInTheDocument();
  });
});
