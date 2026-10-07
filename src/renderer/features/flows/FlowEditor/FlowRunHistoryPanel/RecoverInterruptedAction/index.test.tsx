// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { DbFlowRunWithNodeRuns } from '../../../../../../shared/types/flow-run';
import {
  type RunRecovery,
  recoveryKindSchema,
} from '../../../../../../shared/types/flow-run/resume';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { RecoverInterruptedAction } from './index';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const RETRY_INPUT = z.object({ runId: z.string(), kind: recoveryKindSchema });
const retryRun = vi.fn<(input: z.infer<typeof RETRY_INPUT>) => void>();

/** Answers the retry procedure in-process, the way the main-process router would. */
async function answer(op: Operation): Promise<{ ok: true }> {
  if (op.path !== 'flows.retryRunFromLastNode') {
    throw new Error(`Unexpected test operation: ${op.path}`);
  }
  retryRun(RETRY_INPUT.parse(op.input));
  return { ok: true };
}

/** A restart-interrupted run whose marked step is a started command (Retry confirms first). */
function interruptedRun(
  id: string,
  kind: RunRecovery['kind'] = 'retry',
  nodeRunId = `nr-${id}`,
): DbFlowRunWithNodeRuns {
  return {
    id,
    flow_version_id: 'fv',
    status: 'cancelled',
    trigger_context: null,
    idempotency_key: null,
    started_at: null,
    completed_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    graph: null,
    nodeRuns: [],
    recoveries: [{ nodeRunId, kind, confirmSideEffects: true }],
  };
}

const renderAction = (run: DbFlowRunWithNodeRuns) =>
  renderWithTrpc(<RecoverInterruptedAction flowId="f1" run={run} />, answer);
const confirmButton = () => screen.queryByRole('button', { name: /retry anyway/i });

describe('RecoverInterruptedAction', () => {
  afterEach(() => {
    cleanup();
    retryRun.mockReset();
  });

  it('confirms before retrying a started step, then re-admits that run', async () => {
    renderAction(interruptedRun('run-a'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retryRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /retry anyway/i }));
    await waitFor(() => expect(retryRun).toHaveBeenCalledWith({ runId: 'run-a', kind: 'retry' }));
  });

  // An open confirmation after success would let a second click resubmit the same recovery.
  it('closes the confirmation once the retry succeeds', async () => {
    renderAction(interruptedRun('run-a'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: /retry anyway/i }));

    await waitFor(() => expect(confirmButton()).not.toBeInTheDocument());
    expect(retryRun).toHaveBeenCalledOnce();
  });

  // Both clicks land in one act, before the pending state can render and disable the button.
  it('sends one recovery when Continue is clicked twice before it shows pending', async () => {
    renderAction(interruptedRun('run-a', 'continue'));
    const button = screen.getByRole('button', { name: 'Continue' });
    act(() => {
      button.click();
      button.click();
    });

    await waitFor(() => expect(retryRun).toHaveBeenCalledOnce());
    await waitFor(() => expect(button).toBeEnabled());
    expect(retryRun).toHaveBeenCalledOnce();
  });

  it.each([
    ['another run is selected', interruptedRun('run-b')],
    ['the run moves to another step', interruptedRun('run-a', 'retry', 'nr-other')],
    ['a refresh makes the step continuable', interruptedRun('run-a', 'continue')],
  ])('drops an open confirmation when %s, even after returning', (_case, other) => {
    const { rerender } = renderAction(interruptedRun('run-a'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    rerender(<RecoverInterruptedAction flowId="f1" run={other} />);
    expect(confirmButton()).not.toBeInTheDocument();
    rerender(<RecoverInterruptedAction flowId="f1" run={interruptedRun('run-a')} />);
    expect(confirmButton()).not.toBeInTheDocument();
    expect(retryRun).not.toHaveBeenCalled();
  });
});
