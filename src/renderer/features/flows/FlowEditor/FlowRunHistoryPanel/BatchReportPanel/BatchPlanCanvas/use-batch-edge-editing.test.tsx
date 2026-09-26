// @vitest-environment happy-dom
/**
 * useBatchEdgeEditing — unit tests.
 *
 * Covers connect validation, undo stack, dirty detection, discard reset,
 * isValidConnection mirrors handleConnect, and stale-detection before save.
 */

import '@testing-library/jest-dom/vitest';
import { act, renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BatchStageDetail } from '../../../../../../../shared/types/flows/flow-batch';
import { flowEditorDirtyAtom } from '../../../../../../lib/atoms';

// ── Mock trpc.flows.patchBatchStageDeps ───────────────────────────────────────

const mockPatch = vi.fn().mockResolvedValue({ updated: 1 });
vi.mock('../../../../../../lib/trpc', () => ({
  trpc: {
    flows: {
      patchBatchStageDeps: {
        useMutation: () => ({
          mutateAsync: mockPatch,
        }),
      },
    },
  },
}));

// ── Load hook after mocks ─────────────────────────────────────────────────────

const { useBatchEdgeEditing } = await import('./use-batch-edge-editing');

// ── Helpers ──────────────────────────────────────────────────────────────────

const FLOW_ID = 'flow-1';
const BATCH_ID = 'batch-1';

const STAGE_A = 'aaaa-aaaa';
const STAGE_B = 'bbbb-bbbb';
const STAGE_C = 'cccc-cccc';

function makeStage(id: string, status = 'pending', depIds: string[] = []): BatchStageDetail {
  return {
    id,
    stage_number: 1,
    name: null,
    status,
    failure_threshold: 0,
    depends_on_stage_ids: depIds,
    depends_on_stage_numbers: [],
    run_count: 0,
    completed_count: 0,
    failed_count: 0,
    active_count: 0,
    attention_count: 0,
    pending_count: 0,
    latest_chat_id: null,
    workstream_ids: [],
  };
}

function makeConn(source: string, target: string) {
  return { source, target, sourceHandle: null, targetHandle: null };
}

function renderWithJotai(stages: BatchStageDetail[]) {
  const store = createStore();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(Provider, { store }, children);
  return renderHook(() => useBatchEdgeEditing(stages, FLOW_ID, BATCH_ID), { wrapper });
}

/** Like renderWithJotai but exposes the jotai store for atom inspection. */
function renderWithStore(stages: BatchStageDetail[]) {
  const store = createStore();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(Provider, { store }, children);
  const handle = renderHook(() => useBatchEdgeEditing(stages, FLOW_ID, BATCH_ID), { wrapper });
  return { ...handle, store };
}

/**
 * Like renderWithJotai but allows stages to be updated mid-test (simulates
 * the tRPC polling query returning new data from the server).
 */
