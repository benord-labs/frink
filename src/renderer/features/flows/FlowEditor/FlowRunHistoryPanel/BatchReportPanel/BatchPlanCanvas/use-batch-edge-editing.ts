/* eslint-disable max-lines, max-lines-per-function */
/**
 * Hook managing local dependency-edge state for the interactive batch DAG canvas.
 *
 * Responsibilities:
 * - Tracks local overrides to stage.depends_on_stage_ids (accumulated, not yet saved).
 * - Provides an undo stack (operation-based, local-only per the sc-619 spec).
 * - Client-side cycle detection via wouldNewEdgeCreateCycle from flow-graph-cycle.ts.
 * - isValidConnection for React Flow drag-time visual feedback.
 * - handleSave: stale-checks stage statuses, then calls flows.patchBatchStageDeps via tRPC.
 * - handleDiscard: resets local state to server data.
 * - Sets flowEditorDirtyAtom when dirty so useDirtyNavGuard prevents navigation.
 */

import type { Connection } from '@xyflow/react';
import { useSetAtom } from 'jotai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BatchStageDetail } from '../../../../../../../shared/types/flows/flow-batch';
import { wouldNewEdgeCreateCycle } from '../../../../../../../shared/lib/flow-graph-cycle';
import { flowEditorDirtyAtom } from '../../../../../../lib/atoms';
import { trpc } from '../../../../../../lib/trpc';
import { NON_SOURCE_STATUSES } from './constants';

/**
 * Mirrored client-side for immediate feedback before save.
 * Must match `MAX_FAN_IN` in `src/main/lib/flows/dag-validation.ts`.
 */
const MAX_FAN_IN = 10;

type UndoEntry = { type: 'add' | 'remove'; targetId: string; depId: string };

type BatchEdgeEditingHook = {
  /** Overridden dep map. Key = stageId, value = current depends_on_stage_ids. */
  localDeps: Map<string, string[]>;
  isDirty: boolean;
  canUndo: boolean;
  isSaving: boolean;
  /** Stage IDs that can receive new deps (pending only). */
  editableTargetIds: Set<string>;
  /** Stage IDs that can be a dep source (not failed/cancelled). */
  editableSourceIds: Set<string>;
  handleConnect: (connection: Connection) => void;
  isValidConnection: (connection: Connection) => boolean;
  handleDeleteEdge: (sourceId: string, targetId: string) => void;
  handleUndo: () => void;
  handleSave: () => Promise<void>;
  handleDiscard: () => void;
  /** Error message from last save attempt. null when no error. */
  saveError: string | null;
  clearSaveError: () => void;
};

function buildLocalDepsFromStages(stages: BatchStageDetail[]): Map<string, string[]> {
  return new Map(stages.map((s) => [s.id, [...s.depends_on_stage_ids]]));
}

function areDepsEqual(a: Map<string, string[]>, stages: BatchStageDetail[]): boolean {
  for (const stage of stages) {
    const local = a.get(stage.id);
    // Stage not in localDeps means it was added externally (e.g. by CEO agent) and the user
    // has not touched it. Treat as equal — do not mark dirty for externally added stages.
    if (local === undefined) continue;
    const server = stage.depends_on_stage_ids;
    if (local.length !== server.length) return false;
    const sortedLocal = [...local].sort();
    const sortedServer = [...server].sort();
    for (let i = 0; i < sortedLocal.length; i++) {
      if (sortedLocal[i] !== sortedServer[i]) return false;
    }
  }
  return true;
}

