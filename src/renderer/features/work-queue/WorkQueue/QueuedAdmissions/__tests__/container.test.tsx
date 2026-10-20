// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../../../components/ui/tooltip';
import { renderWithTrpc } from '../../../../../lib/test-utils/render-with-trpc';
import { QueuedAdmissions } from '..';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

afterEach(cleanup);

function queuedRow(ticket: number, flowName: string) {
  return {
    flow_name: flowName,
    is_batch_member: false,
    priority_class: 'start',
    project_name: null,
    requested_at: new Date('2026-10-20T07:00:00Z'),
    run_first: true,
    ticket,
    trigger_context: null,
  };
}

describe('QueuedAdmissions', () => {
  it('groups a run-first start from the queue API under Starting first', async () => {
    renderWithTrpc(
      <TooltipProvider>
        <QueuedAdmissions />
      </TooltipProvider>,
      ({ path }) => {
        if (path === 'flows.workQueueAdmissions') {
          return Promise.resolve([queuedRow(5, 'Daily digest')]);
        }
        if (path === 'flows.getAdmissionSettings') return Promise.resolve({ queue_paused: false });
        return new Promise(() => {});
      },
    );

    expect(await screen.findByRole('heading', { name: 'Starting first' })).toBeInTheDocument();
    expect(screen.getByText('Waiting to start first')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Starting' })).not.toBeInTheDocument();
  });

  it('announces a move with the group the run is waiting in', async () => {
    const moves: unknown[] = [];
    renderWithTrpc(
      <TooltipProvider>
        <QueuedAdmissions />
      </TooltipProvider>,
      ({ path, input }) => {
        if (path === 'flows.workQueueAdmissions') {
          return Promise.resolve([queuedRow(5, 'Daily digest'), queuedRow(6, 'CI babysitter')]);
        }
        if (path === 'flows.getAdmissionSettings') return Promise.resolve({ queue_paused: false });
        if (path === 'flows.moveWorkQueueAdmission') {
          moves.push(input);
          return Promise.resolve({ status: 'moved' });
        }
        return new Promise(() => {});
      },
    );

    fireEvent.click(
      await screen.findByRole('button', { name: 'Move Daily digest down, Starting first 1 of 2' }),
    );

    await waitFor(() => expect(moves).toEqual([{ ticket: 5, target_ticket: 6 }]));
    expect(
      await screen.findByText('Daily digest moved to position 2 in Starting first.'),
    ).toHaveAttribute('aria-live', 'polite');
  });
});
