/* eslint-disable max-lines, max-lines-per-function */
/**
 * Hook for real-time canvas execution overlay in the FlowEditor.
 *
 * Subscribes to flow execution events from the main process and updates
 * per-node Jotai atoms so only affected nodes re-render.
 *
 * Mount once per FlowEditor instance. Pass `flowId` to scope updates to the
 * current flow only.
 */

import { type MutableRefObject, useCallback, useEffect, useRef } from 'react';
import type { DbFlowRunWithNodeRuns, DbNodeRun } from '../../shared/types/flow-run';
import type { FlowExecutionEvent } from '../../shared/types/flow';
import {
  flowCanvasExecutionAtom,
  flowLoopProgressAtomFamily,
  nodeExecAtomFamily,
} from '../features/flows/atoms';
import {
  ACTIVE_NODE_STATUSES,
  type CanvasOverlayNodeState,
  mergeNodeRunsForCanvas,
} from '../lib/flows/canvas-node-merge';
import { appStore } from '../lib/jotai-store';
import { isDesktopApp } from '../lib/utils/platform';

/** Minimum duration (ms) a node stays in the "running" state before transitioning. */
const MIN_RUNNING_DISPLAY_MS = 300;

/**
 * Multiple FlowEditor surfaces can mount `useFlowCanvasExecution` for the same `flowId`
 * (e.g. split view). Ref-count so the first unmount does not wipe shared overlay state.
 * Min-display timeouts are also shared per `flowId` so `clearOverlay` / `run_started` cancel
 * pending transitions from any mounted instance (avoids a stale timer resurrecting atoms).
 */
const flowCanvasExecutionMountCount = new Map<string, number>();
const flowCanvasExecutionOverlayNodeIds = new Map<string, Set<string>>();
/** Pending min-display timeouts: shared per `flowId` so `clearOverlay` / `run_started` cancel any instance's timers. */
const flowCanvasExecutionPendingTimeouts = new Map<
  string,
  Map<string, ReturnType<typeof setTimeout>>
>();

function clearPendingTimeoutsForFlow(flowId: string): void {
  const m = flowCanvasExecutionPendingTimeouts.get(flowId);
  if (!m) return;
  for (const [, t] of m) clearTimeout(t);
  flowCanvasExecutionPendingTimeouts.delete(flowId);
}

function cancelPendingTimeout(flowId: string, key: string): void {
  const m = flowCanvasExecutionPendingTimeouts.get(flowId);
  if (!m) return;
  const t = m.get(key);
  if (t === undefined) return;
  clearTimeout(t);
  m.delete(key);
  if (m.size === 0) flowCanvasExecutionPendingTimeouts.delete(flowId);
}

function schedulePendingTimeout(
  flowId: string,
  key: string,
  delayMs: number,
  onFire: () => void,
): void {
  cancelPendingTimeout(flowId, key);
  let m = flowCanvasExecutionPendingTimeouts.get(flowId);
  if (!m) {
    m = new Map();
    flowCanvasExecutionPendingTimeouts.set(flowId, m);
  }
  const timer = setTimeout(() => {
    cancelPendingTimeout(flowId, key);
    onFire();
  }, delayMs);
  m.set(key, timer);
}

/**
 * Reset module-level maps (Vitest `beforeEach` — avoids bleed when tests forget to unmount every hook).
 * @internal — not for app/runtime use.
 */
export function resetFlowCanvasExecutionSharedState(): void {
  for (const m of flowCanvasExecutionPendingTimeouts.values()) {
    for (const t of m.values()) clearTimeout(t);
  }
  flowCanvasExecutionPendingTimeouts.clear();
  flowCanvasExecutionMountCount.clear();
  flowCanvasExecutionOverlayNodeIds.clear();
  /** Vitest default flowId — keeps flowLoopProgressAtomFamily from bleeding across tests. */
  appStore.set(flowLoopProgressAtomFamily('flow-1'), null);
}

function registerFlowCanvasExecutionMount(flowId: string): void {
  flowCanvasExecutionMountCount.set(flowId, (flowCanvasExecutionMountCount.get(flowId) ?? 0) + 1);
}

/** @returns subscribers remaining after this unmount */
function unregisterFlowCanvasExecutionMount(flowId: string): number {
  const current = flowCanvasExecutionMountCount.get(flowId) ?? 1;
  const next = current - 1;
  if (next <= 0) {
    flowCanvasExecutionMountCount.delete(flowId);
    return 0;
  }
  flowCanvasExecutionMountCount.set(flowId, next);
  return next;
}

