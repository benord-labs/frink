// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { FlowWaitingBar } from '.';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const START_INPUT = z.object({ taskId: z.string() });
const startWaiting = vi.fn<(input: z.infer<typeof START_INPUT>) => Promise<{ id: string }>>();

async function answerStart(op: Operation): Promise<{ id: string }> {
  if (op.path !== 'tasks.startWaiting') throw new Error(`Unexpected test operation: ${op.path}`);
  return startWaiting(START_INPUT.parse(op.input));
}

const renderBar = () =>
  renderWithTrpc(
    <FlowWaitingBar flowRunId="run-1" taskId="task-1" mode="agent" onStopTurn={vi.fn()} />,
    answerStart,
  );

const startButton = () => screen.getByRole('button', { name: /Start/ });

describe('FlowWaitingBar', () => {
  afterEach(() => {
    cleanup();
    startWaiting.mockReset();
    vi.restoreAllMocks();
  });

  it('says the step is waiting and offers Start and Stop, with no running spinner', () => {
    renderBar();
    expect(screen.getByText('Waiting for you to start this step.')).toBeInTheDocument();
    expect(startButton()).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(document.querySelector('.animate-spin')).toBeNull();
  });

  it('sends one start for a double click and holds Starting… once it lands', async () => {
    startWaiting.mockResolvedValue({ id: 'task-1' });
    renderBar();
    fireEvent.click(startButton());
    fireEvent.click(startButton());

    await waitFor(() => expect(startButton()).toHaveTextContent('Starting…'));
    await waitFor(() => expect(startWaiting).toHaveBeenCalledExactlyOnceWith({ taskId: 'task-1' }));
    expect(startButton()).toBeDisabled();
  });

  it('steps Start aside while Stop asks for confirmation', () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByRole('button', { name: 'Confirm stop' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start/ })).toBeNull();
  });

  it('reports a refused start and lets the user try again', async () => {
    const error = vi.spyOn(toast, 'error');
    startWaiting.mockRejectedValue(new Error('This step has already finished or been stopped.'));
    renderBar();
    fireEvent.click(startButton());

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Couldn't start this step", {
        description: 'This step has already finished or been stopped.',
      }),
    );
    expect(startButton()).toBeEnabled();
  });
});
