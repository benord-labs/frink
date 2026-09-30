/* eslint-disable max-lines, max-lines-per-function */
/**
 * Flow graph editor: canvas + config panel, save, manual run.
 */

import { Button } from '@benord-labs/frink-primitives';
import * as Sentry from '@sentry/electron/renderer';
import { TRPCClientError } from '@trpc/client';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { Loader2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { isCustomNodeBlockType, isTriggerBlockType } from '../../../../shared/lib/block-registry';
import { findBackEdges } from '../../../../shared/lib/flow-graph-cycle';
import {
  addEdgeToGraph,
  addNodeToGraph,
  type FlowConnectionLike,
  reconcileNodeProjectsOnDefaultChange,
  removeEdgeFromGraph,
  removeNodeFromGraph,
  resizeNodeInGraph,
  updateNodePositionInGraph,
  updateNodePositionsInGraph,
} from '../../../../shared/lib/flow-graph-mutations';
import type { RunCommandExpectedOutputs } from '../../../../shared/lib/output-schemas';
import {
  buildCustomNodeBlockIconsMap,
  buildCustomNodeInputsMap,
  buildCustomNodeOutputsMap,
  type CustomNodeSummary,
} from '../../../lib/flows/custom-node-maps';
import {
  type FlowEdge,
  type FlowGraph,
  flowGraphsEqual,
  normalizeFlowGraph,
  validateGraph,
} from '../../../../shared/lib/validate-flow-graph';
import { computeNodeVariables } from '../../../../shared/lib/validate-flow-templates';
import type {
  FlowBlockType,
  FlowSettings,
  RunCommandBlockConfig,
} from '../../../../shared/types/flow';
import { FLOW_BLOCK_TYPES } from '../../../../shared/types/flow';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../components/ui/alert-dialog';
import { Kbd } from '../../../components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { useFlowCanvasExecution } from '../../../hooks/use-flow-canvas-execution';
import { flowEditorDirtyAtom } from '../../../lib/atoms';
import { deleteFlowDraft, loadFlowDraft, saveFlowDraft } from '../../../lib/flow-drafts';
import { clearRehearsal, ghostRunActiveAtom } from '../../../lib/flow-rehearsal';
import { hasOpenDialogLayer } from '../../../lib/has-open-dialog-layer';
import { useBatchRunActions } from '../../../lib/hooks/use-batch-run-actions';
import { isEditableKeyboardTarget } from '../../../lib/is-editable-keyboard-target';
import { appStore } from '../../../lib/jotai-store';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { resolveDefaultSelectedBatchId } from '../../../lib/utils/default-selected-batch';
import { dispatchFlowRun } from '../../../lib/utils/flow-run-dispatch';
import { resolveServerAdoption } from '../../../lib/flows/editor-sync/resolve-server-adoption';
import { resolveInitialGraph } from '../../../utils/flow-initial-graph';
import { codeEditorOpenAtom } from '../../code-editor';
import { UNIFIED_GLASS_INNER_CLASS } from '../../sidebar/inset-glass-sidebar-shell';
import { flowCanvasExecutionAtom } from '../atoms';
import { isFlowRunDetailAlignedWithLatestRun } from '../flow-canvas-rehydrate-eligibility';
import { resolveFlowEditorEscapeAction } from '../flow-editor-escape-stack';
import { BlockConfigPanel, type NodePatch } from './BlockConfig';
import { FLOW_ADDABLE_BLOCK_TYPES, FLOW_TRIGGER_TYPES } from './constants';
import { FlowCanvas } from './FlowCanvas';
import { embedMissingPositionsFromDagre } from './FlowCanvas/compute-dagre-positions';
import { FlowEditorHeader } from './FlowEditorHeader';
import { FlowRunsTab } from './FlowRunsTab';
import { FlowSettingsPanel } from './FlowSettingsPanel';
import { useBatchTriggerSchemaSync } from './hooks/useBatchTriggerSchemaSync';
import { applyCreatorPick } from '../../../lib/flows/node-creator/pick';
import { type NodeCreatorMode, NodeCreatorPanel } from './NodeCreatorPanel';
import type { FlowNodeCanvasContext } from './nodeSummary';

type FlowEditorProps = {
  flowId: string;
  /** Back to flows dashboard (list); same handler for crumb + header dismiss. */
  onBack: () => void;
};

/** Stable order when multiple edges target the same node (graph.edges order is not guaranteed). */
function sortedIncomingSourceIds(edges: FlowEdge[], targetId: string): string[] {
  return edges
    .filter((e) => e.target === targetId)
    .sort((a, b) => {
      const bySource = a.source.localeCompare(b.source);
      if (bySource !== 0) return bySource;
      return a.id.localeCompare(b.id);
    })
    .map((e) => e.source);
}

/**
 * Graph persisted on save: embed Dagre layout for missing positions, and merge server
 * `batchTriggerSchema` when the client graph has none (server-side auto-merge from poll).
 */
function buildGraphToSaveWithSchema(
  graph: FlowGraph,
  serverBatchTriggerSchema: FlowSettings['batchTriggerSchema'] | undefined,
): FlowGraph {
  const graphToSave = embedMissingPositionsFromDagre(graph);
  if (serverBatchTriggerSchema?.length && !graphToSave.settings?.batchTriggerSchema?.length) {
    return {
      ...graphToSave,
      settings: {
        ...(graphToSave.settings ?? {}),
        batchTriggerSchema: serverBatchTriggerSchema,
      },
    };
  }
  return graphToSave;
}

export function FlowEditor({ flowId, onBack }: FlowEditorProps): ReactElement {
  const isDirty = useAtomValue(flowEditorDirtyAtom);
  const setDirtyGlobal = useSetAtom(flowEditorDirtyAtom);

  // Ghost Run (Rehearse) overlay toggle — see src/renderer/lib/flow-rehearsal.
  const [ghostRunActive, setGhostRunActive] = useAtom(ghostRunActiveAtom);

  // Real-time canvas execution overlay (Phase 2)
  const { clearOverlay, rehydrateFromRun, viewRunOnCanvas } = useFlowCanvasExecution(flowId);
  const canvasExecState = useAtomValue(flowCanvasExecutionAtom)[flowId];
  const utils = trpc.useUtils();
  const { data, isLoading, error, refetch } = trpc.flows.get.useQuery(
    { id: flowId },
    {
      // Poll every 30s so server-side mutations (auto-merge of batchTriggerSchema, etc.)
      // are picked up without the user needing to close and reopen the editor.
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
    },
  );

  const { data: runsList } = trpc.flows.listRuns.useQuery(
    { flowId, limit: 20 },
    { staleTime: 30_000 },
  );
  const latestRun = runsList?.[0];
  const overlayRunMeta = useMemo(() => {
    const rid = canvasExecState?.flowRunId;
    if (!rid || !runsList) return undefined;
    return runsList.find((r) => r.id === rid);
  }, [canvasExecState?.flowRunId, runsList]);
  const runningRunIdForRehydrate =
    (latestRun?.status === 'running' || latestRun?.status === 'paused') &&
    canvasExecState === undefined
      ? latestRun.id
      : null;

  const { data: activeRunDetail } = trpc.flows.getRun.useQuery(
    { runId: runningRunIdForRehydrate ?? '00000000-0000-0000-0000-000000000000' },
    { enabled: runningRunIdForRehydrate !== null },
  );

  const rehydratedRunIdRef = useRef<string | null>(null);
  useEffect(() => {
    rehydratedRunIdRef.current = null;
  }, [flowId]);

  useEffect(() => {
    if (!activeRunDetail) return;
    if (!isFlowRunDetailAlignedWithLatestRun(activeRunDetail, latestRun)) return;
    if (canvasExecState !== undefined) return;
    if (rehydratedRunIdRef.current === activeRunDetail.id) return;
    rehydrateFromRun(activeRunDetail);
    rehydratedRunIdRef.current = activeRunDetail.id;
  }, [activeRunDetail, latestRun, canvasExecState, rehydrateFromRun]);

  /**
   * When server truth shows the rehydrated run finished: clear stuck "Live" if still `isLive` from
   * rehydration only. If the socket already set `isLive: false` and applied terminal nodes, only reset
   * the ref so we do not wipe that overlay. "Finished" = a TERMINAL status — a `paused` run is still
   * active (waiting for input) and must NOT be treated as finished, else it clears the overlay we
   * just rehydrated for it.
   */
  useEffect(() => {
    const rid = rehydratedRunIdRef.current;
    if (!rid) return;

    const isFinishedStatus = (s: string | undefined) =>
      s === 'completed' || s === 'failed' || s === 'cancelled';
    const finishedOnServer =
      (latestRun?.id === rid && isFinishedStatus(latestRun.status)) ||
      (activeRunDetail?.id === rid && isFinishedStatus(activeRunDetail.status));

    if (!finishedOnServer) return;

    if (canvasExecState?.isLive === true) {
      clearOverlay();
    }
    rehydratedRunIdRef.current = null;
  }, [activeRunDetail, latestRun, canvasExecState, clearOverlay]);

  const [graph, setGraph] = useState<FlowGraph>({ nodes: [], edges: [] });
  const [baselineVersion, setBaselineVersion] = useState(0);
  const [title, setTitle] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [baselineGraph, setBaselineGraph] = useState<FlowGraph | null>(null);
  // True only when the working copy was restored from a persisted local draft (vs the server graph).
  // Drives the "Draft · unsaved changes" badge + the Discard-draft control.
  const [draftRestored, setDraftRestored] = useState(false);
  // Bumped on discard/conflict-reload to force FlowCanvas's full-reset path (composite flowMountKey),
  // so a programmatic graph revert repaints the canvas immediately instead of merge-preserving stale
  // node positions until a flow-switch/remount.
  const [canvasResetNonce, setCanvasResetNonce] = useState(0);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [conflictReloadOpen, setConflictReloadOpen] = useState(false);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  // Config panel + predecessor-variable logic are single-node concerns; multi-select collapses to
  // null so the panel closes. This derivation keeps all downstream selection code unchanged.
  const selectedNodeId = selectedNodeIds.length === 1 ? selectedNodeIds[0] : null;
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [creatorMode, setCreatorMode] = useState<NodeCreatorMode | null>(null);
  const [editorTab, setEditorTab] = useState<'editor' | 'runs'>('editor');
  /** Stage detail open in the Runs tab's monitor pane. */
  const [monitorStageId, setMonitorStageId] = useState<string | null>(null);
  /** Explicit batch selection in the Runs tab (view state; null = follow the default). */
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);

  const serverBatchTriggerSchemaRef = useRef<FlowSettings['batchTriggerSchema']>(undefined);
  const serverBatchTriggerSchema = useMemo(() => {
    const normalized = normalizeFlowGraph(data?.graph);
    const next = normalized?.settings?.batchTriggerSchema;
    if (
      JSON.stringify(next ?? null) === JSON.stringify(serverBatchTriggerSchemaRef.current ?? null)
    ) {
      return serverBatchTriggerSchemaRef.current;
    }
    serverBatchTriggerSchemaRef.current = next;
    return next;
  }, [data?.graph]);

  const creatorOpenRef = useRef(creatorOpen);
  const settingsOpenRef = useRef(settingsOpen);
  const selectedNodeIdRef = useRef(selectedNodeId);
  const editorTabRef = useRef(editorTab);
  const monitorStageIdRef = useRef(monitorStageId);
  const onBackRef = useRef(onBack);
  creatorOpenRef.current = creatorOpen;
  settingsOpenRef.current = settingsOpen;
  // Presence (any selected), not the derived single id — so Escape clears a multi-selection instead
  // of falling through to 'back' (which exits the editor) when 2+ nodes are selected.
  selectedNodeIdRef.current = selectedNodeIds[0] ?? null;
  editorTabRef.current = editorTab;
  monitorStageIdRef.current = monitorStageId;
  onBackRef.current = onBack;

  // Fresh graph/flowId for the (stable, []-deps) Escape handler's ghost-clear branch.
  const graphRef = useRef(graph);
  const flowIdRef = useRef(flowId);
  graphRef.current = graph;
  flowIdRef.current = flowId;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== 'Escape') {
        return;
      }
      if (isEditableKeyboardTarget(e.target)) {
        return;
      }

      // Code editor mounts under flows too; its Escape handler is on document capture, which runs
      // after this window capture listener. Yield so Escape closes the editor first (top z-index).
      if (appStore.get(codeEditorOpenAtom)) {
        return;
      }

      const action = resolveFlowEditorEscapeAction({
        hasOpenDialogLayer: hasOpenDialogLayer(),
        ghostRunActive: appStore.get(ghostRunActiveAtom),
        creatorOpen: creatorOpenRef.current,
        settingsOpen: settingsOpenRef.current,
        selectedNodeId: selectedNodeIdRef.current,
        runsTab: editorTabRef.current === 'runs',
        stageDetailOpen: monitorStageIdRef.current !== null,
      });

      if (action === 'defer-to-radix') {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      switch (action) {
        case 'clear-ghost-run':
          clearRehearsal(flowIdRef.current, graphRef.current);
          appStore.set(ghostRunActiveAtom, false);
          break;
        case 'close-creator':
          setCreatorOpen(false);
          setCreatorMode(null);
          break;
        case 'close-settings':
          setSettingsOpen(false);
          break;
        case 'close-stage-detail':
          setMonitorStageId(null);
          break;
        case 'back-to-editor-tab':
          setEditorTab('editor');
          break;
        case 'clear-selection':
          setSelectedNodeIds([]);
          break;
        case 'back':
          onBackRef.current();
          break;
      }
    };

    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Clear any Ghost Run when the flow changes or the editor unmounts so predicted paint never
  // leaks across flows. Cleanup runs with the PRIOR flow's graph (captured by the closure).
  useEffect(() => {
    return () => {
      clearRehearsal(flowId, graphRef.current);
      setGhostRunActive(false);
    };
  }, [flowId, setGhostRunActive]);

  useEffect(() => {
    if (!data) return;
    setTitle(data.name);
    if (!hydrated) {
      const serverVersion = data.version_number ?? 0;
      const serverGraph = resolveInitialGraph(data.graph, data.project_id);
      const draft = loadFlowDraft(flowId);
      setBaselineGraph(serverGraph);
      setBaselineVersion(serverVersion);
      if (draft && draft.baselineVersion === serverVersion) {
        // Restore the user's unsaved working copy; it reads as modified against the server graph.
        setGraph(draft.graph);
        setDirtyGlobal(true);
        setDraftRestored(true);
      } else {
        // No draft, or a stale one (the server row advanced past the draft's baseline) — drop it.
        if (draft) deleteFlowDraft(flowId);
        setGraph(serverGraph);
        setDirtyGlobal(false);
      }
      setHydrated(true);
    }
  }, [data, hydrated, setDirtyGlobal, flowId]);

  useBatchTriggerSchemaSync({ hydrated, isDirty, graph, setGraph, serverBatchTriggerSchema });

  useEffect(() => {
    setSelectedNodeIds((ids) => {
      const next = ids.filter((id) => graph.nodes.some((n) => n.id === id));
      return next.length === ids.length ? ids : next;
    });
  }, [graph.nodes]);

  // The flow's persisted run target (graph.settings.currentBatchId). The Runs tab's
  // selection defaults to it but is free to diverge (view an older batch).
  const currentBatchId = data?.current_batch_id ?? null;

  const { data: batchSummaries } = trpc.flows.listBatches.useQuery(
    { flowId, limit: 50 },
    { staleTime: 30_000 },
  );
  const effectiveSelectedBatchId =
    selectedBatchId ?? resolveDefaultSelectedBatchId(currentBatchId, batchSummaries);

  const handleSelectBatch = useCallback((batchId: string) => {
    setSelectedBatchId(batchId);
    // A stage id from the previous batch must not filter the new one.
    setMonitorStageId(null);
  }, []);

  const {
    data: customNodesList,
    isLoading: customNodesIsLoading,
    isError: customNodesQueryError,
  } = trpc.customNodes.list.useQuery(undefined, { staleTime: 30_000 });

  /** True while fetching or when the query failed with no cached data (avoid red false positives for custom-node manifests). */
  const customNodesLoading =
    customNodesIsLoading || (customNodesQueryError && customNodesList === undefined);

  // SAFETY: the tRPC payload is JSON off the wire; each manifest's inputs are parsed before use.
  const customNodeSummaries = customNodesList as CustomNodeSummary[] | undefined;
  const customNodeOutputsMap = useMemo(
    () => buildCustomNodeOutputsMap(customNodeSummaries),
    [customNodeSummaries],
  );
  const customNodeInputs = useMemo(
    () => buildCustomNodeInputsMap(customNodeSummaries),
    [customNodeSummaries],
  );
  const customBlockIcons = useMemo(
    () => buildCustomNodeBlockIconsMap(customNodeSummaries),
    [customNodeSummaries],
  );

  const customFlowCanvasContext = useMemo((): FlowNodeCanvasContext => {
    if (customNodesLoading || customNodesList === undefined) {
      return {
        customDescriptionByBlockType: new Map(),
        customCatalogNames: null,
      };
    }
    const desc = new Map<string, string>();
    for (const n of customNodesList) {
      if (typeof n.description === 'string' && n.description.trim() !== '') {
        desc.set(n.name, n.description.trim());
      }
    }
    return {
      customDescriptionByBlockType: desc,
      customCatalogNames: new Set(customNodesList.map((n) => n.name)),
    };
  }, [customNodesLoading, customNodesList]);

  // Maps the webhook trigger's integrationId to its provider, so per-provider aliases
  // ({{trigger.story.title}}) resolve and validation can spot a deleted event id.
  const { data: integrationsForVars } = trpc.integrations.list.useQuery(undefined);
  const webhookProvider = useMemo(() => {
    const trigger = graph.nodes.find((n) => n.blockType === 'webhook_trigger');
    const boundId = trigger?.config?.integrationId;
    const match = boundId ? integrationsForVars?.find((i) => i.id === boundId) : undefined;
    return match?.provider.toLowerCase();
  }, [graph, integrationsForVars]);
  const nodeVariablesByNodeId = useMemo(
    () => computeNodeVariables(graph, { customNodeOutputs: customNodeOutputsMap, webhookProvider }),
    [graph, customNodeOutputsMap, webhookProvider],
  );

  const validation = useMemo(
    () => validateGraph(graph, { webhookProvider }),
    [graph, webhookProvider],
  );
  const warnings = validation.warnings ?? [];

  // The saved version's save-payload. Keyed only on the server graph + schema so it is NOT
  // rebuilt on every local edit (its build runs a Dagre layout). null = brand-new flow (no
  // baseline to compare against), so the first save is always allowed.
  const savedGraphToCompare = useMemo(() => {
    const saved = normalizeFlowGraph(data?.graph);
    if (saved === null || saved.nodes.length < 2) return null;
    return buildGraphToSaveWithSchema(saved, serverBatchTriggerSchema);
  }, [data?.graph, serverBatchTriggerSchema]);

  // True only when the working copy differs in content from the saved version; both sides build
  // through buildGraphToSaveWithSchema so a layout or schema merge can't manufacture a false diff.
  const graphToSave = useMemo(
    () => buildGraphToSaveWithSchema(graph, serverBatchTriggerSchema),
    [graph, serverBatchTriggerSchema],
  );

  const hasChanges = useMemo(() => {
    if (!hydrated) return false;
    if (savedGraphToCompare === null) return true; // brand-new flow, needs first save
    return !flowGraphsEqual(graphToSave, savedGraphToCompare);
  }, [hydrated, savedGraphToCompare, graphToSave]);

  // Does the working copy differ from the graph baselineVersion describes? Derived, never latched.
  // Keyed off the baseline alone so a canvas edit never re-runs its Dagre layout.
  const baselineGraphToCompare = useMemo(
    () =>
      baselineGraph ? buildGraphToSaveWithSchema(baselineGraph, serverBatchTriggerSchema) : null,
    [baselineGraph, serverBatchTriggerSchema],
  );
  const locallyModified = useMemo(
    () => baselineGraphToCompare === null || !flowGraphsEqual(graphToSave, baselineGraphToCompare),
    [graphToSave, baselineGraphToCompare],
  );

  // Adopt a newer server version WITH its graph; the version alone stranded the working copy.
  useEffect(() => {
    const next = resolveServerAdoption({
      data,
      hydrated,
      locallyModified,
      runOnCanvas: canvasExecState !== undefined || ghostRunActive,
      baselineVersion,
    });
    if (!next) return;
    const adopted = resolveInitialGraph(next.graph, next.project_id);
    setGraph(adopted);
    setBaselineGraph(adopted);
    setBaselineVersion(next.version_number ?? 0);
    // The working copy IS the saved graph now, so every dirty-state consumer must agree.
    setDirtyGlobal(false);
    setDraftRestored(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setDirtyGlobal is a stable jotai setter
  }, [data, hydrated, locallyModified, canvasExecState, ghostRunActive, baselineVersion]);

  const updateGraph = useCallback(
    (next: FlowGraph | ((prev: FlowGraph) => FlowGraph)) => {
      setGraph(next);
      setDirtyGlobal(true);
      setSaveError(null);
    },
    [setDirtyGlobal],
  );

  // Live snapshot read by the draft-flush paths (debounce timer, unmount, beforeunload) so they
  // persist the latest graph without re-subscribing on every edit.
  const draftSnapshotRef = useRef({ graph, baselineVersion, hasChanges, hydrated });
  draftSnapshotRef.current = { graph, baselineVersion, hasChanges, hydrated };

  const flushDraft = useCallback(() => {
    const snap = draftSnapshotRef.current;
    if (!snap.hydrated) return;
    // Gate on hasChanges (true content diff): edit-then-revert persists nothing.
    if (snap.hasChanges) {
      saveFlowDraft(flowId, {
        graph: snap.graph,
        baselineVersion: snap.baselineVersion,
        updatedAt: Date.now(),
      });
    } else {
      deleteFlowDraft(flowId);
    }
  }, [flowId]);

  // Autosave the working graph as a local draft, debounced ~600ms (coalesces per-frame position
  // drags into one write). Leaving the editor no longer prompts — the draft guarantees no data loss.
  useEffect(() => {
    if (!hydrated) return;
    const timer = setTimeout(flushDraft, 600);
    return () => clearTimeout(timer);
  }, [graph, hydrated, flushDraft]);

  // Flush on unmount + hard window close so edits made within the debounce window survive. Replaces
  // the old blocking beforeunload guard: no nag, just a silent best-effort persist.
  useEffect(() => {
    const onBeforeUnload = (): void => flushDraft();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      flushDraft();
    };
  }, [flushDraft]);

  // Reset the global dirty flag on unmount so a stale `true` doesn't leak into the chat-nav guard
  // after exit — the local draft (not this flag) now guards against data loss.
  useEffect(() => () => setDirtyGlobal(false), [setDirtyGlobal]);

  const updateFlowSettings = useCallback(
    (settings: FlowSettings) => {
      const reconciled = reconcileNodeProjectsOnDefaultChange(
        graph,
        graph.settings?.defaultProjectId,
        settings?.defaultProjectId,
      );
      updateGraph({ ...reconciled, settings });
    },
    [graph, updateGraph],
  );

  const updateNode = useCallback(
    (nodeId: string, patch: NodePatch) => {
      const nextNodes = graph.nodes.map((n) => {
        if (n.id !== nodeId) return n;

        // If blockType is changing, reset config and label to undefined
        if (patch.blockType !== undefined && patch.blockType !== n.blockType) {
          return {
            ...n,
            blockType: patch.blockType,
            config: undefined,
            label: undefined,
          };
        }

        // Normal patch behavior for label and config
        const baseConfig =
          n.config && typeof n.config === 'object' && n.config !== null && !Array.isArray(n.config)
            ? { ...(n.config as Record<string, unknown>) }
            : {};
        return {
          ...n,
          ...(patch.label !== undefined ? { label: patch.label } : {}),
          ...(patch.config !== undefined ? { config: { ...baseConfig, ...patch.config } } : {}),
        };
      });
      updateGraph({ nodes: nextNodes, edges: graph.edges, settings: graph.settings });
    },
    [graph.nodes, graph.edges, graph.settings, updateGraph],
  );

  const handleConnect = useCallback(
    (conn: FlowConnectionLike) => {
      const result = addEdgeToGraph(graph, conn);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      let nextGraph = result.graph;
      // When a new back-edge is created from a condition node, auto-persist the
      // default loop config so the UI and engine agree on maxIterations (10 vs
      // the engine's fallback cap of 50).
      const oldEdgeIds = new Set(graph.edges.map((e) => e.id));
      const newEdge = nextGraph.edges.find((e) => !oldEdgeIds.has(e.id));
      if (newEdge && findBackEdges(nextGraph).has(newEdge.id)) {
        const condNode = nextGraph.nodes.find(
          (n) => n.id === conn.source && n.blockType === 'condition',
        );
        if (condNode) {
          const existingCfg =
            condNode.config != null &&
            typeof condNode.config === 'object' &&
            !Array.isArray(condNode.config)
              ? (condNode.config as Record<string, unknown>)
              : {};
          if (!existingCfg.loop) {
            nextGraph = {
              ...nextGraph,
              nodes: nextGraph.nodes.map((n) =>
                n.id === condNode.id
                  ? {
                      ...n,
                      config: { ...existingCfg, loop: { maxIterations: 10, onMaxReached: 'fail' } },
                    }
                  : n,
              ),
            };
          }
        }
      }
      updateGraph(nextGraph);
    },
    [graph, updateGraph],
  );

  const handleRemoveNode = useCallback(
    (nodeId: string) => {
      const n = graph.nodes.find((x) => x.id === nodeId);
      if (n && FLOW_TRIGGER_TYPES.has(n.blockType as FlowBlockType)) return;
      updateGraph(removeNodeFromGraph(graph, nodeId));
    },
    [graph, updateGraph],
  );

  const handleNodesDelete = useCallback(
    (ids: string[]) => {
      let g = graph;
      for (const id of ids) {
        const n = g.nodes.find((x) => x.id === id);
        if (n && FLOW_TRIGGER_TYPES.has(n.blockType as FlowBlockType)) continue;
        g = removeNodeFromGraph(g, id);
      }
      updateGraph(g);
    },
    [graph, updateGraph],
  );

  const handleEdgesDelete = useCallback(
    (ids: string[]) => {
      let g = graph;
      for (const id of ids) {
        g = removeEdgeFromGraph(g, id);
      }
      updateGraph(g);
    },
    [graph, updateGraph],
  );

  const handleNodePosition = useCallback(
    (nodeId: string, position: { x: number; y: number }) => {
      updateGraph(updateNodePositionInGraph(graph, nodeId, position));
    },
    [graph, updateGraph],
  );

  const handleNodesPosition = useCallback(
    (updates: Array<{ id: string; position: { x: number; y: number } }>) => {
      updateGraph(updateNodePositionsInGraph(graph, updates));
    },
    [graph, updateGraph],
  );

  const creatorAllowedTypes = useMemo((): FlowBlockType[] => {
    const filterTypes = (types: readonly FlowBlockType[]): FlowBlockType[] => {
      let result = [...types];
      // end cannot be inserted mid-edge: it would create an outgoing edge from end which is invalid
      if (creatorMode?.kind === 'insert_edge') {
        result = result.filter((t) => t !== 'end');
      }
      if (creatorMode?.kind === 'append') {
        const source = graph.nodes.find((node) => node.id === creatorMode.sourceId);
        if (source?.blockType === 'fan_out' || source?.parentId) {
          result = result.filter(
            (type) => type !== 'condition' && type !== 'fan_out' && type !== 'end',
          );
        }
      }
      return result;
    };

    if (!creatorMode || creatorMode.kind === 'floating') {
      // Filter out triggers if graph already has one
      const hasTrigger = graph.nodes.some((n) =>
        FLOW_TRIGGER_TYPES.has(n.blockType as FlowBlockType),
      );
      if (hasTrigger) return filterTypes(FLOW_ADDABLE_BLOCK_TYPES);
      return filterTypes(FLOW_BLOCK_TYPES);
    }
    return filterTypes(FLOW_ADDABLE_BLOCK_TYPES);
  }, [creatorMode, graph.nodes]);

  const handleSelectNodes = useCallback((ids: string[]) => {
    // One shallow-equal guard for every selection writer: keeping the array reference when
    // membership is unchanged stops node memos invalidating mid-drag.
    setSelectedNodeIds((prev) =>
      prev.length === ids.length && prev.every((id, i) => id === ids[i]) ? prev : ids,
    );
    if (ids.length > 0) {
      setSettingsOpen(false);
    }
  }, []);

  const handleCreatorPick = useCallback(
    (blockType: string) => {
      if (!creatorMode) return;
      const picked = applyCreatorPick(graph, creatorMode, blockType);
      if (!picked.ok) {
        toast.error(picked.error);
        return;
      }
      updateGraph(picked.graph);
      // The step the author just created is the one they are looking at and configuring.
      handleSelectNodes([picked.selectId]);
      setSelectedEdgeId(null);
      setCreatorOpen(false);
      setCreatorMode(null);
    },
    [creatorMode, graph, updateGraph, handleSelectNodes],
  );

  const handleRequestInsertOnEdge = useCallback((edgeId: string) => {
    setSelectedEdgeId(edgeId);
    setSelectedNodeIds([]);
    setCreatorMode({ kind: 'insert_edge', edgeId });
    setCreatorOpen(true);
  }, []);

  const handleRequestAddConnectedStep = useCallback(
    (sourceId: string, sourceHandle: string | undefined) => {
      setCreatorMode({ kind: 'append', sourceId, sourceHandle });
      setCreatorOpen(true);
    },
    [],
  );

  const handlePaneDoubleClickFlowPosition = useCallback(
    (position: { x: number; y: number }) => {
      if (creatorOpen) return;
      setCreatorMode({ kind: 'floating', position });
      setCreatorOpen(true);
    },
    [creatorOpen],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' && e.key !== 'N') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, [contenteditable=true]')) return;
      if (creatorOpen) return;
      e.preventDefault();
      setCreatorMode({ kind: 'floating' });
      setCreatorOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [creatorOpen]);

  // Reset the working copy to a server snapshot, dropping local edits. User-initiated paths only.
  const applyServerSnapshot = useCallback(
    (next: NonNullable<typeof data>) => {
      deleteFlowDraft(flowId);
      const server = resolveInitialGraph(next.graph, next.project_id);
      setGraph(server);
      setBaselineGraph(server);
      setBaselineVersion(next.version_number ?? 0);
      setSelectedNodeIds([]);
      setSelectedEdgeId(null);
      setDirtyGlobal(false);
      setDraftRestored(false);
      setCanvasResetNonce((n) => n + 1);
    },
    [flowId, setDirtyGlobal],
  );

  const handleConflictReload = useCallback(() => {
    setConflictReloadOpen(false);
    void (async () => {
      try {
        const fresh = await utils.flows.get.fetch({ id: flowId });
        applyServerSnapshot(fresh);
        setTitle(fresh.name);
        setLastSavedAt(null);
      } catch (fetchErr) {
        Sentry.captureException(fetchErr, {
          tags: { source: 'FlowEditor', area: 'flow-editor-conflict-reload' },
          extra: { flowId },
        });
        toast.error('Could not reload the latest version. Try again or reopen the flow.');
      }
    })();
  }, [flowId, utils.flows.get, applyServerSnapshot, setTitle]);

  const saveMutation = trpc.flows.saveVersion.useMutation({
    onSuccess: (version, variables) => {
      setBaselineVersion(version.version_number);
      setBaselineGraph(variables.graph);
      setDirtyGlobal(false);
      setSaveError(null);
      setLastSavedAt(new Date());
      setDraftRestored(false);
      deleteFlowDraft(flowId);
      toast.success('Flow saved');
      void utils.flows.get.invalidate({ id: flowId });
      void utils.flows.list.invalidate();
    },
    onError: (err) => {
      if (err instanceof TRPCClientError && err.data?.code === 'CONFLICT') {
        setConflictReloadOpen(true);
        return;
      }
      setSaveError(err.message || 'Save failed');
    },
  });

  const runMutation = trpc.flows.startRun.useMutation({
    onSuccess: (run) => {
      toast.success(run.status === 'pending' ? 'Run queued' : 'Run started');
      void utils.flows.listRuns.invalidate({ flowId });
      void utils.flows.listBatches.invalidate({ flowId });
      void utils.flows.listBatchRuns.invalidate({ flowId });
      void utils.flows.list.invalidate();
    },
    onError: (err) => {
      toast.error(err.message || 'Could not start run');
    },
  });

  // The header run button is the ONLY run-action surface. It targets what you are looking
  // at: the selected batch on the Runs tab, else the flow's active batch.
  const headerBatchTarget =
    editorTab === 'runs' ? (effectiveSelectedBatchId ?? currentBatchId) : currentBatchId;
  const headerBatch = useBatchRunActions(flowId, headerBatchTarget, () =>
    runMutation.mutate({ flowId, triggerContext: null }),
  );
  const terminalBatchOnEditor =
    editorTab === 'editor' && headerBatch.runState?.primary === 'unavailable';
  const headerRunState = terminalBatchOnEditor ? null : headerBatch.runState;

  /** Start the selected batch, or start a fresh single run from the editor after a batch settles. */
  const runPrimary = useCallback(() => {
    dispatchFlowRun(terminalBatchOnEditor ? null : headerBatchTarget, {
      startBatch: () => headerBatch.startBatch(),
      runSingle: () => runMutation.mutate({ flowId, triggerContext: null }),
    });
  }, [flowId, headerBatch, headerBatchTarget, runMutation, terminalBatchOnEditor]);

  const updateTitleMutation = trpc.flows.update.useMutation({
    onSuccess: () => {
      void utils.flows.list.invalidate();
      void utils.flows.get.invalidate({ id: flowId });
    },
    onError: (err) => {
      toast.error(err.message || 'Could not rename flow');
    },
  });

  // Guard against concurrent dispatches (rapid clicks / ⌘S): a second in-flight save carries the
  // same stale expectedVersionNumber and surfaces a spurious version conflict.
  const dispatchSave = useCallback(() => {
    if (!validation.valid || saveMutation.isPending || !hasChanges) return;
    saveMutation.mutate({
      flowId,
      graph: graphToSave,
      expectedVersionNumber: baselineVersion,
    });
  }, [validation.valid, saveMutation, hasChanges, graphToSave, flowId, baselineVersion]);

  const saveHotkeyRef = useRef<() => void>(() => {});
  saveHotkeyRef.current = dispatchSave;

  const runHotkeyRef = useRef<() => void>(() => {});

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 's') {
        e.preventDefault();
        saveHotkeyRef.current();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runHotkeyRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const flowEnabled = data?.is_enabled ?? true;

  const triggerNode = useMemo(
    () => graph.nodes.find((n) => n.blockType === 'manual_trigger'),
    [graph.nodes],
  );

  const triggerBlockType = useMemo(
    () =>
      graph.nodes.find((n) => isTriggerBlockType(n.blockType))?.blockType as
        | FlowBlockType
        | undefined,
    [graph.nodes],
  );

  /** Webhook trigger integration id (for Agent recommended prompt ordering). */
  const webhookTriggerIntegrationId = useMemo((): string | undefined => {
    const n = graph.nodes.find((node) => node.blockType === 'webhook_trigger');
    const c =
      n?.config && typeof n.config === 'object' && !Array.isArray(n.config)
        ? (n.config as Record<string, unknown>)
        : null;
    const id = typeof c?.integrationId === 'string' ? c.integrationId.trim() : '';
    return id.length > 0 ? id : undefined;
  }, [graph.nodes]);

  /**
   * The block type of the immediate predecessor of the selected node (single-hop, no recursion).
   * Used by the AvailableVariables panel to show which `{{previous.*}}` fields are available.
   * Returns null when there is no predecessor or no selected node.
   */
  const predecessorBlockType = useMemo((): string | null => {
    if (!selectedNodeId) return null;
    const incomingSourceIds = sortedIncomingSourceIds(graph.edges, selectedNodeId);
    if (incomingSourceIds.length === 0) return null;
    // If multiple predecessors, use the first after stable sort (merge nodes are uncommon in v1)
    const predNode = graph.nodes.find((n) => n.id === incomingSourceIds[0]);
    return predNode?.blockType ?? null;
  }, [selectedNodeId, graph.nodes, graph.edges]);

  /**
   * Block type of the output-producing node upstream of the predecessor.
   * Used by AvailableVariables to show `{{previous.currentItem.*}}` chips when
   * the direct predecessor is `fan_out` (whose currentItem shape comes from its own predecessor).
   * Walks past `condition` nodes since they are pass-through (they forward upstream outputs).
   */
  const predecessorOfPredecessorBlockType = useMemo((): string | null => {
    if (!selectedNodeId) return null;
    const predSourceIds = sortedIncomingSourceIds(graph.edges, selectedNodeId);
    if (predSourceIds.length === 0) return null;

    let currentId: string | undefined = predSourceIds[0];
    const visited = new Set<string>();
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const parentSourceIds = sortedIncomingSourceIds(graph.edges, currentId);
      if (parentSourceIds.length === 0) return null;
      const parentNode = graph.nodes.find((n) => n.id === parentSourceIds[0]);
      if (!parentNode) return null;
      if (parentNode.blockType === 'condition') {
        currentId = parentSourceIds[0];
        continue;
      }
      return parentNode.blockType;
    }
    return null;
  }, [selectedNodeId, graph.nodes, graph.edges]);

  /**
   * `expectedOutputs` from the immediate predecessor's config, when that predecessor is a
   * `run_command` node. Passed to AvailableVariables so it can show declared JSON stdout fields.
   */
  const predecessorExpectedOutputs = useMemo((): RunCommandExpectedOutputs | null => {
    if (!selectedNodeId) return null;
    const predSourceIds = sortedIncomingSourceIds(graph.edges, selectedNodeId);
    if (predSourceIds.length === 0) return null;
    const predNode = graph.nodes.find((n) => n.id === predSourceIds[0]);
    if (predNode?.blockType !== 'run_command') return null;
    const config = predNode.config as RunCommandBlockConfig | undefined;
    const eo = config?.expectedOutputs;
    if (!eo || typeof eo !== 'object' || Object.keys(eo).length === 0) return null;
    return eo as RunCommandExpectedOutputs;
  }, [selectedNodeId, graph.nodes, graph.edges]);

  /**
   * `expectedOutputs` from two hops upstream (walking past condition nodes), when that node is
   * `run_command`. Used when the immediate predecessor is `condition` (condition passthrough).
   */
  const predecessorOfPredecessorExpectedOutputs = useMemo((): RunCommandExpectedOutputs | null => {
    if (!selectedNodeId) return null;
    const predSourceIds = sortedIncomingSourceIds(graph.edges, selectedNodeId);
    if (predSourceIds.length === 0) return null;

    let currentId: string | undefined = predSourceIds[0];
    const visited = new Set<string>();
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const parentSourceIds = sortedIncomingSourceIds(graph.edges, currentId);
      if (parentSourceIds.length === 0) return null;
      const parentNode = graph.nodes.find((n) => n.id === parentSourceIds[0]);
      if (!parentNode) return null;
      if (parentNode.blockType === 'condition') {
        currentId = parentSourceIds[0];
        continue;
      }
      if (parentNode.blockType !== 'run_command') return null;
      const config = parentNode.config as RunCommandBlockConfig | undefined;
      const eo = config?.expectedOutputs;
      if (!eo || typeof eo !== 'object' || Object.keys(eo).length === 0) return null;
      return eo as RunCommandExpectedOutputs;
    }
    return null;
  }, [selectedNodeId, graph.nodes, graph.edges]);

  /** Fan Out ownership is explicit, so loop variables never bleed into the continuation. */
  const ancestorFanOut = useMemo((): {
    fanOutNodeId: string;
    fanOutSourceBlockType: string | null;
  } | null => {
    const selected = graph.nodes.find((node) => node.id === selectedNodeId);
    if (!selected?.parentId) return null;
    const owner = graph.nodes.find((node) => node.id === selected.parentId);
    if (owner?.blockType !== 'fan_out') return null;
    const sourceId = graph.edges.find((edge) => edge.target === owner.id)?.source;
    const sourceBlockType = graph.nodes.find((node) => node.id === sourceId)?.blockType ?? null;
    return { fanOutNodeId: owner.id, fanOutSourceBlockType: sourceBlockType };
  }, [selectedNodeId, graph.nodes, graph.edges]);

  const predecessorIsCustomNode = Boolean(
    predecessorBlockType && isCustomNodeBlockType(predecessorBlockType),
  );

  const selectedNodeVariables = useMemo(() => {
    if (!selectedNodeId) return null;
    return nodeVariablesByNodeId[selectedNodeId] ?? null;
  }, [selectedNodeId, nodeVariablesByNodeId]);

  useEffect(() => {
    runHotkeyRef.current = () => {
      const isRunPending = runMutation.isPending || headerBatch.isPending;
      if (!triggerNode || baselineVersion < 1 || isRunPending || !flowEnabled) return;
      runPrimary();
    };
  }, [triggerNode, baselineVersion, runMutation, headerBatch.isPending, flowEnabled, runPrimary]);

  const handleRun = () => {
    if (!triggerNode) {
      toast.error('Run is only available for flows that start with a manual trigger.');
      return;
    }
    if (baselineVersion < 1) {
      toast.error('Save your flow before running.');
      return;
    }
    if (!flowEnabled) {
      toast.error('This flow is paused. Enable it in Flow settings or the flows list to run.');
      return;
    }
    runPrimary();
  };

  const handleBlurTitle = () => {
    const trimmed = title.trim();
    if (!trimmed || !data || trimmed === data.name) return;
    updateTitleMutation.mutate({ id: flowId, name: trimmed });
  };

  const handleOpenSettings = useCallback(() => {
    setSettingsOpen((open) => {
      if (!open) {
        setSelectedNodeIds([]);
      }
      return !open;
    });
  }, []);

  // Deep-link from a node's missing-project warning: open settings (the panel only renders
  // with no node selected) and bump the nonce so the panel scrolls to + highlights Project.
  const [settingsProjectFocusNonce, setSettingsProjectFocusNonce] = useState(0);
  const handleOpenFlowSettingsAtProject = useCallback(() => {
    setSelectedNodeIds([]);
    setSettingsOpen(true);
    setSettingsProjectFocusNonce((n) => n + 1);
  }, []);

  const selectedNode = useMemo(
    () => graph.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [graph.nodes, selectedNodeId],
  );

  // Back-edges for the current graph (used by ConditionConfig loop settings).
  const backEdgeIds = useMemo(() => findBackEdges(graph), [graph]);

  // True when the selected condition node has at least one back-edge going out from it.
  const selectedNodeIsLoopCondition = useMemo(() => {
    if (selectedNode?.blockType !== 'condition') return false;
    return graph.edges.some((e) => e.source === selectedNode.id && backEdgeIds.has(e.id));
  }, [selectedNode, graph.edges, backEdgeIds]);

  const [savedAgoTick, setSavedAgoTick] = useState(0);
  useEffect(() => {
    if (!lastSavedAt || hasChanges) return;
    const id = setInterval(() => setSavedAgoTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [lastSavedAt, hasChanges]);

  // Save-status UI reflects hasChanges (true content diff), NOT isDirty ("edited since load").
  // Editing then reverting to the saved state must clear "Unsaved changes" \u2014 the same signal that
  // gates the Save button. isDirty stays for nav-guard/beforeUnload (warn on any in-progress edit).
  const saveStatusLabel = useMemo(() => {
    if (saveMutation.isPending) return 'Saving\u2026';
    if (hasChanges) return draftRestored ? 'Draft \u00b7 unsaved changes' : 'Unsaved changes';
    if (lastSavedAt) {
      const diffMs = Date.now() - lastSavedAt.getTime();
      const diffMin = Math.floor(diffMs / 60000);
      if (diffMin < 1) return 'Saved just now';
      if (diffMin < 60) return `Saved ${diffMin}m ago`;
      return 'Saved';
    }
    return null;
    // savedAgoTick is a timer dep that forces re-evaluation every 30s
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveMutation.isPending, hasChanges, draftRestored, lastSavedAt, savedAgoTick]);

  // Revert the working copy to the saved server graph. Non-destructive to saved data, no confirm.
  const handleDiscardDraft = useCallback(() => {
    if (data) applyServerSnapshot(data);
  }, [data, applyServerSnapshot]);

  if ((error || !data) && !isLoading) {
    return (
      <div className="flex flex-col flex-1 items-center justify-center gap-4 p-6">
        <p className="text-sm text-muted-foreground">Could not load this flow.</p>
        <Button type="button" variant="secondary" onClick={() => refetch()}>
          Retry
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" onClick={onBack}>
              Back to list
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="flex items-center gap-2 text-xs">
            <span>Back to flows list</span>
            <Kbd shortcutId="flow-editor-back-to-list" />
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  if (isLoading || !hydrated) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        Loading flow…
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col flex-1 items-center justify-center gap-4 p-6">
        <p className="text-sm text-muted-foreground">Could not load this flow.</p>
        <Button type="button" variant="secondary" onClick={() => refetch()}>
          Retry
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" onClick={onBack}>
              Back to list
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="flex items-center gap-2 text-xs">
            <span>Back to flows list</span>
            <Kbd shortcutId="flow-editor-back-to-list" />
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  const versionLabel = data.version_number != null ? `v${data.version_number}` : null;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <FlowEditorHeader
        flowId={flowId}
        graph={graph}
        onBack={onBack}
        title={title}
        onTitleChange={setTitle}
        onTitleBlur={handleBlurTitle}
        versionLabel={versionLabel}
        save={{
          draftRestored,
          hasChanges,
          label: saveStatusLabel,
          pending: saveMutation.isPending,
          disabled: !validation.valid || saveMutation.isPending || !hasChanges,
          onSave: dispatchSave,
          onDiscardDraft: handleDiscardDraft,
        }}
        overlay={{ state: canvasExecState, runMeta: overlayRunMeta, onClear: clearOverlay }}
        editorTab={editorTab}
        onEditorTabChange={setEditorTab}
        settingsOpen={settingsOpen}
        onToggleSettings={handleOpenSettings}
        onAddStep={() => {
          setCreatorMode({ kind: 'floating' });
          setCreatorOpen(true);
        }}
        run={{
          state: headerRunState,
          isBatchDeferred: headerBatch.hasDeferredRoots,
          disabled: triggerNode == null || baselineVersion < 1 || !flowEnabled,
          pending: runMutation.isPending || headerBatch.isPending,
          onPrimaryStart: handleRun,
        }}
      />

      <AlertDialog open={conflictReloadOpen} onOpenChange={setConflictReloadOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Flow modified elsewhere</AlertDialogTitle>
            <AlertDialogDescription>
              This flow was modified from another location. Reload the latest version? Your local
              unsaved edits will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my edits</AlertDialogCancel>
            <AlertDialogAction onClick={handleConflictReload}>Reload latest</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {!validation.valid && (
        <div
          role="alert"
          aria-live="polite"
          className="px-4 py-2 text-sm text-amber-700 dark:text-amber-400 bg-amber-500/10 border-b border-amber-500/20"
        >
          <div>{validation.errors[0] ?? 'Invalid graph'}</div>
          {warnings.length > 0 ? (
            <div className="mt-1 border-t border-amber-500/20 pt-1 text-xs opacity-90">
              {warnings[0]}
            </div>
          ) : null}
        </div>
      )}
      {validation.valid && warnings.length > 0 ? (
        <div
          role="status"
          aria-live="polite"
          className="px-4 py-2 text-sm text-amber-700 dark:text-amber-400 bg-amber-500/10 border-b border-amber-500/20"
        >
          {warnings[0]}
        </div>
      ) : null}

      {saveError ? (
        <div
          role="alert"
          aria-live="assertive"
          className="px-4 py-2 text-sm text-destructive bg-destructive/10 border-b border-destructive/20 flex items-center justify-between gap-2"
        >
          <span>{saveError}</span>
          <Button type="button" variant="secondary" size="sm" onClick={dispatchSave}>
            Retry save
          </Button>
        </div>
      ) : null}

      {/* Main content: editor/runs + settings panel side-by-side */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex flex-col min-h-0 flex-1">
          {/* Editor view — hidden (not unmounted) when on the Runs tab to preserve canvas state. */}
          <div
            className={cn(
              'flex min-h-0 flex-1 flex-col lg:flex-row',
              editorTab === 'runs' && 'hidden',
            )}
          >
            <FlowCanvas
              graph={graph}
              flowMountKey={`${flowId}:${canvasResetNonce}`}
              selectedNodeIds={selectedNodeIds}
              selectedEdgeId={selectedEdgeId}
              flowDefaultProjectId={graph.settings?.defaultProjectId}
              customBlockIcons={customBlockIcons}
              customNodeInputs={customNodeInputs}
              customFlowCanvasContext={customFlowCanvasContext}
              flowId={flowId}
              canvasHistoricalInspection={Boolean(canvasExecState?.isHistoricalInspection)}
              onSelectNodes={handleSelectNodes}
              onSelectEdge={setSelectedEdgeId}
              onConnect={handleConnect}
              onNodesDelete={handleNodesDelete}
              onEdgesDelete={handleEdgesDelete}
              onNodePosition={handleNodePosition}
              onNodesPosition={handleNodesPosition}
              onNodeResize={(id, size, moved) =>
                updateGraph((g) => resizeNodeInGraph(g, id, size, moved))
              }
              onRemoveNode={handleRemoveNode}
              onRequestInsertOnEdge={handleRequestInsertOnEdge}
              onRequestAddConnectedStep={handleRequestAddConnectedStep}
              onPaneDoubleClickFlowPosition={handlePaneDoubleClickFlowPosition}
              onRequestOpenFlowSettings={handleOpenFlowSettingsAtProject}
            />
            <AnimatePresence>
              {selectedNode ? (
                <motion.div
                  key="flow-config-panel"
                  className="flex shrink-0 flex-col overflow-hidden bg-transparent pl-1"
                  initial={{ width: 0 }}
                  animate={{ width: 380 }}
                  exit={{ width: 0 }}
                  transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
                >
                  <div
                    className={cn(
                      UNIFIED_GLASS_INNER_CLASS,
                      'flex h-full min-h-0 w-[380px] min-w-[380px] flex-col overflow-hidden rounded-xl',
                    )}
                  >
                    <BlockConfigPanel
                      flowId={flowId}
                      flowProjectId={data?.project_id ?? null}
                      selectedNode={selectedNode}
                      isLoopCondition={selectedNodeIsLoopCondition}
                      triggerBlockType={triggerBlockType}
                      webhookTriggerIntegrationId={webhookTriggerIntegrationId}
                      predecessorBlockType={predecessorBlockType}
                      predecessorOfPredecessorBlockType={predecessorOfPredecessorBlockType}
                      predecessorExpectedOutputs={predecessorExpectedOutputs}
                      predecessorOfPredecessorExpectedOutputs={
                        predecessorOfPredecessorExpectedOutputs
                      }
                      ancestorFanOut={ancestorFanOut}
                      nodeVariables={selectedNodeVariables}
                      customNodesLoading={customNodesLoading}
                      predecessorIsCustomNode={predecessorIsCustomNode}
                      onClose={() => setSelectedNodeIds([])}
                      onPatchNode={updateNode}
                      flowSettings={graph.settings}
                      onOpenFlowSettings={handleOpenFlowSettingsAtProject}
                    />
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>

          {/* Runs tab — the single monitoring surface; mounted (hidden via CSS) to preserve
              React Flow viewports. Its rail owns the flow's batch socket subscription. */}
          <FlowRunsTab
            flowId={flowId}
            isVisible={editorTab === 'runs'}
            selectedBatchId={effectiveSelectedBatchId}
            activeBatchId={currentBatchId}
            onSelectBatch={handleSelectBatch}
            selectedStageId={monitorStageId}
            onSelectStage={setMonitorStageId}
            canvasOverlayRunId={canvasExecState?.flowRunId}
            onViewRunOnCanvas={viewRunOnCanvas}
            onRequestEditorTab={() => setEditorTab('editor')}
            railShellClassName={UNIFIED_GLASS_INNER_CLASS}
          />
        </div>

        {/* Settings panel — visible on both Editor and Runs tabs */}
        <AnimatePresence>
          {settingsOpen && !selectedNode ? (
            <motion.div
              key="flow-settings-panel"
              className="flex shrink-0 flex-col overflow-hidden bg-transparent pl-1"
              initial={{ width: 0 }}
              animate={{ width: 380 }}
              exit={{ width: 0 }}
              transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
            >
              <div
                className={cn(
                  UNIFIED_GLASS_INNER_CLASS,
                  'h-full min-h-0 w-[380px] min-w-[380px] rounded-xl',
                )}
              >
                <FlowSettingsPanel
                  flowId={flowId}
                  flowName={data?.name ?? ''}
                  flowDescription={data?.description ?? null}
                  isEnabled={data?.is_enabled ?? true}
                  agentInvocable={data?.agent_invocable ?? false}
                  settings={graph.settings}
                  nodes={graph.nodes}
                  onSettingsChange={updateFlowSettings}
                  onAfterStash={() => {
                    if (!validation.valid) {
                      toast('Briefing stashed — fix flow errors then press ⌘S to save');
                      return;
                    }
                    dispatchSave();
                  }}
                  onClose={() => setSettingsOpen(false)}
                  triggerBlockType={triggerBlockType}
                  currentBatchId={currentBatchId}
                  focusProjectNonce={settingsProjectFocusNonce}
                />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <NodeCreatorPanel
        open={creatorOpen}
        onOpenChange={(open) => {
          setCreatorOpen(open);
          if (!open) setCreatorMode(null);
        }}
        mode={creatorMode}
        allowedTypes={creatorAllowedTypes}
        onPick={handleCreatorPick}
      />
    </div>
  );
}