function ensureOverlayNodeSet(flowId: string): Set<string> {
  let set = flowCanvasExecutionOverlayNodeIds.get(flowId);
  if (!set) {
    set = new Set();
    flowCanvasExecutionOverlayNodeIds.set(flowId, set);
  }
  return set;
}

function noteOverlayNode(flowId: string, nodeId: string): void {
  ensureOverlayNodeSet(flowId).add(nodeId);
}

function nodeKey(flowId: string, nodeId: string): string {
  return `${flowId}:${nodeId}`;
}

/** Clear all node exec atoms for a given flowId. */
function clearFlowNodeAtoms(flowId: string, nodeIds: string[]): void {
  for (const nodeId of nodeIds) {
    appStore.set(nodeExecAtomFamily(nodeKey(flowId, nodeId)), null);
  }
}

function wipeTrackedOverlayNodes(
  flowId: string,
  trackedNodeIdsRef: MutableRefObject<Set<string>>,
): void {
  clearPendingTimeoutsForFlow(flowId);
  const overlayIds = ensureOverlayNodeSet(flowId);
  clearFlowNodeAtoms(flowId, [...overlayIds]);
  overlayIds.clear();
  trackedNodeIdsRef.current.clear();
}

function applyMergedNodeStatesToAtoms(
  flowId: string,
  merged: Map<string, CanvasOverlayNodeState>,
  trackedNodeIdsRef: MutableRefObject<Set<string>>,
): void {
  for (const [nodeId, { status, loopIteration, loopTotalCount }] of merged) {
    trackedNodeIdsRef.current.add(nodeId);
    noteOverlayNode(flowId, nodeId);
    const key = nodeKey(flowId, nodeId);
    cancelPendingTimeout(flowId, key);

    if (status === 'running') {
      appStore.set(nodeExecAtomFamily(key), {
        status: 'running',
        loopIteration,
        loopTotalCount,
        runningUntil: Date.now() + MIN_RUNNING_DISPLAY_MS,
      });
    } else {
      appStore.set(nodeExecAtomFamily(key), { status, loopIteration, loopTotalCount });
    }
  }
}

/** True when any active node row uses parallel fan-out lanes (lane_index + parent link). */
function hasActiveParallelFanOutLane(nodeRuns: DbNodeRun[]): boolean {
  return nodeRuns.some(
    (r) =>
      ACTIVE_NODE_STATUSES.has(r.status) &&
      r.parent_fan_out_node_run_id != null &&
      r.lane_index != null,
  );
}

/**
 * Run History `#N/T` matches sequential fan-out only. Live events gate on `fanOutNodeId`;
 * rehydration must skip parallel lane-based loopIteration (lane index ≠ iteration).
 */
function applyFlowLoopProgressFromMerged(
  flowId: string,
  merged: Map<string, CanvasOverlayNodeState>,
  nodeRuns: DbNodeRun[],
): void {
  if (hasActiveParallelFanOutLane(nodeRuns)) {
    appStore.set(flowLoopProgressAtomFamily(flowId), null);
    return;
  }

  let bestIter: number | undefined;
  let bestTotal: number | undefined;
  for (const [, s] of merged) {
    if (s.loopIteration != null && s.loopTotalCount != null) {
      if (bestIter == null || s.loopIteration > bestIter) {
        bestIter = s.loopIteration;
        bestTotal = s.loopTotalCount;
      }
    }
  }
  appStore.set(
    flowLoopProgressAtomFamily(flowId),
    bestIter != null && bestTotal != null
      ? { loopIteration: bestIter, loopTotalCount: bestTotal }
      : null,
  );
}

type FlowCanvasExecutionControls = {
  /** Clears the execution overlay for this flow (run-level state + all tracked node atoms). */
  clearOverlay: () => void;
  /**
   * Restore canvas overlay from GET /flow-runs/:id (e.g. after navigating away and back).
   * No-op if the run is not `running` or if this flow already has execution state in atoms.
   */
  rehydrateFromRun: (run: DbFlowRunWithNodeRuns) => void;
  /**
   * Paint node statuses from any completed or running run (e.g. run history inspection).
   * Replaces the current overlay. Live `run_started` events still take over afterward.
   */
  viewRunOnCanvas: (run: DbFlowRunWithNodeRuns) => void;
};

