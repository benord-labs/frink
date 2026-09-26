import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { FlowVersionConflictError } from '../../db/repos/flow-versions';
import { applyPatchOperations, type PatchOperation, type PatchResult } from './flow-patch';
import {
  buildFlowPatchReceipt,
  buildFlowPatchResult,
  buildFlowPatchUnexpectedError,
  flowPatchError,
  rollbackCreatedFlow,
  rollbackCreatedFlowUnlessPersisted,
} from './flow-patch-result';

const logState = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('electron-log', () => ({ default: { warn: logState.warn } }));

const BASE_GRAPH: FlowGraph = {
  nodes: [
    { id: 'trigger', blockType: 'manual_trigger', label: 'Launch' },
    {
      id: 'agent',
      blockType: 'agent',
      config: { instructions: 'PRIVATE-ORIGINAL' },
    },
  ],
  edges: [{ id: 'launch-agent', source: 'trigger', target: 'agent' }],
};

const UPDATE_OPERATION: PatchOperation = {
  op: 'update_node',
  nodeId: 'agent',
  config: { instructions: 'PRIVATE-PATCHED' },
};

const FINAL_GRAPH: FlowGraph = {
  ...BASE_GRAPH,
  nodes: BASE_GRAPH.nodes.map((node) =>
    node.id === 'agent'
      ? { ...node, config: { ...node.config, instructions: 'PRIVATE-PATCHED' } }
      : node,
  ),
};

type PersistedPatch = Extract<PatchResult, { status: 'success' | 'partial' }>;

