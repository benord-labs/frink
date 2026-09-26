// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../types';
import { makeTaskActions } from '../../test-fixtures';
import { RunningTaskList } from '..';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Fix flaky auth test',
    description: 'From CI · login session expiry',
    status: 'running',
    source: 'github',
    result: { chatId: 'chat-1' },
    createdAt: '2026-08-11T11:40:00.000Z',
    startedAt: '2026-08-11T11:50:00.000Z',
    projectName: 'frink-web',
    ...overrides,
  };
}

describe('RunningTaskList', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays hidden when no agent is running', () => {
    const { container } = render(
      <RunningTaskList tasks={[]} taskActions={makeTaskActions()} onOpenTask={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders the marketing row anatomy and delegates activation', () => {
    const onOpenTask = vi.fn();
    const task = makeTask();
    const taskActions = makeTaskActions();
    const { container } = render(
      <RunningTaskList tasks={[task]} taskActions={taskActions} onOpenTask={onOpenTask} />,
    );

    expect(
      screen.getByRole('heading', { name: 'Running now, across your projects' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Fix flaky auth test')).toBeInTheDocument();
    expect(screen.getByText('GitHub · From CI · login session expiry')).toBeInTheDocument();
    expect(screen.getByText('frink-web').closest('.activity-row-meta')).toBeInTheDocument();
    expect(screen.getByText('10m').closest('.activity-row-trailing')).toHaveClass('min-w-24');
    expect(container.querySelector('.activity-row-leading')).toBeInTheDocument();
    expect(screen.getByText('Fix flaky auth test').previousElementSibling).toHaveClass(
      'motion-safe:animate-pulse',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Fix flaky auth test, running' }));
    expect(onOpenTask).toHaveBeenCalledWith(task);

    const listItem = screen.getByText('Fix flaky auth test').closest('li');
    expect(listItem?.querySelector('.activity-row-actions')).toBeInTheDocument();
    expect(listItem?.querySelector('button button')).not.toBeInTheDocument();
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'More actions for Fix flaky auth test' }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel' }));
    expect(taskActions.onCancel).toHaveBeenCalledWith('task-1');
  });

  it('prefers trigger provider data over a flow wrapper source', () => {
    const task = makeTask({
      source: 'flow',
      title: 'Wrapped title',
      description: null,
      triggerContext: {
        source: 'linear',
        sourceAccountId: 'linear-account',
        eventType: 'issue_created',
        triggeredBy: {},
        timestamp: '2026-08-11T11:50:00.000Z',
        fullContent: {
          data: { title: 'Triage inbound bug report', description: 'Repro attached' },
        },
        autoStart: true,
      },
    });

    render(<RunningTaskList tasks={[task]} taskActions={makeTaskActions()} onOpenTask={vi.fn()} />);

    expect(screen.getByText('Triage inbound bug report')).toBeInTheDocument();
    expect(screen.getByText('Linear · issue_created')).toBeInTheDocument();
  });

  it('expands and collapses every running task loaded into the overview', () => {
    const onOpenTask = vi.fn();
    const tasks = Array.from({ length: 7 }, (_, index) =>
      makeTask({ id: `task-${index + 1}`, title: `Running task ${index + 1}` }),
    );

    render(
      <RunningTaskList tasks={tasks} taskActions={makeTaskActions()} onOpenTask={onOpenTask} />,
    );

    expect(screen.getByText('Running task 6')).toBeInTheDocument();
    expect(screen.queryByText('Running task 7')).not.toBeInTheDocument();
    const expand = screen.getByRole('button', { name: 'Show 1 more running task' });
    expect(expand).toHaveTextContent('Show 1 more');
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(expand.getAttribute('aria-controls') ?? '')).toHaveAttribute(
      'aria-label',
      'Running tasks',
    );

    fireEvent.click(expand);
    expect(screen.getByText('Running task 7')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Running task 7, running' }));
    expect(onOpenTask).toHaveBeenCalledWith(tasks[6]);

    const collapse = screen.getByRole('button', { name: 'Show fewer running tasks' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(collapse);
    expect(screen.queryByText('Running task 7')).not.toBeInTheDocument();
  });
});
