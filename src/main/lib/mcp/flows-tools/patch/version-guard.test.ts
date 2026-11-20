import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import type { PatchOperation } from '../flow-patch';
import {
  checkFlowVersionGuard,
  computeFlowVersionDrift,
  patchTargets,
  recordKnownFlowVersion,
  resetKnownFlowVersions,
} from './version-guard';

const BASE: FlowGraph = {
  nodes: [
    { id: 'trigger', blockType: 'manual_trigger' },
    { id: 'track', blockType: 'agent', label: 'Track', config: { instructions: 'old secret text' } },
    { id: 'other', blockType: 'agent', config: { instructions: 'x' }, position: { x: 0, y: 0 } },
  ],
  edges: [{ id: 'e1', source: 'trigger', target: 'track' }],
  settings: { maxBatchConcurrency: 1 },
};

const LATEST: FlowGraph = {
  nodes: [
    { id: 'trigger', blockType: 'manual_trigger' },
    { id: 'track', blockType: 'agent', label: 'Track', config: { instructions: 'new secret text' } },
    { id: 'other', blockType: 'agent', config: { instructions: 'x' }, position: { x: 50, y: 0 } },
    { id: 'added', blockType: 'end' },
  ],
  edges: [{ id: 'e1', source: 'trigger', target: 'track', label: 'go' }],
  settings: { maxBatchConcurrency: 2 },
};

const editTrack: PatchOperation[] = [
  { op: 'update_node', nodeId: 'track', config: { instructions: 'mine' } },
];

function guard(overrides: Partial<Parameters<typeof checkFlowVersionGuard>[0]> = {}) {
  return checkFlowVersionGuard({
    flowId: 'flow-1',
    latestVersion: 66,
    latestGraph: LATEST,
    expected: undefined,
    sessionId: 'chat-a',
    operations: editTrack,
    loadVersionGraph: vi.fn(async () => BASE),
    ...overrides,
  });
}

function body(result: Awaited<ReturnType<typeof guard>>) {
  if (result.ok) throw new Error('expected a conflict');
  return JSON.parse(result.result.content[0]?.text ?? '{}');
}

afterEach(() => resetKnownFlowVersions());

describe('computeFlowVersionDrift', () => {
  it('reports ids and keys, separates moves from content edits, and never echoes values', () => {
    const drift = computeFlowVersionDrift(BASE, LATEST);
    expect(drift).toEqual({
      nodes: [
        { id: 'added', label: expect.any(String), change: 'added' },
        { id: 'track', label: 'Track', change: 'changed', keys: ['config.instructions'] },
      ],
      moved: ['other'],
      edges: ['e1'],
      settingsKeys: ['maxBatchConcurrency'],
    });
    expect(JSON.stringify(drift)).not.toContain('secret');
  });
});

it('tells a config key or setting set to null apart from one that was never there', () => {
  const before: FlowGraph = { nodes: [{ id: 'a', blockType: 'agent', config: {} }], edges: [] };
  const after: FlowGraph = {
    nodes: [{ id: 'a', blockType: 'agent', config: { model: null } }],
    edges: [],
    settings: { codexSpeed: null } as unknown as FlowGraph['settings'],
  };
  const drift = computeFlowVersionDrift(before, after);
  expect(drift.nodes).toEqual([{ id: 'a', label: expect.any(String), change: 'changed', keys: ['config.model'] }]);
  expect(drift.settingsKeys).toEqual(['codexSpeed']);
});

describe('patchTargets', () => {
  it('counts content edits but not position-only updates or auto_layout', () => {
    const targets = patchTargets([
      { op: 'update_node', nodeId: 'moved-only', position: { x: 1, y: 1 } },
      { op: 'update_node', nodeId: 'relabelled', label: 'New' },
      { op: 'remove_edge', edgeId: 'e9' },
      { op: 'update_settings', settings: { maxBatchConcurrency: 3 } },
      { op: 'auto_layout' },
    ]);
    expect([...targets.nodes]).toEqual(['relabelled']);
    expect([...targets.edges]).toEqual(['e9']);
    expect([...targets.settingsKeys]).toEqual(['maxBatchConcurrency']);
  });
});

describe('checkFlowVersionGuard — explicit expectedVersionNumber', () => {
  it('passes when the expected version is the latest', async () => {
    const loadVersionGraph = vi.fn();
    await expect(guard({ expected: 66, loadVersionGraph })).resolves.toEqual({ ok: true });
    expect(loadVersionGraph).not.toHaveBeenCalled();
  });

  it('rejects an older version with the current version and what changed', async () => {
    const result = body(await guard({ expected: 65, operations: [{ op: 'auto_layout' }] }));
    expect(result).toMatchObject({
      errorCode: 'FLOW_VERSION_CONFLICT',
      persistence: 'none',
      currentVersionNumber: 66,
      expectedVersionNumber: 65,
      drift: { fromVersion: 65, toVersion: 66, edges: ['e1'] },
    });
    expect(result.message).toContain('pass expectedVersionNumber: 66');
  });

  it('rejects a version newer than the latest without loading any graph', async () => {
    const loadVersionGraph = vi.fn();
    const result = body(await guard({ expected: 99, loadVersionGraph }));
    expect(result.message).toContain('newer than the latest saved version 66');
    expect(result.drift).toBeUndefined();
    expect(loadVersionGraph).not.toHaveBeenCalled();
  });

  it('rejects without a drift list when the expected version is missing', async () => {
    const result = body(await guard({ expected: 10, loadVersionGraph: vi.fn(async () => null) }));
    expect(result.currentVersionNumber).toBe(66);
    expect(result.drift).toBeUndefined();
  });

  it('caps the drift list against version 0 (an empty graph)', async () => {
    const many: FlowGraph = {
      nodes: Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, blockType: 'agent' })),
      edges: [],
    };
    const result = body(await guard({ expected: 0, latestGraph: many }));
    expect(result.drift.nodes).toHaveLength(20);
    expect(result.drift.omitted).toBe(10);
  });

  it('tells a chat whose own patch saved the latest version which number to pass next', async () => {
    recordKnownFlowVersion('chat-a', 'flow-1', 66, true);
    // A re-read of the version the chat saved must not forget that it saved it.
    recordKnownFlowVersion('chat-a', 'flow-1', 66);
    const result = body(await guard({ expected: 65 }));
    expect(result.message).toContain('Your previous patch in this chat saved version 66');
  });
});

