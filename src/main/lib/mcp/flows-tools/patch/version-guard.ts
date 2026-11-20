/** Stale-read guard for frink_flows_patch: the caller's read→patch window, which the DB guard cannot see. */
import { canonicalStringify } from '../../../../../shared/lib/canonical-stringify';
import {
  type FlowGraph,
  type FlowNode,
  formatFlowNodeLabel,
} from '../../../../../shared/lib/validate-flow-graph';
import type { McpToolResult } from '../../tool-result';
import type { PatchOperation } from '../flow-patch';
import { flowPatchVersionConflictError } from '../flow-patch-result';

const DRIFT_LIST_CAP = 20;
const EMPTY_GRAPH: FlowGraph = { nodes: [], edges: [] };

type DriftNode = {
  id: string;
  label: string;
  change: 'added' | 'removed' | 'changed';
  /** Changed keys (`label`, `parentId`, `config.<key>`); never their values. */
  keys?: string[];
};

export type FlowVersionDrift = {
  nodes: DriftNode[];
  /** Nodes whose only change is position or size. */
  moved: string[];
  edges: string[];
  settingsKeys: string[];
};

type FlowVersionDriftSummary = FlowVersionDrift & {
  fromVersion: number;
  toVersion: number;
  omitted?: number;
};

export type FlowVersionGuardResult =
  | { ok: true; concurrentChanges?: FlowVersionDriftSummary & { note: string } }
  | { ok: false; result: McpToolResult };

type GuardParams = {
  flowId: string;
  latestVersion: number;
  latestGraph: FlowGraph;
  expected: number | null | undefined;
  sessionId?: string;
  operations: PatchOperation[];
  loadVersionGraph: (flowId: string, versionNumber: number) => Promise<FlowGraph | null>;
};

type KnownVersion = { version: number; wrote: boolean };
const knownVersions = new Map<string, KnownVersion>();

function knownKey(sessionId: string, flowId: string): string {
  return `${sessionId}\u0000${flowId}`;
}

/** Remember the flow version this chat last read (`wrote: false`) or saved (`wrote: true`). */
export function recordKnownFlowVersion(
  sessionId: string | undefined,
  flowId: string,
  version: number,
  wrote = false,
): void {
  if (!sessionId) return;
  const key = knownKey(sessionId, flowId);
  const prior = knownVersions.get(key);
  // A read or save that settles after a newer one never moves the record backwards.
  if (prior && prior.version > version) return;
  // Re-reading the version this chat saved keeps it marked as the chat's own.
  knownVersions.set(key, { version, wrote: wrote || (prior?.version === version && prior.wrote) });
}

const ownPatchTails = new Map<string, Promise<void>>();

/** Queue one chat's patches to a flow, so each reads the flow after the previous one recorded its save. */
export async function queueOwnFlowPatch(
  sessionId: string | undefined,
  flowId: string,
): Promise<() => void> {
  if (!sessionId) return () => {};
  const key = knownKey(sessionId, flowId);
  const previous = ownPatchTails.get(key) ?? Promise.resolve();
  let release = () => {};
  const tail = previous.then(() => new Promise<void>((resolve) => (release = resolve)));
  ownPatchTails.set(key, tail);
  await previous;
  return () => {
    release();
    if (ownPatchTails.get(key) === tail) ownPatchTails.delete(key);
  };
}

export function resetKnownFlowVersions(): void {
  knownVersions.clear();
}

function knownVersion(sessionId: string | undefined, flowId: string): KnownVersion | undefined {
  return sessionId ? knownVersions.get(knownKey(sessionId, flowId)) : undefined;
}

/** canonicalStringify maps a missing value and null to the same string; drift must tell them apart. */
function fingerprint(value: unknown): string {
  return value === undefined ? '\u0000absent' : canonicalStringify(value);
}

function changedKeys(from: FlowNode, to: FlowNode): { content: string[]; moved: boolean } {
  const content: string[] = [];
  for (const key of ['blockType', 'label', 'parentId'] as const) {
    if (fingerprint(from[key]) !== fingerprint(to[key])) content.push(key);
  }
  const fromConfig = from.config ?? {};
  const toConfig = to.config ?? {};
  for (const key of new Set([...Object.keys(fromConfig), ...Object.keys(toConfig)])) {
    if (fingerprint(fromConfig[key]) !== fingerprint(toConfig[key])) {
      content.push(`config.${key}`);
    }
  }
  const moved =
    fingerprint(from.position) !== fingerprint(to.position) ||
    fingerprint(from.size) !== fingerprint(to.size);
  return { content: content.sort(), moved };
}

