// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import type { HeldRun } from '@/lib/work-queue/held-runs/use-held-runs';
import { Inbox } from '.';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const shortcutAssigned = {
  source: 'shortcut',
  sourceAccountId: 'account-1',
  eventType: 'story_assigned',
  triggeredBy: {},
  timestamp: '2026-11-17T09:00:00.000Z',
  autoStart: false,
  fullContent: {
    primary_id: 4821,
    actions: [
      {
        id: 4821,
        entity_type: 'story',
        name: 'Fix login redirect',
        changes: { owner_ids: { adds: ['member-1'], removes: [] } },
      },
    ],
    references: [{ id: 'member-1', entity_type: 'member', name: 'Ben' }],
  },
};

function heldRun(id: string, fields: Partial<HeldRun> = {}): HeldRun {
  return {
    flow_name: `Flow ${id}`,
    flow_run_id: id,
    held_at: new Date(),
    project_name: 'frink',
    starts_on_latest_version: true,
    trigger_context: null,
    ...fields,
  };
}

type HeldRunReply = { status: 'started' | 'dismissed' | 'stale' };

function renderInbox(
  runs: HeldRun[],
  answer: (op: Operation) => HeldRunReply = () => ({ status: 'started' }),
  total = runs.length,
) {
  const calls: Operation[] = [];
  renderWithTrpc(<Inbox />, async (op) => {
    calls.push(op);
    if (op.path !== 'flows.workQueueHeldRuns') return answer(op);
    // SAFETY: the Inbox always sends its page size as `{ limit }`.
    const { limit } = op.input as { limit: number };
    return { runs: runs.slice(0, limit), total };
  });
  return calls;
}

// SAFETY: every Inbox row title sits inside its row's <li>.
const row = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

describe('Work Queue Inbox', () => {
  it('shows nothing while no run waits for Start', async () => {
    const calls = renderInbox([]);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByRole('heading', { name: /Inbox/ })).toBeNull();
  });

  it('says what started each run, and when Start keeps the version it was triggered on', async () => {
    renderInbox([
      heldRun('webhook', { trigger_context: shortcutAssigned }),
      heldRun('schedule', {
        trigger_context: { _frinkTrigger: 'schedule_trigger' },
        starts_on_latest_version: false,
      }),
      heldRun('task', {
        trigger_context: { _frinkTrigger: 'post_task_trigger', taskTitle: 'Fix CI' },
      }),
    ]);

    expect(await screen.findByRole('heading', { name: 'Inbox, ready to start' })).toBeVisible();
    expect(row('Flow webhook')).toHaveTextContent(
      'Shortcut · Owners added: Ben · Fix login redirect',
    );
    expect(row('Flow schedule')).toHaveTextContent(
      'Scheduled · Runs the Flow as it was when triggered',
    );
    expect(row('Flow task')).toHaveTextContent('Task · Fix CI finished');
  });

  it('starts or dismisses one run once, and says when another surface handled it first', async () => {
    const info = vi.spyOn(toast, 'info');
    const calls = renderInbox([heldRun('a'), heldRun('b')], (op) =>
      op.path === 'flows.dismissHeldRun' ? { status: 'stale' } : { status: 'started' },
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Start Flow a' }));
    fireEvent.click(within(row('Flow b')).getByRole('button', { name: 'Dismiss Flow b' }));

    await waitFor(() => expect(info).toHaveBeenCalledWith('Already handled', expect.anything()));
    // The answered rows are still listed here, so a second click must find them disabled.
    for (const name of ['Start Flow a', 'Dismiss Flow b']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    const actions = calls.filter((op) => op.type === 'mutation');
    expect(actions.map((op) => [op.path, op.input])).toEqual([
      ['flows.startHeldRun', { run_id: 'a' }],
      ['flows.dismissHeldRun', { run_id: 'b' }],
    ]);
  });

  it('counts every held run and loads older ones a page at a time', async () => {
    const runs = Array.from({ length: 60 }, (_, index) => heldRun(`${index}`));
    const calls = renderInbox(runs);

    expect(await screen.findByRole('heading', { name: 'Inbox, 60 ready to start' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Load older runs' }));

    expect(await screen.findByRole('heading', { name: 'Inbox, ready to start' })).toBeVisible();
    expect(calls.map((op) => op.input)).toContainEqual({ limit: 100 });
  });
});