describe('checkFlowVersionGuard — version this chat last saw', () => {
  it('rejects a patch that edits a node another session changed since this chat read it', async () => {
    recordKnownFlowVersion('chat-a', 'flow-1', 65);
    const result = body(await guard());
    expect(result).toMatchObject({ currentVersionNumber: 66, knownVersionNumber: 65 });
    expect(result.message).toContain('node "Track" (track)');
  });

  it('rejects a patch that replaces an edge or setting another session changed', async () => {
    recordKnownFlowVersion('chat-a', 'flow-1', 65);
    const result = body(
      await guard({
        operations: [
          { op: 'update_edge', edgeId: 'e1', label: 'mine' },
          { op: 'update_settings', settings: { maxBatchConcurrency: 4 } },
        ],
      }),
    );
    expect(result.message).toContain('edge e1');
    expect(result.message).toContain('setting maxBatchConcurrency');
  });

  it('counts the edges and Fan Out children a remove_node deletes along with the node', async () => {
    recordKnownFlowVersion('chat-a', 'flow-1', 65);
    const withChild: FlowGraph = {
      ...LATEST,
      nodes: [...LATEST.nodes, { id: 'child', blockType: 'agent', parentId: 'other' }],
    };
    const result = body(
      await guard({
        latestGraph: withChild,
        operations: [
          { op: 'remove_node', nodeId: 'trigger' },
          { op: 'remove_node', nodeId: 'other' },
        ],
      }),
    );
    expect(result.message).toContain('edge e1');
    expect(result.message).toContain('(child)');
  });

  it('rejects when the version this chat last saw can no longer be loaded', async () => {
    recordKnownFlowVersion('chat-a', 'flow-1', 65);
    const result = body(await guard({ loadVersionGraph: vi.fn(async () => null) }));
    expect(result).toMatchObject({ currentVersionNumber: 66, knownVersionNumber: 65 });
    expect(result.drift).toBeUndefined();
  });

  it('keeps the newer version when a slower read of an older one is recorded after it', async () => {
    recordKnownFlowVersion('chat-a', 'flow-1', 66, true);
    recordKnownFlowVersion('chat-a', 'flow-1', 65);
    const loadVersionGraph = vi.fn(async () => BASE);
    await expect(guard({ loadVersionGraph })).resolves.toEqual({ ok: true });
    expect(loadVersionGraph).not.toHaveBeenCalled();
  });

  it('finds an overlap past the 20-item cap of the reported drift list', async () => {
    recordKnownFlowVersion('chat-a', 'flow-1', 0);
    const many: FlowGraph = {
      nodes: Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, blockType: 'agent' })),
      edges: [],
    };
    const result = body(
      await guard({
        latestGraph: many,
        operations: [{ op: 'update_node', nodeId: 'n9', config: { instructions: 'mine' } }],
      }),
    );
    expect(result.drift.omitted).toBe(10);
    expect(result.message).toContain('(n9)');
  });

  it('saves with a note when the other changes do not overlap this patch', async () => {
    recordKnownFlowVersion('chat-a', 'flow-1', 65);
    const result = await guard({
      operations: [{ op: 'update_node', nodeId: 'track', position: { x: 9, y: 9 } }],
    });
    expect(result).toMatchObject({
      ok: true,
      concurrentChanges: { fromVersion: 65, toVersion: 66, moved: ['other'] },
    });
  });

  it('skips the check for a chat that has not read the flow, or has read the latest', async () => {
    const loadVersionGraph = vi.fn(async () => BASE);
    await expect(guard({ loadVersionGraph })).resolves.toEqual({ ok: true });
    await expect(guard({ sessionId: undefined, loadVersionGraph })).resolves.toEqual({ ok: true });
    recordKnownFlowVersion('chat-a', 'flow-1', 66, true);
    await expect(guard({ loadVersionGraph })).resolves.toEqual({ ok: true });
    expect(loadVersionGraph).not.toHaveBeenCalled();
  });

  it('keeps a chat’s record however many other chats read the flow afterwards', async () => {
    recordKnownFlowVersion('chat-a', 'flow-1', 65);
    for (let i = 0; i < 2000; i += 1) recordKnownFlowVersion(`chat-${i}`, 'flow-1', 66);
    expect((await guard()).ok).toBe(false);
  });

  it('keeps a newer read when this chat’s older save is recorded after it', async () => {
    recordKnownFlowVersion('chat-a', 'flow-1', 66);
    recordKnownFlowVersion('chat-a', 'flow-1', 65, true);
    await expect(guard()).resolves.toEqual({ ok: true });
  });
});