function renderWithDynamicStages(initialStages: BatchStageDetail[]) {
  let currentStages = initialStages;
  const store = createStore();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(Provider, { store }, children);
  const handle = renderHook(() => useBatchEdgeEditing(currentStages, FLOW_ID, BATCH_ID), {
    wrapper,
  });
  return {
    ...handle,
    store,
    updateStages: (newStages: BatchStageDetail[]) => {
      currentStages = newStages;
      handle.rerender();
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

// ── Connect validation ────────────────────────────────────────────────────────

describe('useBatchEdgeEditing — connect validation', () => {
  it('valid connection: adds dep and marks dirty', () => {
    const { result } = renderWithJotai([makeStage(STAGE_A), makeStage(STAGE_B)]);
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    expect(result.current.isDirty).toBe(true);
    expect(result.current.localDeps.get(STAGE_B)).toContain(STAGE_A);
  });

  it('self-edge: rejected (source === target)', () => {
    const { result } = renderWithJotai([makeStage(STAGE_A)]);
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_A)));
    expect(result.current.isDirty).toBe(false);
  });

  it('duplicate edge: rejected when dep already exists', () => {
    const { result } = renderWithJotai([
      makeStage(STAGE_A),
      makeStage(STAGE_B, 'pending', [STAGE_A]),
    ]);
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    expect(result.current.isDirty).toBe(false);
  });

  it('non-pending target: rejected', () => {
    const { result } = renderWithJotai([makeStage(STAGE_A), makeStage(STAGE_B, 'running')]);
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    expect(result.current.isDirty).toBe(false);
  });

  it('failed source: rejected', () => {
    const { result } = renderWithJotai([makeStage(STAGE_A, 'failed'), makeStage(STAGE_B)]);
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    expect(result.current.isDirty).toBe(false);
  });

  it('cancelled source: rejected', () => {
    const { result } = renderWithJotai([makeStage(STAGE_A, 'cancelled'), makeStage(STAGE_B)]);
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    expect(result.current.isDirty).toBe(false);
  });

  it('cycle detection: C already depends on B, adding B dep on C is rejected', () => {
    const { result } = renderWithJotai([
      makeStage(STAGE_B),
      makeStage(STAGE_C, 'pending', [STAGE_B]),
    ]);
    act(() => result.current.handleConnect(makeConn(STAGE_C, STAGE_B)));
    expect(result.current.isDirty).toBe(false);
  });

  it('completed source: accepted (completed stage can be dep source)', () => {
    const { result } = renderWithJotai([makeStage(STAGE_A, 'completed'), makeStage(STAGE_B)]);
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    expect(result.current.isDirty).toBe(true);
    expect(result.current.localDeps.get(STAGE_B)).toContain(STAGE_A);
  });

  it('running source: accepted', () => {
    const { result } = renderWithJotai([makeStage(STAGE_A, 'running'), makeStage(STAGE_B)]);
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    expect(result.current.isDirty).toBe(true);
  });
});

// ── isValidConnection mirrors handleConnect ───────────────────────────────────

describe('useBatchEdgeEditing — isValidConnection', () => {
  it('returns true for valid connection', () => {
    const { result } = renderWithJotai([makeStage(STAGE_A), makeStage(STAGE_B)]);
    expect(result.current.isValidConnection(makeConn(STAGE_A, STAGE_B))).toBe(true);
  });

  it('returns false for self-edge', () => {
    const { result } = renderWithJotai([makeStage(STAGE_A)]);
    expect(result.current.isValidConnection(makeConn(STAGE_A, STAGE_A))).toBe(false);
  });

  it('returns false for non-pending target', () => {
    const { result } = renderWithJotai([makeStage(STAGE_A), makeStage(STAGE_B, 'completed')]);
    expect(result.current.isValidConnection(makeConn(STAGE_A, STAGE_B))).toBe(false);
  });

  it('returns false for failed source', () => {
    const { result } = renderWithJotai([makeStage(STAGE_A, 'failed'), makeStage(STAGE_B)]);
    expect(result.current.isValidConnection(makeConn(STAGE_A, STAGE_B))).toBe(false);
  });

  it('returns false for cycle attempt (C already depends on B, adding C as dep for B)', () => {
    const { result } = renderWithJotai([
      makeStage(STAGE_B),
      makeStage(STAGE_C, 'pending', [STAGE_B]),
    ]);
    expect(result.current.isValidConnection(makeConn(STAGE_C, STAGE_B))).toBe(false);
  });
});

// ── Undo stack ────────────────────────────────────────────────────────────────

