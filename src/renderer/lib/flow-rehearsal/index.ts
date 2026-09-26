/**
 * Ghost Run rehearsal engine + state (Phase 1: local, synchronous static analysis).
 *
 * This domain OWNS the ghost atoms/types and the analysis wiring so it stays out of the feature
 * folder (which is UI-only) and the renderer import-wall stays clean (feature → lib is the allowed
 * direction; lib never reaches into a feature).
 *
 * The verdict is a PURE FUNCTION of node config + graph topology (`analyzeFlow` in `./analyze`):
 * NO node-id hashing, NO Math.random / Date.now. Two identical nodes therefore get IDENTICAL
 * findings, and a clean flow reports zero findings ("looks ready"). Each finding is explainable —
 * it names the node, says why in plain English, and gives a concrete fix. Results are written to a
 * ghost atom family deliberately PARALLEL to the live-run `nodeExecAtomFamily`, so a rehearsal
 * never mutates real execution state.
 *
 * PHASE 2 seam: `rehearseFlow` is intentionally async with a stable signature. A real
 * agent-understudy simulation (a model that walks each node and predicts probabilistic outcomes)
 * would APPEND its findings to the static ones — never replace them — keeping this deterministic
 * floor intact. The seam is marked inline below.
 */

import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { CustomNodeInputsByType } from '../../../shared/lib/flows/custom-node-required-inputs';
import type { FlowGraph } from '../../../shared/lib/validate-flow-graph';
import { appStore } from '../jotai-store';
import {
  analyzeFlow,
  type FindingSeverity,
  nodeSeverity,
  type RehearsalFinding,
  riskiestNodeId,
} from './analyze';

export type { RehearsalFinding } from './analyze';

/** Ghost paint status for a node, derived from the severity of its findings. */
type GhostNodeStatus = 'completed' | 'failed' | 'warn';

export type GhostNodeState = {
  /** `completed` = no findings (neutral ghost); `failed` = has an error; `warn` = warn/info only. */
  status: GhostNodeStatus;
  /** Real findings attached to this node (config + topology). Empty for a clean node. */
  findings: RehearsalFinding[];
  /** True for the single highest-severity node — gets the crimson at-risk halo. */
  isAtRisk?: boolean;
};

/** Header-strip summary of the rehearsal: honest, real counts + the at-risk node. */
export type GhostRunHeaderState = {
  /** Total findings across the whole flow. */
  findingCount: number;
  /** Number of distinct nodes that have at least one finding. */
  affectedNodeCount: number;
  /** Count of `error`-severity findings (the blocking ones). */
  errorCount: number;
  nodeCount: number;
  /** Every finding, ordered deterministically — drives the findings panel. */
  findings: RehearsalFinding[];
  /** Node id of the highest-severity finding (focus target). */
  riskiestNodeId: string | null;
  riskiestNodeLabel: string;
};

/** True while a rehearsal overlay is painted. Cleared on Escape and when the flow changes. */
export const ghostRunActiveAtom = atom<boolean>(false);

/**
 * Per-node predicted state keyed by `${flowId}:${nodeId}` — same key format as
 * `nodeExecAtomFamily` so the canvas reads the matching node with zero key drift.
 */
export const ghostExecAtomFamily = atomFamily((_key: string) => atom<GhostNodeState | null>(null));

/** Non-null while a rehearsal is active; drives the GhostRunHeaderStrip + findings panel. */
export const ghostRunHeaderStateAtom = atom<GhostRunHeaderState | null>(null);

/** Maps a node's highest finding severity to its ghost paint status. */
function statusForSeverity(severity: FindingSeverity | null): GhostNodeStatus {
  if (severity === 'error') return 'failed';
  if (severity === 'warn' || severity === 'info') return 'warn';
  return 'completed';
}

/**
 * Run the static pre-flight analysis, write per-node ghost atoms + a header summary, and mark the
 * single highest-severity node at-risk. Async with a stable signature for the Phase 2 seam.
 *
 * @returns per-node ghost state (also exposed for tests).
 */
export async function rehearseFlow(
  flowId: string,
  graph: FlowGraph,
  customNodeInputs?: CustomNodeInputsByType,
): Promise<Map<string, GhostNodeState>> {
  // ── PHASE 2 seam ────────────────────────────────────────────────────────────
  // Replace/augment this synchronous static pass with an agent-understudy sim:
  //   const sim = await window.desktopApi.invokeFlowsApi('rehearse', { flowId, graph });
  //   findings.push(...sim.findings);  // APPEND — never drop the deterministic static findings.
  // Keep the atom-write + header-summary shape below so the canvas contract is stable.
  const findings = analyzeFlow(graph, customNodeInputs);
  // ── end PHASE 2 seam ─────────────────────────────────────────────────────────

  const findingsByNode = new Map<string, RehearsalFinding[]>();
  for (const f of findings) {
    const list = findingsByNode.get(f.nodeId) ?? [];
    list.push(f);
    findingsByNode.set(f.nodeId, list);
  }

  const atRiskNodeId = riskiestNodeId(findings);

  const states = new Map<string, GhostNodeState>();
  for (const node of graph.nodes) {
    const nodeFindings = findingsByNode.get(node.id) ?? [];
    const state: GhostNodeState = {
      status: statusForSeverity(nodeSeverity(nodeFindings)),
      findings: nodeFindings,
      // atRiskNodeId is a finding's nodeId (from riskiestNodeId), so it always has ≥1 finding.
      ...(node.id === atRiskNodeId ? { isAtRisk: true } : {}),
    };
    states.set(node.id, state);
    appStore.set(ghostExecAtomFamily(`${flowId}:${node.id}`), state);
  }

  appStore.set(ghostRunHeaderStateAtom, {
    findingCount: findings.length,
    affectedNodeCount: findingsByNode.size,
    errorCount: findings.filter((f) => f.severity === 'error').length,
    nodeCount: graph.nodes.length,
    findings,
    riskiestNodeId: atRiskNodeId,
    // Read the label off the at-risk node's own finding (no second node walk).
    riskiestNodeLabel: findingsByNode.get(atRiskNodeId ?? '')?.[0]?.nodeLabel ?? '',
  });

  return states;
}

/**
 * Clear a rehearsal: blank every ghost atom for the flow + the header. Called on Escape and
 * when the flow changes so ghost paint never leaks across flows.
 */
export function clearRehearsal(flowId: string, graph: FlowGraph): void {
  for (const node of graph.nodes) {
    appStore.set(ghostExecAtomFamily(`${flowId}:${node.id}`), null);
  }
  appStore.set(ghostRunHeaderStateAtom, null);
}