function parseResult(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

function successPatch(): PersistedPatch {
  return {
    status: 'success',
    graph: FINAL_GRAPH,
    applied: [0],
    failed: [],
    skipped: [],
  };
}

function receiptFor(patch: PersistedPatch, persistedVersionNumber: unknown) {
  return buildFlowPatchReceipt({
    mode: 'update',
    baseGraph: BASE_GRAPH,
    finalGraph: patch.graph,
    operations: [UPDATE_OPERATION],
    applied: patch.applied,
    failed: patch.failed,
    skipped: patch.skipped,
    baseVersionNumber: 3,
    persistedVersionNumber,
  });
}

function resultFor(patch: PersistedPatch, persistedVersionNumber: unknown) {
  return buildFlowPatchResult({
    patch,
    receipt: receiptFor(patch, persistedVersionNumber),
    flowId: 'flow-patch',
    versionId: 'version-4',
    name: 'Release flow',
    operationCount: 1,
    creationProjectNote: null,
    createdFlow: false,
    templateWarnings: [],
    webhookSetup: [],
  });
}

describe('Flow patch result presentation', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('builds a saved receipt without exposing patched config values', () => {
    const patch = successPatch();
    const receipt = receiptFor(patch, 4);
    const body = parseResult(resultFor(patch, 4));

    expect(receipt).toEqual(
      expect.objectContaining({ versionNumber: 4, versionSaved: true, persistence: 'saved' }),
    );
    expect(receipt.flowChange).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        baseVersionNumber: 3,
        versionNumber: 4,
        changes: [
          expect.objectContaining({
            operationIndex: 0,
            label: 'Agent',
            detail: 'Instructions',
            status: 'applied',
          }),
        ],
      }),
    );
    expect(JSON.stringify(receipt.flowChange)).not.toContain('PRIVATE-PATCHED');
    expect(body).toEqual(
      expect.objectContaining({
        status: 'success',
        persistence: 'saved',
        versionNumber: 4,
        flowChange: receipt.flowChange,
      }),
    );
  });

  it('marks an identical durable graph unchanged and explains the no-op', () => {
    const patch = successPatch();
    const receipt = receiptFor(patch, 3);
    const body = parseResult(resultFor(patch, 3));

    expect(receipt).toEqual(
      expect.objectContaining({ versionNumber: 3, versionSaved: false, persistence: 'unchanged' }),
    );
    expect(receipt.flowChange.changes[0]?.status).toBe('unchanged');
    expect(body.message).toContain('already current');
  });

  it('presents partial operation statuses, retry indexes, and the partial warning', () => {
    const missingOperation: PatchOperation = {
      op: 'update_node',
      nodeId: 'missing',
      config: {},
    };
    const patch: PersistedPatch = {
      status: 'partial',
      graph: FINAL_GRAPH,
      applied: [1],
      failed: [{ index: 0, error: 'missing' }],
      skipped: [],
    };
    const receipt = buildFlowPatchReceipt({
      mode: 'update',
      baseGraph: BASE_GRAPH,
      finalGraph: FINAL_GRAPH,
      operations: [missingOperation, UPDATE_OPERATION],
      applied: patch.applied,
      failed: patch.failed,
      skipped: patch.skipped,
      baseVersionNumber: 3,
      persistedVersionNumber: 4,
    });
    const result = buildFlowPatchResult({
      patch,
      receipt,
      flowId: 'flow-patch',
      versionId: 'version-4',
      name: 'Release flow',
      operationCount: 2,
      creationProjectNote: null,
      createdFlow: false,
      templateWarnings: [],
      webhookSetup: [],
    });
    const body = parseResult(result);

    expect(receipt.flowChange.changes.map((change) => change.status)).toEqual([
      'failed',
      'applied',
    ]);
    expect(body).toEqual(
      expect.objectContaining({ status: 'partial', persistence: 'saved', retryOps: [0] }),
    );
    expect(body.templateWarnings).toEqual([expect.stringContaining('graph is partial')]);
    expect(body.message).toContain('Re-send the operations listed in retryOps');
  });

  it('excludes already-satisfied skips from retryOps and states nothing needs retrying', () => {
    const redundantOperation: PatchOperation = { op: 'remove_node', nodeId: 'gone' };
    const patch: PersistedPatch = {
      status: 'partial',
      graph: FINAL_GRAPH,
      applied: [1],
      failed: [],
      skipped: [{ index: 0, reason: 'already removed', code: 'cascade-removed' }],
    };
    const body = parseResult(
      buildFlowPatchResult({
        patch,
        receipt: buildFlowPatchReceipt({
          mode: 'update',
          baseGraph: BASE_GRAPH,
          finalGraph: FINAL_GRAPH,
          operations: [redundantOperation, UPDATE_OPERATION],
          applied: patch.applied,
          failed: patch.failed,
          skipped: patch.skipped,
          baseVersionNumber: 3,
          persistedVersionNumber: 4,
        }),
        flowId: 'flow-patch',
        versionId: 'version-4',
        name: 'Release flow',
        operationCount: 2,
        creationProjectNote: null,
        createdFlow: false,
        templateWarnings: [],
        webhookSetup: [],
      }),
    );

    expect(body.retryOps).toEqual([]);
    expect(body.message).not.toMatch(/Re-send the operations/);
    expect(body.message).toContain('Nothing needs retrying');
    expect(body).not.toHaveProperty('templateWarnings');
  });

  it('returns a structured no-write error receipt', () => {
    const result = flowPatchError("Operation 1: node 'missing' not found", 'none');

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toEqual(
      expect.objectContaining({
        status: 'failure',
        persistence: 'none',
        message: expect.stringContaining('not found'),
      }),
    );
  });

  it('confirms successful rollback and releases the creation slot', async () => {
    const deleteFlow = vi.fn().mockResolvedValue(undefined);
    const releaseCreateSlot = vi.fn();

    const rollback = await rollbackCreatedFlow({
      flowId: 'created-flow',
      context: 'patch auto-create',
      deleteFlow,
      releaseCreateSlot,
    });

    expect(rollback).toEqual({ confirmed: true });
    expect(deleteFlow).toHaveBeenCalledWith('created-flow');
    expect(releaseCreateSlot).toHaveBeenCalledOnce();
  });

  it('keeps a failed rollback reachable for patch and command-expansion failures', async () => {
    const deleteFlow = vi.fn().mockRejectedValue(new Error('delete failed'));
    const releaseCreateSlot = vi.fn();

    const rollback = await rollbackCreatedFlow({
      flowId: 'surviving-flow',
      context: 'command-expansion',
      deleteFlow,
      releaseCreateSlot,
    });
    const result = buildFlowPatchUnexpectedError({
      error: new Error('save failed'),
      hadCreatedFlow: true,
      rollback,
      persistenceAttempted: true,
    });
    const body = parseResult(result);

    expect(rollback).toEqual({ confirmed: false, recoveryFlowId: 'surviving-flow' });
    expect(body).toEqual(
      expect.objectContaining({
        status: 'failure',
        flowId: 'surviving-flow',
        message: expect.stringContaining('save failed'),
      }),
    );
    expect(body).not.toHaveProperty('persistence');
    expect(logState.warn).toHaveBeenCalledWith(
      '[flows-tools] command-expansion rollback failed:',
      expect.any(Error),
    );
    expect(releaseCreateSlot).toHaveBeenCalledOnce();
  });

  it('preserves an auto-created Flow after its version has persisted', async () => {
    const deleteFlow = vi.fn().mockResolvedValue(undefined);
    const releaseCreateSlot = vi.fn();

    const rollback = await rollbackCreatedFlowUnlessPersisted({
      flowId: 'persisted-flow',
      context: 'patch auto-create',
      deleteFlow,
      releaseCreateSlot,
      persistenceCompleted: true,
    });
    const body = parseResult(
      buildFlowPatchUnexpectedError({
        error: new Error('response assembly failed'),
        hadCreatedFlow: true,
        rollback,
        persistenceAttempted: true,
      }),
    );

    expect(deleteFlow).not.toHaveBeenCalled();
    expect(releaseCreateSlot).not.toHaveBeenCalled();
    expect(rollback).toEqual({ confirmed: false, recoveryFlowId: 'persisted-flow' });
    expect(body).toEqual(
      expect.objectContaining({
        status: 'failure',
        flowId: 'persisted-flow',
        message: expect.stringContaining('response assembly failed'),
      }),
    );
    expect(body).not.toHaveProperty('persistence');
  });

  it('gives local optimistic-concurrency failures the stale response contract', () => {
    const result = buildFlowPatchUnexpectedError({
      error: new FlowVersionConflictError('flow-patch', 3, 9),
      hadCreatedFlow: false,
      rollback: { confirmed: true },
      persistenceAttempted: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('conflict');
    expect(result.content[0]?.text).toContain('9');
  });

  it('preserves version conflicts and created-flow rollback certainty', () => {
    const existingResult = buildFlowPatchUnexpectedError({
      error: new FlowVersionConflictError('flow-patch', 3, 8),
      hadCreatedFlow: false,
      rollback: { confirmed: true },
      persistenceAttempted: true,
    });
    const createdResult = buildFlowPatchUnexpectedError({
      error: new FlowVersionConflictError('flow-patch', 0, 8),
      hadCreatedFlow: true,
      rollback: { confirmed: true },
      persistenceAttempted: true,
    });
    const survivingCreatedResult = buildFlowPatchUnexpectedError({
      error: new FlowVersionConflictError('flow-patch', 0, 8),
      hadCreatedFlow: true,
      rollback: { confirmed: false, recoveryFlowId: 'surviving-flow' },
      persistenceAttempted: true,
    });

    expect(parseResult(existingResult)).toEqual(
      expect.objectContaining({
        status: 'failure',
        persistence: 'none',
        errorCode: 'FLOW_VERSION_CONFLICT',
        message: expect.stringContaining('8'),
      }),
    );
    expect(parseResult(createdResult)).toEqual(
      expect.objectContaining({
        status: 'failure',
        persistence: 'none',
        errorCode: 'FLOW_VERSION_CONFLICT',
        message: expect.stringContaining('newly created Flow'),
      }),
    );
    expect(parseResult(survivingCreatedResult)).toEqual(
      expect.objectContaining({
        status: 'failure',
        errorCode: 'FLOW_VERSION_CONFLICT',
        flowId: 'surviving-flow',
      }),
    );
    expect(parseResult(survivingCreatedResult)).not.toHaveProperty('persistence');
  });
});

