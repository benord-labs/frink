// @vitest-environment happy-dom
/**
 * useSingleFlowRun: the dirty flag captured at dispatch decides the toast copy, and the server's
 * executed version — not the editor's — is the one named.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

type StartRunResult = { status: string; version_number?: number | null };
type CallOpts = { onSuccess: (run: StartRunResult) => void };

const snap = vi.hoisted(() => ({
  mutate: vi.fn() as Mock,
  invalidate: vi.fn() as Mock,
  hookOpts: undefined as
    | { onSuccess: () => void; onError: (err: { message: string }) => void }
    | undefined,
}));

vi.mock('../trpc', () => ({
  trpc: {
    flows: {
      startRun: {
        useMutation: (opts: typeof snap.hookOpts) => {
          snap.hookOpts = opts;
          return { mutate: snap.mutate, isPending: false };
        },
      },
    },
    useUtils: () => ({
      flows: {
        listRuns: { invalidate: snap.invalidate },
        listBatches: { invalidate: snap.invalidate },
        listBatchRuns: { invalidate: snap.invalidate },
        list: { invalidate: snap.invalidate },
      },
    }),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const { toast } = await import('sonner');
const { useSingleFlowRun } = await import('./use-single-flow-run');

afterEach(() => {
  snap.mutate.mockReset();
  snap.invalidate.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

/** Start a run with the given dirty flag and resolve it with the server's answer. */
function runAndResolve(hadUnsavedChanges: boolean, result: StartRunResult): void {
  const { result: hook } = renderHook(() => useSingleFlowRun('flow-1'));
  act(() => hook.current.startSingleRun(hadUnsavedChanges));
  const [vars, opts] = snap.mutate.mock.calls[0] as [unknown, CallOpts];
  expect(vars).toEqual({ flowId: 'flow-1', triggerContext: null });
  opts.onSuccess(result);
}

describe('useSingleFlowRun', () => {
  it('a clean run keeps the plain copy', () => {
    runAndResolve(false, { status: 'running', version_number: 4 });
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('Run started');
  });

  it('a dirty run names the server-executed version', () => {
    runAndResolve(true, { status: 'pending', version_number: 7 });
    expect(toast.success).toHaveBeenCalledExactlyOnceWith(
      "Run queued on saved v7 — your unsaved edits aren't included",
    );
  });

  it('refreshes run lists on success and surfaces start errors', () => {
    renderHook(() => useSingleFlowRun('flow-1'));
    snap.hookOpts?.onSuccess();
    expect(snap.invalidate).toHaveBeenCalledWith({ flowId: 'flow-1' });
    snap.hookOpts?.onError({ message: 'Flow is disabled' });
    expect(toast.error).toHaveBeenCalledWith('Flow is disabled');
  });
});
