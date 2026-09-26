// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../types';
import { makeTaskActions } from '../../test-fixtures';
import { AttentionCarousel } from '..';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Add Stripe webhook handler',
    description: null,
    status: 'plan_ready',
    source: 'slack',
    result: { chatId: 'chat-1' },
    createdAt: '2026-08-11T12:00:00.000Z',
    projectName: 'billing-api',
    ...overrides,
  };
}

describe('AttentionCarousel', () => {
  it('stays hidden when no task needs attention', () => {
    const { container } = render(
      <AttentionCarousel
        tasks={[]}
        onOpenTask={vi.fn()}
        onSelectTask={vi.fn()}
        selectedTaskId="missing-task"
        spotlightActionRef={createRef()}
        taskActions={makeTaskActions()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('matches the marketing plan-review card and opens the task', () => {
    const onOpenTask = vi.fn();
    const taskActions = makeTaskActions();
    const task = makeTask();
    render(
      <AttentionCarousel
        tasks={[task]}
        onOpenTask={onOpenTask}
        onSelectTask={vi.fn()}
        selectedTaskId={task.id}
        spotlightActionRef={createRef()}
        taskActions={taskActions}
      />,
    );

    expect(screen.getByText('Plan ready - needs your review')).toBeInTheDocument();
    expect(screen.getByText('Add Stripe webhook handler')).toBeInTheDocument();
    expect(screen.getByText('billing-api')).toBeInTheDocument();
    expect(screen.getByText('Approve, edit, or send it back - you decide.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(onOpenTask).toHaveBeenCalledWith(task);

    fireEvent.pointerDown(screen.getByRole('button', { name: /More actions for/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start execution' }));
    expect(taskActions.onStartExecution).toHaveBeenCalledWith('task-1');
  });

  it('pages through attention tasks while keeping the selected id across reorders', () => {
    const onSelectTask = vi.fn();
    const planTask = makeTask();
    const questionTask = makeTask({
      id: 'task-2',
      title: 'Choose a deployment region',
      status: 'needs_attention',
      result: {
        chatId: 'chat-2',
        agentSignal: {
          state: 'awaiting_input',
          summary: 'Select the region that should receive production traffic.',
        },
      },
    });
    const { rerender } = render(
      <AttentionCarousel
        tasks={[planTask, questionTask]}
        onOpenTask={vi.fn()}
        onSelectTask={onSelectTask}
        selectedTaskId={planTask.id}
        spotlightActionRef={createRef()}
        taskActions={makeTaskActions()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show next task needing attention' }));
    expect(onSelectTask).toHaveBeenCalledWith(questionTask.id);

    rerender(
      <AttentionCarousel
        tasks={[questionTask, planTask]}
        onOpenTask={vi.fn()}
        onSelectTask={onSelectTask}
        selectedTaskId={questionTask.id}
        spotlightActionRef={createRef()}
        taskActions={makeTaskActions()}
      />,
    );
    expect(screen.getByText('Choose a deployment region')).toBeInTheDocument();
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
  });

  it('falls back to the first task when the selected task leaves the queue', () => {
    const planTask = makeTask();
    const interruptedTask = makeTask({
      id: 'task-2',
      title: 'Resume dependency upgrade',
      status: 'interrupted',
    });
    const { rerender } = render(
      <AttentionCarousel
        tasks={[planTask, interruptedTask]}
        onOpenTask={vi.fn()}
        onSelectTask={vi.fn()}
        selectedTaskId={planTask.id}
        spotlightActionRef={createRef()}
        taskActions={makeTaskActions()}
      />,
    );
    rerender(
      <AttentionCarousel
        tasks={[planTask]}
        onOpenTask={vi.fn()}
        onSelectTask={vi.fn()}
        selectedTaskId="task-2"
        spotlightActionRef={createRef()}
        taskActions={makeTaskActions()}
      />,
    );
    expect(screen.getByText('Add Stripe webhook handler')).toBeInTheDocument();
    expect(screen.queryByText(/\//)).not.toBeInTheDocument();
  });

  it('closes task-owned dialogs when polling replaces the selected task', () => {
    const planTask = makeTask();
    const failedTask = makeTask({
      id: 'task-2',
      title: 'Inspect failed webhook',
      status: 'failed',
      triggerContext: {
        source: 'github',
        sourceAccountId: 'account-1',
        eventType: 'issue_opened',
        triggeredBy: { name: 'Octocat' },
        timestamp: '2026-08-11T12:00:00.000Z',
        fullContent: { title: 'Webhook failed' },
        autoStart: false,
      },
    });
    const { rerender } = render(
      <AttentionCarousel
        tasks={[planTask, failedTask]}
        onOpenTask={vi.fn()}
        onSelectTask={vi.fn()}
        selectedTaskId={failedTask.id}
        spotlightActionRef={createRef()}
        taskActions={makeTaskActions()}
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'More actions for Inspect failed webhook' }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'View original content' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    rerender(
      <AttentionCarousel
        tasks={[planTask]}
        onOpenTask={vi.fn()}
        onSelectTask={vi.fn()}
        selectedTaskId={planTask.id}
        spotlightActionRef={createRef()}
        taskActions={makeTaskActions()}
      />,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Add Stripe webhook handler')).toBeInTheDocument();
  });

  it.each([
    {
      name: 'failed',
      overrides: {
        status: 'failed' as const,
        result: {
          chatId: 'chat-1',
          agentSignal: { state: 'awaiting_input' as const, summary: 'This signal is stale.' },
        },
      },
      action: 'Review failure',
      label: 'Failed - needs your attention',
      helper: 'Check the failure before deciding how to continue.',
      iconClassName: 'lucide-circle-x',
      iconColorClassName: 'text-danger-fg',
    },
    {
      name: 'blocked',
      overrides: {
        status: 'needs_attention' as const,
        result: {
          chatId: 'chat-1',
          agentSignal: {
            state: 'blocked' as const,
            summary: 'Choose how the agent should proceed.',
          },
        },
      },
      action: 'Review',
      label: 'Blocked - needs your decision',
      helper: 'Choose how the agent should proceed.',
      iconClassName: 'lucide-ban',
      iconColorClassName: 'text-warning-fg',
    },
    {
      name: 'awaiting input',
      overrides: {
        status: 'needs_attention' as const,
        result: {
          chatId: 'chat-1',
          agentSignal: { state: 'awaiting_input' as const, summary: 'Select a deployment region.' },
        },
      },
      action: 'Answer',
      label: 'Agent waiting - needs your input',
      helper: 'Select a deployment region.',
      iconClassName: 'lucide-message-circle-question-mark',
      iconColorClassName: 'text-warning-fg',
    },
    {
      name: 'ready for review',
      overrides: { status: 'done' as const },
      action: 'Review result',
      label: 'Ready for review',
      helper: 'Review the result, then mark it complete.',
      iconClassName: 'lucide-clipboard-check',
      iconColorClassName: 'text-primary',
    },
    {
      name: 'unknown attention',
      overrides: { status: 'needs_attention' as const },
      action: 'Review',
      label: 'Needs your attention',
      helper: 'Open the task to continue.',
      iconClassName: 'lucide-triangle-alert',
      iconColorClassName: 'text-warning-fg',
    },
  ])(
    'gives $name work a distinct, explicit attention state',
    ({ overrides, action, label, helper, iconClassName, iconColorClassName }) => {
      const task = makeTask(overrides);
      const onOpenTask = vi.fn();
      const { container } = render(
        <AttentionCarousel
          tasks={[task]}
          onOpenTask={onOpenTask}
          onSelectTask={vi.fn()}
          selectedTaskId={task.id}
          spotlightActionRef={createRef()}
          taskActions={makeTaskActions()}
        />,
      );

      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getByText(helper)).toBeInTheDocument();
      expect(container.querySelector(`.${iconClassName}`)).toHaveClass(iconColorClassName);
      fireEvent.click(screen.getByRole('button', { name: action }));
      expect(onOpenTask).toHaveBeenCalledWith(task);
    },
  );
});