export function useBatchEdgeEditing(
  stages: BatchStageDetail[],
  flowId: string,
  batchId: string,
  /** Called after save completes (success OR partial failure) so the parent can invalidate tRPC cache. */
  onSaveSuccess?: () => void,
): BatchEdgeEditingHook {
  const { mutateAsync: patchBatchStageDeps } = trpc.flows.patchBatchStageDeps.useMutation();
  const setGlobalDirty = useSetAtom(flowEditorDirtyAtom);

  // Initialize localDeps from server data. Reset when server changes AND we're not dirty.
  const [localDeps, setLocalDeps] = useState<Map<string, string[]>>(() =>
    buildLocalDepsFromStages(stages),
  );
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Track the stages reference that initialised current localDeps so we can detect server refresh.
  const baseStagesRef = useRef(stages);

  /** True only after this hook called `setGlobalDirty(true)`; cleanup clears the atom iff this is set. */
  const ownedRef = useRef(false);

  // Sync with server when stages change externally AND no local edits have been made.
  const isDirty = useMemo(() => !areDepsEqual(localDeps, stages), [localDeps, stages]);

  useEffect(() => {
    if (baseStagesRef.current !== stages && !isDirty) {
      // Server data refreshed and no unsaved local edits — reset to server state.
      setLocalDeps(buildLocalDepsFromStages(stages));
      setUndoStack([]);
      baseStagesRef.current = stages;
    }
  }, [stages, isDirty]);

  // Sync dirty atom so useDirtyNavGuard prevents navigation while dirty.
  // IMPORTANT: only clear on cleanup if this hook instance called setGlobalDirty(true); do not use
  // a captured `isDirty` in cleanup (stale vs concurrent updates). Ownership is tracked in a ref.
  useEffect(() => {
    if (isDirty) {
      setGlobalDirty(true);
      ownedRef.current = true;
    }
    return () => {
      if (ownedRef.current) {
        setGlobalDirty(false);
        ownedRef.current = false;
      }
    };
  }, [isDirty, setGlobalDirty]);

  const editableTargetIds = useMemo(
    () => new Set(stages.filter((s) => s.status === 'pending').map((s) => s.id)),
    [stages],
  );

  const editableSourceIds = useMemo(
    () => new Set(stages.filter((s) => !NON_SOURCE_STATUSES.has(s.status)).map((s) => s.id)),
    [stages],
  );

  // Build FlowGraphLike from current localDeps for cycle detection.
  const buildFlowGraph = useCallback(
    (deps: Map<string, string[]>) => ({
      nodes: stages.map((s) => ({ id: s.id })),
      edges: Array.from(deps.entries()).flatMap(([targetId, depIds]) =>
        depIds.map((depId) => ({ id: `e-${depId}-${targetId}`, source: depId, target: targetId })),
      ),
    }),
    [stages],
  );

  const isValidConnection = useCallback(
    (connection: Connection): boolean => {
      const { source, target } = connection;
      if (!source || !target) return false;
      if (source === target) return false;
      if (!editableTargetIds.has(target)) return false;
      if (!editableSourceIds.has(source)) return false;
      const currentDeps = localDeps.get(target) ?? [];
      if (currentDeps.includes(source)) return false;
      // Fan-in: reject if target already has MAX_FAN_IN deps.
      if (currentDeps.length >= MAX_FAN_IN) return false;
      const graph = buildFlowGraph(localDeps);
      // Check cycle: would adding source→target create one?
      if (wouldNewEdgeCreateCycle(graph, source, target)) return false;
      return true;
    },
    [localDeps, editableTargetIds, editableSourceIds, buildFlowGraph, stages],
  );

  const handleConnect = useCallback(
    (connection: Connection): void => {
      const { source, target } = connection;
      if (!source || !target) return;
      if (!isValidConnection(connection)) return;
      setLocalDeps((prev) => {
        const next = new Map(prev);
        const deps = [...(next.get(target) ?? [])];
        deps.push(source);
        next.set(target, deps);
        return next;
      });
      setUndoStack((s) => [...s, { type: 'add', targetId: target, depId: source }]);
    },
    [isValidConnection],
  );

  const handleDeleteEdge = useCallback((sourceId: string, targetId: string): void => {
    setLocalDeps((prev) => {
      const next = new Map(prev);
      const deps = (next.get(targetId) ?? []).filter((d) => d !== sourceId);
      next.set(targetId, deps);
      return next;
    });
    setUndoStack((s) => [...s, { type: 'remove', targetId, depId: sourceId }]);
  }, []);

  const handleUndo = useCallback((): void => {
    setUndoStack((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (!last) return prev;
      setLocalDeps((deps) => {
        const next = new Map(deps);
        if (last.type === 'add') {
          // Undo an add: remove the dep.
          next.set(
            last.targetId,
            (next.get(last.targetId) ?? []).filter((d) => d !== last.depId),
          );
        } else {
          // Undo a remove: re-add the dep.
          next.set(last.targetId, [...(next.get(last.targetId) ?? []), last.depId]);
        }
        return next;
      });
      return prev.slice(0, -1);
    });
  }, []);

  const handleSave = useCallback(async (): Promise<void> => {
    setSaveError(null);

    // Stale-check: any edited stage that is no longer pending?
    const editedStageIds = stages
      .filter((stage) => {
        const local = localDeps.get(stage.id) ?? [];
        const server = stage.depends_on_stage_ids;
        if (local.length !== server.length) return true;
        const sortedLocal = [...local].sort();
        const sortedServer = [...server].sort();
        return sortedLocal.some((v, i) => v !== sortedServer[i]);
      })
      .map((s) => s.id);

    const staleStages = stages.filter(
      (s) => editedStageIds.includes(s.id) && s.status !== 'pending',
    );
    if (staleStages.length > 0) {
      const names = staleStages.map((s) => s.name ?? `Stage ${s.stage_number}`).join(', ');
      setSaveError(
        `Cannot save: the following stages are no longer pending and cannot be edited: ${names}`,
      );
      return;
    }

    if (editedStageIds.length === 0) return;

    setIsSaving(true);
    try {
      const result = await patchBatchStageDeps({
        flowId,
        // biome-ignore lint/style/useNamingConvention: DB field name
        batch_id: batchId,
        stages: editedStageIds.map((stageId) => ({
          // biome-ignore lint/style/useNamingConvention: DB field name
          stage_id: stageId,
          // biome-ignore lint/style/useNamingConvention: DB field name
          depends_on_stage_ids: localDeps.get(stageId) ?? [],
        })),
      });
      if (result.partial) {
        const ids = result.failedStageIds?.length ? `: ${result.failedStageIds.join(', ')}` : '';
        setSaveError(
          `Some dependency updates could not be saved${ids}. Refreshing from the server.`,
        );
      } else {
        // Full success: clear undo stack (server is now source of truth).
        setUndoStack([]);
      }
      // Invalidate so the client refetches — needed after full success, partial (207), or
      // when the main process maps a 500 body to an error (catch below also calls this).
      onSaveSuccess?.();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save dependencies');
      // Force refetch even on error — sequential UPDATEs may have partially applied,
      // so the UI must reflect real server state rather than showing the intended local state.
      onSaveSuccess?.();
    } finally {
      setIsSaving(false);
    }
  }, [stages, localDeps, flowId, batchId, onSaveSuccess, patchBatchStageDeps]);

  const handleDiscard = useCallback((): void => {
    setLocalDeps(buildLocalDepsFromStages(stages));
    setUndoStack([]);
    setSaveError(null);
    baseStagesRef.current = stages;
  }, [stages]);

  const clearSaveError = useCallback(() => setSaveError(null), []);

  return {
    localDeps,
    isDirty,
    canUndo: undoStack.length > 0,
    isSaving,
    editableTargetIds,
    editableSourceIds,
    handleConnect,
    isValidConnection,
    handleDeleteEdge,
    handleUndo,
    handleSave,
    handleDiscard,
    saveError,
    clearSaveError,
  };
}