function diffById<T extends { id: string }>(from: T[], to: T[]): string[] {
  const before = new Map(from.map((item) => [item.id, canonicalStringify(item)]));
  const after = new Map(to.map((item) => [item.id, canonicalStringify(item)]));
  const ids = new Set([...before.keys(), ...after.keys()]);
  return [...ids].filter((id) => before.get(id) !== after.get(id)).sort();
}

/** What changed between two versions of a flow graph, by id and key only. */
export function computeFlowVersionDrift(from: FlowGraph, to: FlowGraph): FlowVersionDrift {
  const before = new Map(from.nodes.map((node) => [node.id, node]));
  const after = new Map(to.nodes.map((node) => [node.id, node]));
  const nodes: DriftNode[] = [];
  const moved: string[] = [];
  for (const [id, node] of after) {
    const prior = before.get(id);
    if (!prior) {
      nodes.push({ id, label: formatFlowNodeLabel(node), change: 'added' });
      continue;
    }
    const diff = changedKeys(prior, node);
    if (diff.content.length > 0) {
      nodes.push({ id, label: formatFlowNodeLabel(node), change: 'changed', keys: diff.content });
    } else if (diff.moved) {
      moved.push(id);
    }
  }
  for (const [id, node] of before) {
    if (!after.has(id)) nodes.push({ id, label: formatFlowNodeLabel(node), change: 'removed' });
  }
  const fromSettings = (from.settings ?? {}) as Record<string, unknown>;
  const toSettings = (to.settings ?? {}) as Record<string, unknown>;
  const settingsKeys = [...new Set([...Object.keys(fromSettings), ...Object.keys(toSettings)])]
    .filter((key) => fingerprint(fromSettings[key]) !== fingerprint(toSettings[key]))
    .sort();
  return {
    nodes: nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    moved: moved.sort(),
    edges: diffById(from.edges, to.edges),
    settingsKeys,
  };
}

function isEmptyDrift(drift: FlowVersionDrift): boolean {
  return (
    drift.nodes.length + drift.moved.length + drift.edges.length + drift.settingsKeys.length === 0
  );
}

function summarizeDrift(
  drift: FlowVersionDrift,
  fromVersion: number,
  toVersion: number,
): FlowVersionDriftSummary {
  let omitted = 0;
  const cap = <T>(list: T[]): T[] => {
    omitted += Math.max(0, list.length - DRIFT_LIST_CAP);
    return list.slice(0, DRIFT_LIST_CAP);
  };
  const summary: FlowVersionDriftSummary = {
    fromVersion,
    toVersion,
    nodes: cap(drift.nodes),
    moved: cap(drift.moved),
    edges: cap(drift.edges),
    settingsKeys: cap(drift.settingsKeys),
  };
  return omitted > 0 ? { ...summary, omitted } : summary;
}

type PatchTargets = { nodes: Set<string>; edges: Set<string>; settingsKeys: Set<string> };

/** remove_node also deletes the node's Fan Out children and every edge touching them (flow-patch.ts). */
function addRemovalCascade(targets: PatchTargets, graph: FlowGraph, nodeId: string): void {
  const removed = new Set([nodeId]);
  for (const node of graph.nodes) if (node.parentId === nodeId) removed.add(node.id);
  for (const id of removed) targets.nodes.add(id);
  for (const edge of graph.edges) {
    if (removed.has(edge.source) || removed.has(edge.target)) targets.edges.add(edge.id);
  }
}

/** Ids and keys a patch replaces or deletes. Position/size-only updates and auto_layout touch none. */
export function patchTargets(operations: PatchOperation[], graph: FlowGraph = EMPTY_GRAPH): PatchTargets {
  const targets: PatchTargets = { nodes: new Set(), edges: new Set(), settingsKeys: new Set() };
  for (const op of operations) {
    switch (op.op) {
      case 'update_node':
        if (op.label !== undefined || op.config !== undefined || op.parentId !== undefined) {
          targets.nodes.add(op.nodeId);
        }
        break;
      case 'remove_node':
        addRemovalCascade(targets, graph, op.nodeId);
        break;
      case 'add_node':
        targets.nodes.add(op.node.id);
        break;
      case 'update_edge':
      case 'remove_edge':
        targets.edges.add(op.edgeId);
        break;
      case 'add_edge':
        targets.edges.add(op.edge.id);
        break;
      case 'update_settings':
        for (const key of Object.keys(op.settings)) targets.settingsKeys.add(key);
        break;
      case 'auto_layout':
        break;
    }
  }
  return targets;
}