describe('frink_flows_patch sessions note', () => {
  const START = { id: 'session', blockType: 'start_task', label: 'Night report' };

  function graphWith(...nodes: FlowGraph['nodes']): FlowGraph {
    return { nodes: [{ id: 'trigger', blockType: 'manual_trigger' }, ...nodes], edges: [] };
  }

  function sessionsFor(graph: FlowGraph, status: 'success' | 'partial' = 'success'): unknown {
    const patch: PersistedPatch =
      status === 'success'
        ? { status, graph, applied: [0], failed: [], skipped: [] }
        : { status, graph, applied: [0], failed: [{ index: 1, error: 'boom' }], skipped: [] };
    return parseResult(resultFor(patch, 4)).sessions;
  }

  it('stays silent for a single-session flow', () => {
    expect(sessionsFor(graphWith(START))).toBeUndefined();
  });

  it('names every Start Task and flags the per-item one inside a Fan Out', () => {
    const graph = graphWith(
      START,
      { id: 'hunt', blockType: 'fan_out' },
      { id: 'lane', blockType: 'start_task', label: 'Per-area worktree', parentId: 'hunt' },
    );

    const note = sessionsFor(graph);

    expect(note).toContain('2 Start Tasks: "Night report", "Per-area worktree" (inside Fan Out');
    expect(note).toContain('one chat per item');
  });

  it('counts Start Tasks on exclusive branches without claiming both run', () => {
    const graph = graphWith(START, { id: 'other', blockType: 'start_task', label: 'Fallback' });

    const note = sessionsFor(graph);

    expect(note).toContain('2 Start Tasks');
    expect(note).toContain('Each one that runs');
  });

  it('carries the note on partial saves too', () => {
    const graph = graphWith(START, { id: 'other', blockType: 'start_task' });

    expect(sessionsFor(graph, 'partial')).toContain('2 Start Tasks');
  });
});