export function useFlowCanvasExecution(flowId: string): FlowCanvasExecutionControls {
  // Track which node IDs we've written atoms for (to support cleanup)
  const trackedNodeIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!isDesktopApp()) return;
    if (!window.desktopApi?.onSocketFlowExecutionEvent) return;

    registerFlowCanvasExecutionMount(flowId);

    const unsubscribe = window.desktopApi.onSocketFlowExecutionEvent(
      (event: FlowExecutionEvent) => {
        if (event.flowId !== flowId) return;

        const {
          eventType,
          flowRunId,
          nodeId,
          nodeStatuses,
          loopIteration,
          loopTotalCount,
          fanOutNodeId,
        } = event;
        // Run-scoped painting only — batch_completed has no flowRunId and no
        // canvas of its own.
        if (!flowRunId) return;

        if (eventType === 'run_started') {
          wipeTrackedOverlayNodes(flowId, trackedNodeIdsRef);
          appStore.set(flowLoopProgressAtomFamily(flowId), null);
          appStore.set(flowCanvasExecutionAtom, (prev) => ({
            ...prev,
            [flowId]: { flowRunId, isLive: true, isHistoricalInspection: false },
          }));
          return;
        }

        if (
          eventType === 'run_completed' ||
          eventType === 'run_failed' ||
          eventType === 'run_cancelled'
        ) {
          const currentExec = appStore.get(flowCanvasExecutionAtom)[flowId];
          if (currentExec && currentExec.flowRunId !== flowRunId) {
            return;
          }
          appStore.set(flowCanvasExecutionAtom, (prev) => ({
            ...prev,
            [flowId]: { flowRunId, isLive: false, isHistoricalInspection: false },
          }));
          appStore.set(flowLoopProgressAtomFamily(flowId), null);

          // Reconcile final node states from nodeStatuses (handles missed events during reconnect)
          if (nodeStatuses) {
            for (const [nid, { status }] of Object.entries(nodeStatuses)) {
              if (status === 'completed' || status === 'failed' || status === 'skipped') {
                const key = nodeKey(flowId, nid);
                trackedNodeIdsRef.current.add(nid);
                noteOverlayNode(flowId, nid);
                cancelPendingTimeout(flowId, key);
                const prevAtom = appStore.get(nodeExecAtomFamily(key));
                appStore.set(nodeExecAtomFamily(key), {
                  status: status as 'completed' | 'failed' | 'skipped',
                  loopIteration: prevAtom?.loopIteration,
                  loopTotalCount: prevAtom?.loopTotalCount,
                });
              }
            }
          }
          return;
        }

        if (eventType === 'run_paused') {
          // Paint the parked node(s) as themselves (awaiting_input/blocked) so a waiting flow
          // stops masquerading as running. The run stays live — a resume keeps painting on top.
          const currentExec = appStore.get(flowCanvasExecutionAtom)[flowId];
          if (currentExec && currentExec.flowRunId !== flowRunId) return;
          if (!nodeStatuses) return;
          for (const [nid, { status }] of Object.entries(nodeStatuses)) {
            if (status !== 'awaiting_input' && status !== 'blocked') continue;
            const key = nodeKey(flowId, nid);
            trackedNodeIdsRef.current.add(nid);
            noteOverlayNode(flowId, nid);
            cancelPendingTimeout(flowId, key);
            const prevAtom = appStore.get(nodeExecAtomFamily(key));
            appStore.set(nodeExecAtomFamily(key), {
              status,
              loopIteration: prevAtom?.loopIteration,
              loopTotalCount: prevAtom?.loopTotalCount,
            });
          }
          return;
        }

        if (!nodeId) return;

        const flowExecSnapshot = appStore.get(flowCanvasExecutionAtom)[flowId];
        if (
          flowExecSnapshot &&
          (!flowExecSnapshot.isLive || flowExecSnapshot.flowRunId !== flowRunId)
        ) {
          return;
        }

        const key = nodeKey(flowId, nodeId);
        trackedNodeIdsRef.current.add(nodeId);
        noteOverlayNode(flowId, nodeId);

        if (eventType === 'node_started') {
          cancelPendingTimeout(flowId, key);
          appStore.set(nodeExecAtomFamily(key), {
            status: 'running',
            loopIteration,
            loopTotalCount,
            runningUntil: Date.now() + MIN_RUNNING_DISPLAY_MS,
          });
          if (fanOutNodeId && loopIteration != null) {
            const fanOutKey = nodeKey(flowId, fanOutNodeId);
            trackedNodeIdsRef.current.add(fanOutNodeId);
            noteOverlayNode(flowId, fanOutNodeId);
            cancelPendingTimeout(flowId, fanOutKey);
            appStore.set(nodeExecAtomFamily(fanOutKey), {
              status: 'running',
              loopIteration,
              loopTotalCount,
              runningUntil: Date.now() + MIN_RUNNING_DISPLAY_MS,
            });
            // fanOutNodeId is only present on sequential fan-out body node events.
            // Parallel fan-out omits it, so the Run History badge is intentionally skipped there
            // (parallel lanes run simultaneously; showing #N/T would be misleading).
            if (loopTotalCount != null) {
              appStore.set(flowLoopProgressAtomFamily(flowId), { loopIteration, loopTotalCount });
            }
          }
          return;
        }

        if (
          eventType === 'node_completed' ||
          eventType === 'node_failed' ||
          eventType === 'node_skipped'
        ) {
          const terminalStatus =
            eventType === 'node_completed'
              ? 'completed'
              : eventType === 'node_failed'
                ? 'failed'
                : 'skipped';

          const currentAtom = appStore.get(nodeExecAtomFamily(key));
          const runningUntil = currentAtom?.runningUntil ?? 0;
          const remaining = runningUntil - Date.now();

          const applyTerminal = () => {
            appStore.set(nodeExecAtomFamily(key), {
              status: terminalStatus,
              loopIteration: currentAtom?.loopIteration,
              loopTotalCount: currentAtom?.loopTotalCount,
            });
          };

          if (remaining > 0) {
            schedulePendingTimeout(flowId, key, remaining, applyTerminal);
          } else {
            applyTerminal();
          }
        }
      },
    );

    return () => {
      unsubscribe();
      trackedNodeIdsRef.current.clear();

      const remainingSubscribers = unregisterFlowCanvasExecutionMount(flowId);
      if (remainingSubscribers === 0) {
        clearPendingTimeoutsForFlow(flowId);
        const overlayIds = flowCanvasExecutionOverlayNodeIds.get(flowId);
        if (overlayIds?.size) {
          clearFlowNodeAtoms(flowId, [...overlayIds]);
        }
        flowCanvasExecutionOverlayNodeIds.delete(flowId);
        appStore.set(flowLoopProgressAtomFamily(flowId), null);
        appStore.set(flowCanvasExecutionAtom, (prev) => {
          const { [flowId]: _, ...rest } = prev;
          return rest;
        });
      }
    };
  }, [flowId]);

  const rehydrateFromRun = useCallback(
    (run: DbFlowRunWithNodeRuns) => {
      // A run parks at 'paused' during async agent hand-offs while the agent is actively
      // running (see FlowRunStatusIcon.flowRunDisplayStatus) — rehydrate it like 'running'.
      // Keep in sync with runningRunIdForRehydrate / isFlowRunDetailAlignedWithLatestRun.
      if (run.status !== 'running' && run.status !== 'paused') return;

      const existing = appStore.get(flowCanvasExecutionAtom)[flowId];
      if (existing !== undefined) return;

      clearPendingTimeoutsForFlow(flowId);

      const merged = mergeNodeRunsForCanvas(run.nodeRuns ?? [], run.graph);

      appStore.set(flowCanvasExecutionAtom, (prev) => ({
        ...prev,
        [flowId]: { flowRunId: run.id, isLive: true, isHistoricalInspection: false },
      }));

      applyMergedNodeStatesToAtoms(flowId, merged, trackedNodeIdsRef);
      applyFlowLoopProgressFromMerged(flowId, merged, run.nodeRuns ?? []);
    },
    [flowId],
  );

  const viewRunOnCanvas = useCallback(
    (run: DbFlowRunWithNodeRuns) => {
      const cur = appStore.get(flowCanvasExecutionAtom)[flowId];
      if (cur?.isLive === true) return;
      if (cur?.flowRunId === run.id && cur.isHistoricalInspection === true) return;

      wipeTrackedOverlayNodes(flowId, trackedNodeIdsRef);

      const merged = mergeNodeRunsForCanvas(run.nodeRuns ?? [], run.graph);

      appStore.set(flowCanvasExecutionAtom, (prev) => ({
        ...prev,
        [flowId]: { flowRunId: run.id, isLive: false, isHistoricalInspection: true },
      }));

      applyMergedNodeStatesToAtoms(flowId, merged, trackedNodeIdsRef);
    },
    [flowId],
  );

  const clearOverlay = useCallback(() => {
    wipeTrackedOverlayNodes(flowId, trackedNodeIdsRef);
    appStore.set(flowLoopProgressAtomFamily(flowId), null);
    appStore.set(flowCanvasExecutionAtom, (prev) => {
      const { [flowId]: _, ...rest } = prev;
      return rest;
    });
  }, [flowId]);

  return { clearOverlay, rehydrateFromRun, viewRunOnCanvas };
}