describe('useBatchEdgeEditing — undo', () => {
  it('canUndo is false initially', () => {
    const { result } = renderWithJotai([makeStage(STAGE_A), makeStage(STAGE_B)]);
    expect(result.current.canUndo).toBe(false);
  });

  it('canUndo becomes true after a connection', () => {
    const { result } = renderWithJotai([makeStage(STAGE_A), makeStage(STAGE_B)]);
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    expect(result.current.canUndo).toBe(true);
  });

  it('handleUndo reverses an add', () => {
    const { result } = renderWithJotai([makeStage(STAGE_A), makeStage(STAGE_B)]);
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    act(() => result.current.handleUndo());
    expect(result.current.isDirty).toBe(false);
    expect(result.current.localDeps.get(STAGE_B)).not.toContain(STAGE_A);
  });

  it('handleUndo reverses a delete', () => {
    const { result } = renderWithJotai([
      makeStage(STAGE_A),
      makeStage(STAGE_B, 'pending', [STAGE_A]),
    ]);
    act(() => result.current.handleDeleteEdge(STAGE_A, STAGE_B));
    expect(result.current.isDirty).toBe(true);
    act(() => result.current.handleUndo());
    expect(result.current.isDirty).toBe(false);
    expect(result.current.localDeps.get(STAGE_B)).toContain(STAGE_A);
  });

  it('canUndo is false after full undo', () => {
    const { result } = renderWithJotai([makeStage(STAGE_A), makeStage(STAGE_B)]);
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    act(() => result.current.handleUndo());
    expect(result.current.canUndo).toBe(false);
  });
});

// ── Dirty detection ───────────────────────────────────────────────────────────

describe('useBatchEdgeEditing — dirty detection', () => {
  it('not dirty initially', () => {
    const { result } = renderWithJotai([makeStage(STAGE_A), makeStage(STAGE_B)]);
    expect(result.current.isDirty).toBe(false);
  });

  it('dirty after adding edge', () => {
    const { result } = renderWithJotai([makeStage(STAGE_A), makeStage(STAGE_B)]);
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    expect(result.current.isDirty).toBe(true);
  });

  it('dirty after deleting edge', () => {
    const { result } = renderWithJotai([
      makeStage(STAGE_A),
      makeStage(STAGE_B, 'pending', [STAGE_A]),
    ]);
    act(() => result.current.handleDeleteEdge(STAGE_A, STAGE_B));
    expect(result.current.isDirty).toBe(true);
  });
});

// ── Discard ───────────────────────────────────────────────────────────────────

describe('useBatchEdgeEditing — discard', () => {
  it('resets localDeps to server state after discard', () => {
    const { result } = renderWithJotai([makeStage(STAGE_A), makeStage(STAGE_B)]);
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    act(() => result.current.handleDiscard());
    expect(result.current.isDirty).toBe(false);
    expect(result.current.localDeps.get(STAGE_B)).toEqual([]);
  });

  it('clears undo stack after discard', () => {
    const { result } = renderWithJotai([makeStage(STAGE_A), makeStage(STAGE_B)]);
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    act(() => result.current.handleDiscard());
    expect(result.current.canUndo).toBe(false);
  });
});

// ── handleSave ────────────────────────────────────────────────────────────────

