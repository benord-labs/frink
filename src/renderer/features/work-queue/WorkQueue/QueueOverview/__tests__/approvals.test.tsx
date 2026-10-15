// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as approvalHooks from '../../../../../lib/work-queue/approvals/use-work-queue-approvals';
import type { AwaitingApproval } from '../../../../../lib/work-queue/approvals/use-work-queue-approvals';
import type { Task } from '../../../types';
import * as pausedBanner from '../../QueuePausedBanner';
import { makeTaskActions } from '../../test-fixtures';
import { QueueOverview } from '..';

vi.hoisted(() => {
  Reflect.set(globalThis, 'electronTRPC', { onMessage: vi.fn(), sendMessage: vi.fn() });
});

const gate: AwaitingApproval = {
  flowRunId: 'run-gate',
  flowId: 'flow-1',
  flowName: 'Release train',
  projectName: 'frink-oss',
  gateCount: 1,
  nodeRunId: 'gate-1',
  message: 'Deploy the release branch to staging?',
  waitingSince: new Date(2026, 9, 14, 14, 41),
};

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: null,
    status: 'running',
    source: 'flow',
    result: { chatId: `chat-${id}` },
    createdAt: '2026-10-14T12:00:00.000Z',
    ...overrides,
  };
}

const spotlight = () =>
  within(screen.getByRole('region', { name: 'Tasks needing your attention' }));

function overview(
  approvals: AwaitingApproval[],
  attentionTasks: Task[],
  runningTasks: Task[] = [],
) {
  vi.spyOn(approvalHooks, 'useAwaitingApprovals').mockReturnValue(approvals);
  const props = {
    attentionTasks,
    interruptedRuns: null,
    queuedAdmissions: <section aria-label="Queued to run" />,
    queuedCount: 0,
    reviewCount: approvals.length + attentionTasks.length,
    runningCount: runningTasks.length,
    runningTasks,
    taskActions: makeTaskActions(),
  };
  return <QueueOverview {...props} />;
}

beforeEach(() => {
  vi.spyOn(pausedBanner, 'QueuePausedBanner').mockReturnValue(null);
  vi.spyOn(approvalHooks, 'useApprovalActions').mockReturnValue({
    approve: vi.fn(),
    cancel: vi.fn(),
    openRun: vi.fn(),
    pending: new Map(),
  });
});

describe('QueueOverview approvals', () => {
  it('shows a run waiting on its approval once, as an approval rather than Running', () => {
    const question = makeTask('Choose a region', { status: 'needs_attention' });
    const gateRunStep = makeTask('Build the release', { status: 'done', flowRunId: 'run-gate' });
    render(overview([gate], [question], [gateRunStep, makeTask('Fix flaky test')]));

    expect(spotlight().getByText('Deploy the release branch to staging?')).toBeInTheDocument();
    const running = screen.getByRole('region', { name: 'Running now, across your projects' });
    expect(within(running).queryByText('Build the release')).not.toBeInTheDocument();
    expect(within(running).getByText('Fix flaky test')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Other tasks needing attention 1' }),
    ).toBeInTheDocument();
  });

  it('keeps the task on screen when an approval arrives, then promotes it with Open run focused', async () => {
    const review = makeTask('Review this plan', { status: 'plan_ready' });
    const { rerender } = render(overview([], [review]));
    rerender(overview([gate], [review]));

    expect(spotlight().getByText('Review this plan')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Other tasks needing attention 1' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Deploy the release branch to staging?, needs approval, show in spotlight',
      }),
    );

    expect(spotlight().getByText('Deploy the release branch to staging?')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Open run of Release train' })).toHaveFocus(),
    );
  });
});