function overlapping(drift: FlowVersionDrift, targets: PatchTargets): string[] {
  return [
    ...drift.nodes
      .filter((node) => targets.nodes.has(node.id))
      .map((node) => `node "${node.label}" (${node.id})`),
    ...drift.edges.filter((id) => targets.edges.has(id)).map((id) => `edge ${id}`),
    ...drift.settingsKeys
      .filter((key) => targets.settingsKeys.has(key))
      .map((key) => `setting ${key}`),
  ];
}

async function versionGraph(params: GuardParams, versionNumber: number): Promise<FlowGraph | null> {
  if (versionNumber === 0) return EMPTY_GRAPH;
  return params.loadVersionGraph(params.flowId, versionNumber);
}

function retryHint(latest: number): string {
  return ` Nothing was saved. Call frink_flows_get, re-apply your edits to the latest graph, and pass expectedVersionNumber: ${latest}.`;
}

async function checkExpected(params: GuardParams, expected: number): Promise<FlowVersionGuardResult> {
  const latest = params.latestVersion;
  if (expected === latest) return { ok: true };
  const fromGraph = expected < latest ? await versionGraph(params, expected) : null;
  const drift = fromGraph
    ? summarizeDrift(computeFlowVersionDrift(fromGraph, params.latestGraph), expected, latest)
    : undefined;
  const known = knownVersion(params.sessionId, params.flowId);
  const ownWrite =
    known?.wrote && known.version === latest
      ? ` Your previous patch in this chat saved version ${latest}; pass the versionNumber each patch returns as the next expectedVersionNumber.`
      : '';
  const cause =
    expected > latest
      ? `expectedVersionNumber ${expected} is newer than the latest saved version ${latest}.`
      : `The flow changed since version ${expected}; the latest is version ${latest}.`;
  return {
    ok: false,
    result: flowPatchVersionConflictError(`${cause}${retryHint(latest)}${ownWrite}`, 'none', undefined, {
      currentVersionNumber: latest,
      expectedVersionNumber: expected,
      ...(drift ? { drift } : {}),
    }),
  };
}

async function checkKnown(params: GuardParams): Promise<FlowVersionGuardResult> {
  const latest = params.latestVersion;
  const known = knownVersion(params.sessionId, params.flowId);
  if (!known || known.version >= latest) return { ok: true };
  const fromGraph = await versionGraph(params, known.version);
  if (!fromGraph) {
    const message = `The flow changed since this chat last read version ${known.version}, and that version can no longer be loaded to check what changed; the latest is version ${latest}.${retryHint(latest)}`;
    return {
      ok: false,
      result: flowPatchVersionConflictError(message, 'none', undefined, {
        currentVersionNumber: latest,
        knownVersionNumber: known.version,
      }),
    };
  }
  const fullDrift = computeFlowVersionDrift(fromGraph, params.latestGraph);
  if (isEmptyDrift(fullDrift)) return { ok: true };
  const drift = summarizeDrift(fullDrift, known.version, latest);
  const overlap = overlapping(fullDrift, patchTargets(params.operations, params.latestGraph));
  if (overlap.length === 0) {
    return {
      ok: true,
      concurrentChanges: {
        ...drift,
        note: `Another session saved changes after this chat last read version ${known.version}; they were kept and this patch was applied on top of version ${latest}.`,
      },
    };
  }
  const message = `Another session changed ${overlap.join(', ')} after this chat last read version ${known.version}; the latest is version ${latest}, and this patch would overwrite that change.${retryHint(latest)}`;
  return {
    ok: false,
    result: flowPatchVersionConflictError(message, 'none', undefined, {
      currentVersionNumber: latest,
      knownVersionNumber: known.version,
      drift,
    }),
  };
}

/** Reject (or annotate) a patch whose caller's view of the flow is older than the latest version. */
export async function checkFlowVersionGuard(params: GuardParams): Promise<FlowVersionGuardResult> {
  if (params.expected !== undefined) return checkExpected(params, params.expected ?? 0);
  return checkKnown(params);
}