describe('useBatchEdgeEditing — save', () => {
  it('calls patchBatchStageDeps with correct payload', async () => {
    const { result } = renderWithJotai([makeStage(STAGE_A), makeStage(STAGE_B)]);
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    await act(() => result.current.handleSave());
    expect(mockPatch).toHaveBeenCalledOnce();
    const payload = mockPatch.mock.calls[0]?.[0] as {
      flowId: string;
      batch_id: string;
      stages: Array<{ stage_id: string; depends_on_stage_ids: string[] }>;
    };
    expect(payload.flowId).toBe(FLOW_ID);
    expect(payload.batch_id).toBe(BATCH_ID);
    expect(payload.stages).toHaveLength(1);
    expect(payload.stages[0]?.stage_id).toBe(STAGE_B);
    expect(payload.stages[0]?.depends_on_stage_ids).toContain(STAGE_A);
  });

  it('does not call patchBatchStageDeps when not dirty', async () => {
    const { result } = renderWithJotai([makeStage(STAGE_A), makeStage(STAGE_B)]);
    await act(() => result.current.handleSave());
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('sets saveError and preserves local state when patch rejects', async () => {
    mockPatch.mockRejectedValueOnce(new Error('Network error'));
    const { result } = renderWithJotai([makeStage(STAGE_A), makeStage(STAGE_B)]);
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    await act(() => result.current.handleSave());
    expect(result.current.saveError).toMatch(/Network error/);
    expect(result.current.isDirty).toBe(true);
  });

  it('calls onSaveSuccess on successful save (triggers parent tRPC invalidation)', async () => {
    const onSaveSuccess = vi.fn();
    const store = createStore();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(Provider, { store }, children);
    const { result } = renderHook(
      () =>
        useBatchEdgeEditing(
          [makeStage(STAGE_A), makeStage(STAGE_B)],
          FLOW_ID,
          BATCH_ID,
          onSaveSuccess,
        ),
      { wrapper },
    );
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    await act(() => result.current.handleSave());
    expect(onSaveSuccess).toHaveBeenCalledOnce();
  });

  it('clears undo stack after full success (partial false or omitted)', async () => {
    mockPatch.mockResolvedValueOnce({ updated: 1, partial: false });
    const { result } = renderWithJotai([makeStage(STAGE_A), makeStage(STAGE_B)]);
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    expect(result.current.canUndo).toBe(true);
    await act(() => result.current.handleSave());
    expect(result.current.canUndo).toBe(false);
  });

  it('partial API response (207): sets saveError, keeps undo stack, calls onSaveSuccess', async () => {
    mockPatch.mockResolvedValueOnce({
      updated: 1,
      partial: true,
      failedStageIds: [STAGE_B],
    });
    const onSaveSuccess = vi.fn();
    const store = createStore();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(Provider, { store }, children);
    const { result } = renderHook(
      () =>
        useBatchEdgeEditing(
          [makeStage(STAGE_A), makeStage(STAGE_B)],
          FLOW_ID,
          BATCH_ID,
          onSaveSuccess,
        ),
      { wrapper },
    );
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    await act(() => result.current.handleSave());
    expect(result.current.saveError).toMatch(/Some dependency updates could not be saved/);
    expect(result.current.saveError).toContain(STAGE_B);
    expect(result.current.canUndo).toBe(true);
    expect(onSaveSuccess).toHaveBeenCalledOnce();
  });

  it('calls onSaveSuccess even when patch rejects (forces refetch of real server state)', async () => {
    mockPatch.mockRejectedValueOnce(new Error('fail'));
    const onSaveSuccess = vi.fn();
    const store = createStore();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(Provider, { store }, children);
    const { result } = renderHook(
      () =>
        useBatchEdgeEditing(
          [makeStage(STAGE_A), makeStage(STAGE_B)],
          FLOW_ID,
          BATCH_ID,
          onSaveSuccess,
        ),
      { wrapper },
    );
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    await act(() => result.current.handleSave());
    expect(onSaveSuccess).toHaveBeenCalledOnce();
  });

  it('clears saveError after clearSaveError', async () => {
    mockPatch.mockRejectedValueOnce(new Error('fail'));
    const { result } = renderWithJotai([makeStage(STAGE_A), makeStage(STAGE_B)]);
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    await act(() => result.current.handleSave());
    expect(result.current.saveError).not.toBeNull();
    act(() => result.current.clearSaveError());
    expect(result.current.saveError).toBeNull();
  });
});

// ── editableTargetIds / editableSourceIds ─────────────────────────────────────

describe('useBatchEdgeEditing — editable ID sets', () => {
  it('editableTargetIds contains only pending stages', () => {
    const { result } = renderWithJotai([
      makeStage(STAGE_A, 'pending'),
      makeStage(STAGE_B, 'running'),
      makeStage(STAGE_C, 'completed'),
    ]);
    expect(result.current.editableTargetIds.has(STAGE_A)).toBe(true);
    expect(result.current.editableTargetIds.has(STAGE_B)).toBe(false);
    expect(result.current.editableTargetIds.has(STAGE_C)).toBe(false);
  });

  it('editableSourceIds excludes failed and cancelled', () => {
    const { result } = renderWithJotai([
      makeStage(STAGE_A, 'pending'),
      makeStage(STAGE_B, 'failed'),
      makeStage(STAGE_C, 'cancelled'),
    ]);
    expect(result.current.editableSourceIds.has(STAGE_A)).toBe(true);
    expect(result.current.editableSourceIds.has(STAGE_B)).toBe(false);
    expect(result.current.editableSourceIds.has(STAGE_C)).toBe(false);
  });
});

// ── flowEditorDirtyAtom integrity ─────────────────────────────────────────────

describe('useBatchEdgeEditing — flowEditorDirtyAtom integrity', () => {
  it('does NOT clear pre-existing flowEditorDirtyAtom=true when hook mounts with isDirty=false', () => {
    const { store } = renderWithStore([makeStage(STAGE_A), makeStage(STAGE_B)]);
    // Simulate: flow graph editor has unsaved changes — atom was set true before mount
    store.set(flowEditorDirtyAtom, true);

    // Mount a second hook instance using the same store (atom already true)
    const wrapper2 = ({ children }: { children: ReactNode }) =>
      createElement(Provider, { store }, children);
    renderHook(
      () => useBatchEdgeEditing([makeStage(STAGE_A), makeStage(STAGE_B)], FLOW_ID, BATCH_ID),
      {
        wrapper: wrapper2,
      },
    );

    // Pre-existing dirty flag from flow graph editor must NOT be clobbered
    expect(store.get(flowEditorDirtyAtom)).toBe(true);
  });

  it('sets flowEditorDirtyAtom=true when this hook becomes dirty', () => {
    const { result, store } = renderWithStore([makeStage(STAGE_A), makeStage(STAGE_B)]);
    expect(store.get(flowEditorDirtyAtom)).toBe(false);
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    expect(store.get(flowEditorDirtyAtom)).toBe(true);
  });

  it('clears flowEditorDirtyAtom when hook transitions from dirty to not dirty (discard)', () => {
    const { result, store } = renderWithStore([makeStage(STAGE_A), makeStage(STAGE_B)]);
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    expect(store.get(flowEditorDirtyAtom)).toBe(true);
    act(() => result.current.handleDiscard());
    expect(store.get(flowEditorDirtyAtom)).toBe(false);
  });

  it('clears flowEditorDirtyAtom on unmount when this hook had set it dirty (owned cleanup)', () => {
    const { result, store, unmount } = renderWithStore([makeStage(STAGE_A), makeStage(STAGE_B)]);
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    expect(store.get(flowEditorDirtyAtom)).toBe(true);
    unmount();
    expect(store.get(flowEditorDirtyAtom)).toBe(false);
  });

  it('clears flowEditorDirtyAtom after server stages catch up following full save (mounted)', async () => {
    mockPatch.mockResolvedValueOnce({ updated: 1, partial: false });
    const store = createStore();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(Provider, { store }, children);
    const { result, rerender } = renderHook(
      ({ stages }: { stages: BatchStageDetail[] }) =>
        useBatchEdgeEditing(stages, FLOW_ID, BATCH_ID),
      {
        wrapper,
        initialProps: { stages: [makeStage(STAGE_A), makeStage(STAGE_B)] },
      },
    );
    act(() => result.current.handleConnect(makeConn(STAGE_A, STAGE_B)));
    expect(store.get(flowEditorDirtyAtom)).toBe(true);
    await act(() => result.current.handleSave());
    expect(result.current.canUndo).toBe(false);
    rerender({
      stages: [makeStage(STAGE_A), makeStage(STAGE_B, 'pending', [STAGE_A])],
    });
    expect(result.current.isDirty).toBe(false);
    expect(store.get(flowEditorDirtyAtom)).toBe(false);
  });

  it('does NOT clear flowEditorDirtyAtom=true set by another editor on unmount if this hook was never dirty', () => {
    const { store, unmount } = renderWithStore([makeStage(STAGE_A), makeStage(STAGE_B)]);
    store.set(flowEditorDirtyAtom, true); // set externally after mount
    unmount();
    // The hook never set it to true, so unmount cleanup must not clear it
    expect(store.get(flowEditorDirtyAtom)).toBe(true);
  });
});

// ── Server state sync (CEO agent adds stage externally) ───────────────────────

describe('useBatchEdgeEditing — server state sync with new external stage', () => {
  it('isDirty remains false when server adds a new stage the user has not touched', () => {
    const { result, updateStages } = renderWithDynamicStages([
      makeStage(STAGE_A),
      makeStage(STAGE_B),
    ]);
    expect(result.current.isDirty).toBe(false);

    // CEO agent defines a new stage — polling returns updated stages
    act(() => updateStages([makeStage(STAGE_A), makeStage(STAGE_B), makeStage(STAGE_C)]));

    // User made no edits — should NOT appear dirty or show Save/Discard toolbar
    expect(result.current.isDirty).toBe(false);
  });

  it('localDeps is updated to include the new stage after server sync', () => {
    const { result, updateStages } = renderWithDynamicStages([
      makeStage(STAGE_A),
      makeStage(STAGE_B),
    ]);

    act(() => updateStages([makeStage(STAGE_A), makeStage(STAGE_B), makeStage(STAGE_C)]));

    // After sync, localDeps should include the new stage so isValidConnection works correctly
    expect(result.current.localDeps.has(STAGE_C)).toBe(true);
  });
});

// ── Max fan-in / max depth client-side validation ─────────────────────────────

describe('useBatchEdgeEditing — isValidConnection: fan-in and depth limits', () => {
  it('returns false when adding edge would give target more than 10 deps (fan-in > MAX_FAN_IN)', () => {
    // 10 existing dep stages
    const existingDeps = Array.from({ length: 10 }, (_, i) => `dep-${i}`);
    const depStages = existingDeps.map((id) => makeStage(id, 'completed'));
    // stageB already has 10 deps
    const stageB = makeStage(STAGE_B, 'pending', existingDeps);
    // One more potential source
    const stageA = makeStage(STAGE_A, 'completed');

    const { result } = renderWithJotai([stageA, ...depStages, stageB]);

    // Adding STAGE_A → STAGE_B would be the 11th dep — server rejects with 400
    expect(result.current.isValidConnection(makeConn(STAGE_A, STAGE_B))).toBe(false);
  });

  it('allows a connection that brings fan-in to exactly 10 (boundary)', () => {
    // 9 existing dep stages
    const existingDeps = Array.from({ length: 9 }, (_, i) => `dep-${i}`);
    const depStages = existingDeps.map((id) => makeStage(id, 'completed'));
    const stageB = makeStage(STAGE_B, 'pending', existingDeps);
    const stageA = makeStage(STAGE_A, 'completed');

    const { result } = renderWithJotai([stageA, ...depStages, stageB]);

    // 10th dep is allowed
    expect(result.current.isValidConnection(makeConn(STAGE_A, STAGE_B))).toBe(true);
  });

  it('allows connections that produce chains of any depth (no MAX_DEPTH limit)', () => {
    // 100-stage linear chain: stage-1 → ... → stage-100
    // MAX_DEPTH was removed (sc-645); deep chains must be accepted.
    const chain = Array.from({ length: 100 }, (_, i) => {
      const id = `c${i + 1}`;
      const deps = i > 0 ? [`c${i}`] : [];
      return makeStage(id, 'completed', deps);
    });
    const stage101 = makeStage('c101', 'pending');

    const { result } = renderWithJotai([...chain, stage101]);

    expect(result.current.isValidConnection(makeConn('c100', 'c101'))).toBe(true);
  });
});