describe('frink_flows_patch partial receipt — real engine output', () => {
  /** Fan Out owning one body step, so remove_node cascades to the body. */
  const CASCADE_GRAPH: FlowGraph = {
    nodes: [
      { id: 'trigger', blockType: 'manual_trigger', label: 'Launch' },
      { id: 'fan', blockType: 'fan_out', label: 'For each item' },
      { id: 'body', blockType: 'agent', parentId: 'fan', config: { instructions: 'per item' } },
    ],
    edges: [
      { id: 'launch-fan', source: 'trigger', target: 'fan' },
      { id: 'fan-body', source: 'fan', target: 'body' },
    ],
  };

  it('tells the agent nothing needs retrying for the reported cascade scenario', () => {
    const operations: PatchOperation[] = [
      { op: 'remove_node', nodeId: 'fan' },
      { op: 'remove_node', nodeId: 'body' },
    ];
    const patch = applyPatchOperations(CASCADE_GRAPH, operations);

    expect(patch.status).toBe('partial');
    if (patch.status !== 'partial') return;

    const body = parseResult(
      buildFlowPatchResult({
        patch,
        receipt: buildFlowPatchReceipt({
          mode: 'update',
          baseGraph: CASCADE_GRAPH,
          finalGraph: patch.graph,
          operations,
          applied: patch.applied,
          failed: patch.failed,
          skipped: patch.skipped,
          baseVersionNumber: 3,
          persistedVersionNumber: 4,
        }),
        flowId: 'flow-cascade',
        versionId: 'version-4',
        name: 'Cascade flow',
        operationCount: operations.length,
        creationProjectNote: null,
        createdFlow: false,
        templateWarnings: [],
        webhookSetup: [],
      }),
    );

    expect(body.status).toBe('partial');
    expect(body.retryOps).toEqual([]);
    expect(body.message).toContain('Nothing needs retrying');
    expect(body.message).not.toMatch(/Re-send the operations/);
    const flowChange = body.flowChange as { changes: Array<{ reasonCode?: string }> };
    expect(flowChange.changes[1]?.reasonCode).toBe('cascade-removed');
  });
});
