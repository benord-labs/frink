// @vitest-environment happy-dom
/**
 * useBatchRunActions: run-state derivation and Start Batch for one explicit batch id.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

type StartBatchResult = { started: boolean; reason?: string };
/** The listBatchStages payload, loosened so a test can model a response with no stages key. */
type StagesPayload = { stages?: unknown[] };

type Snap = {
  stages: unknown[];
  /** false = the stages query has not resolved (still loading, or errored) — data is undefined. */
  resolved: boolean;
  /** Overrides the resolved query payload wholesale, for shapes `stages: [...]` cannot express. */
  data: StagesPayload | undefined;
  startBatchMutate: Mock;
  invalidate: Mock;
  /** The mutation's onSuccess, captured so the dispatch wiring can be driven directly. */
  onSuccess: (result: StartBatchResult) => void;
  runSingle: Mock;
};

const snap = vi.hoisted<Snap>(() => ({
  stages: [],
  resolved: true,
  data: undefined,
  startBatchMutate: vi.fn(),
  invalidate: vi.fn(),
  onSuccess: () => {},
  runSingle: vi.fn(),
}));

vi.mock('../trpc', () => ({
  trpc: {
    flows: {
      listBatchStages: {
        useQuery: () => ({
          data: snap.data ?? (snap.resolved ? { stages: snap.stages } : undefined),
        }),
      },
      startBatch: {
        useMutation: (opts: { onSuccess: (result: StartBatchResult) => void }) => {
          snap.onSuccess = opts.onSuccess;
          return { mutate: snap.startBatchMutate, isPending: false };
        },
      },
    },
    useUtils: () => ({
      flows: {
        listBatches: { invalidate: snap.invalidate },
        listBatchRuns: { invalidate: snap.invalidate },
        listBatchStages: { invalidate: snap.invalidate },
        list: { invalidate: snap.invalidate },
      },
    }),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { toast } = await import('sonner');

const { useBatchRunActions } = await import('./use-batch-run-actions');

const FLOW_ID = 'flow-1';
const BATCH_ID = 'batch-1';

function stageRow(overrides: Record<string, unknown> = {}) {
  return {
    status: 'completed',
    run_count: 1,
    completed_count: 1,
    failed_count: 0,
    active_count: 0,
    depends_on_stage_numbers: [] as number[],
    ...overrides,
  };
}

afterEach(() => {
  snap.stages = [];
  snap.resolved = true;
  snap.data = undefined;
  snap.startBatchMutate.mockReset();
  snap.runSingle.mockReset();
  vi.mocked(toast.info).mockReset();
  vi.mocked(toast.success).mockReset();
});

describe('useBatchRunActions', () => {
  it('returns null run state (plain single-run path) when there is no batch', () => {
    const { result } = renderHook(() => useBatchRunActions(FLOW_ID, null, snap.runSingle));
    expect(result.current.runState).toBeNull();
    expect(result.current.hasDeferredRoots).toBe(false);
  });

  it('marks existing-run recovery unavailable for a terminal batch', () => {
    snap.stages = [stageRow({ status: 'failed', failed_count: 1, completed_count: 0 })];
    const { result } = renderHook(() => useBatchRunActions(FLOW_ID, BATCH_ID, snap.runSingle));
    expect(result.current.runState?.primary).toBe('unavailable');
  });

  it('flags deferred roots (planned root stage never dispatched)', () => {
    snap.stages = [stageRow({ status: 'pending', completed_count: 0 })];
    const { result } = renderHook(() => useBatchRunActions(FLOW_ID, BATCH_ID, snap.runSingle));
    expect(result.current.hasDeferredRoots).toBe(true);
    expect(result.current.runState?.primary).toBe('start');
  });

  it('keeps the plain single-run path for a batch with no stages planned yet', () => {
    snap.stages = [];
    const { result } = renderHook(() => useBatchRunActions(FLOW_ID, BATCH_ID, snap.runSingle));
    expect(result.current.runState).toBeNull();
    expect(result.current.hasDeferredRoots).toBe(false);
  });

  it('stays on the batch path while the stages query has not resolved', () => {
    snap.resolved = false;
    const { result } = renderHook(() => useBatchRunActions(FLOW_ID, BATCH_ID, snap.runSingle));
    expect(result.current.runState?.primary).toBe('start');
  });

  it('returns to the batch path once stages are planned on a previously empty batch', () => {
    const { result, rerender } = renderHook(() =>
      useBatchRunActions(FLOW_ID, BATCH_ID, snap.runSingle),
    );
    expect(result.current.runState).toBeNull();
    snap.stages = [stageRow({ status: 'pending', completed_count: 0 })];
    rerender();
    expect(result.current.runState?.primary).toBe('start');
    expect(result.current.hasDeferredRoots).toBe(true);
  });

  it('treats a payload without a stages array as unknown, not as an empty batch', () => {
    snap.data = {};
    const { result } = renderHook(() => useBatchRunActions(FLOW_ID, BATCH_ID, snap.runSingle));
    expect(result.current.runState?.primary).toBe('start');
    expect(result.current.hasDeferredRoots).toBe(false);
  });

  it.each([
    ['no-root-stages', 'Every stage depends on another — no root stage to start.'],
    ['all-roots-started', 'Every root stage has already started.'],
  ])('explains why nothing started instead of surfacing the raw reason %s', (reason, copy) => {
    renderHook(() => useBatchRunActions(FLOW_ID, BATCH_ID, snap.runSingle));
    snap.onSuccess({ started: false, reason });
    expect(toast.info).toHaveBeenCalledWith(copy);
    expect(snap.runSingle).not.toHaveBeenCalled();
  });

  it('falls back to the caller copy for an unrecognised reason', () => {
    renderHook(() => useBatchRunActions(FLOW_ID, BATCH_ID, snap.runSingle));
    snap.onSuccess({ started: false, reason: 'some-future-code' });
    expect(vi.mocked(toast.info).mock.calls[0]?.[0]).not.toBe('some-future-code');
  });

  it('runs a single run when the server reports the batch has no stages', () => {
    renderHook(() => useBatchRunActions(FLOW_ID, BATCH_ID, snap.runSingle));
    snap.onSuccess({ started: false, reason: 'no-stages-defined' });
    expect(snap.runSingle).toHaveBeenCalledOnce();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('does not run a single run when the server actually started the batch', () => {
    renderHook(() => useBatchRunActions(FLOW_ID, BATCH_ID, snap.runSingle));
    snap.onSuccess({ started: true });
    expect(snap.runSingle).not.toHaveBeenCalled();
  });

  it('startBatch targets this batch', () => {
    snap.stages = [stageRow({ status: 'pending', completed_count: 0 })];
    const { result } = renderHook(() => useBatchRunActions(FLOW_ID, BATCH_ID, snap.runSingle));
    act(() => result.current.startBatch());
    expect(snap.startBatchMutate).toHaveBeenCalledWith({ flowId: FLOW_ID, batchId: BATCH_ID });
  });

  describe('unsaved canvas edits (batch runs use the saved version)', () => {
    function startWith(hadUnsavedChanges: boolean | undefined) {
      snap.stages = [stageRow({ status: 'pending', completed_count: 0 })];
      const { result } = renderHook(() => useBatchRunActions(FLOW_ID, BATCH_ID, snap.runSingle));
      act(() => result.current.startBatch(hadUnsavedChanges));
      return result;
    }

    it('a clean start keeps the plain "Batch started" copy', () => {
      startWith(false);
      snap.onSuccess({ started: true });
      expect(toast.success).toHaveBeenCalledExactlyOnceWith('Batch started');
      expect(toast.info).not.toHaveBeenCalled();
    });

    it('a dirty start says the unsaved edits are not included, in one toast', () => {
      startWith(true);
      snap.onSuccess({ started: true });
      expect(toast.success).toHaveBeenCalledExactlyOnceWith(
        "Batch started on the saved version — your unsaved edits aren't included",
      );
      expect(toast.info).not.toHaveBeenCalled();
    });

    it('a dirty start that queues nothing explains why, without an unsaved-edits notice', () => {
      startWith(true);
      snap.onSuccess({ started: false, reason: 'all-roots-started' });
      expect(toast.info).toHaveBeenCalledExactlyOnceWith('Every root stage has already started.');
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('a dirty start that falls back to a single run hands the dirty flag over (no batch toast)', () => {
      startWith(true);
      snap.onSuccess({ started: false, reason: 'no-stages-defined' });
      expect(snap.runSingle).toHaveBeenCalledExactlyOnceWith(true);
      expect(toast.info).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('a clean fallback single run is told the canvas was clean', () => {
      startWith(false);
      snap.onSuccess({ started: false, reason: 'no-stages-defined' });
      expect(snap.runSingle).toHaveBeenCalledExactlyOnceWith(false);
    });

    it('the dirty flag does not leak into the next clean start', () => {
      const result = startWith(true);
      snap.onSuccess({ started: true });
      act(() => result.current.startBatch(false));
      snap.onSuccess({ started: true });
      expect(vi.mocked(toast.success).mock.calls.at(-1)?.[0]).toBe('Batch started');
    });

    it('omitting the flag is treated as a clean start', () => {
      startWith(undefined);
      snap.onSuccess({ started: true });
      expect(toast.success).toHaveBeenCalledExactlyOnceWith('Batch started');
    });

    it('never sends the UI-only dirty flag to the server', () => {
      startWith(true);
      expect(snap.startBatchMutate).toHaveBeenCalledWith({ flowId: FLOW_ID, batchId: BATCH_ID });
    });
  });
});
