import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { freshDb, type TestDb } from '../test-utils/fresh-db';
import {
  createFlowVersion,
  createFlowVersionWithResult,
  FlowVersionConflictError,
  getLatestVersion,
} from './flow-versions';
import { createFlow } from './flows';

const graph = (instructions: string): FlowGraph => ({
  nodes: [
    { id: 't', blockType: 'manual_trigger', position: { x: 0, y: 0 } },
    { id: 'a', blockType: 'agent', config: { instructions }, position: { x: 0, y: 1 } },
  ],
  edges: [{ id: 'e1', source: 't', target: 'a' }],
});

describe('createFlowVersion — identical-graph no-op guard', () => {
  let db: TestDb;
  let flowId: string;

  beforeEach(async () => {
    db = freshDb();
    const flow = await createFlow(db, { name: 'F' });
    flowId = flow.id;
  });

  it('inserts version 1 on first save', async () => {
    const v = await createFlowVersion(db, { flowId, graph: graph('do it') });
    expect(v.versionNumber).toBe(1);
  });

  it('does NOT append a new version when the graph is identical', async () => {
    const v1 = await createFlowVersion(db, { flowId, graph: graph('do it') });
    const v2 = await createFlowVersion(db, {
      flowId,
      graph: graph('do it'),
      expectedVersionNumber: 1,
    });
    expect(v2.id).toBe(v1.id);
    expect(v2.versionNumber).toBe(1);
    expect((await getLatestVersion(db, flowId))?.versionNumber).toBe(1);
  });

  it('reports whether a row was appended, so a no-op save is not announced', async () => {
    const first = await createFlowVersionWithResult(db, { flowId, graph: graph('do it') });
    const repeat = await createFlowVersionWithResult(db, {
      flowId,
      graph: graph('do it'),
      expectedVersionNumber: 1,
    });

    expect(first.inserted).toBe(true);
    expect(repeat.inserted).toBe(false);
    expect(repeat.row.id).toBe(first.row.id);
  });

  it('treats key-reordered-but-identical graphs as a no-op', async () => {
    const v1 = await createFlowVersion(db, { flowId, graph: graph('do it') });
    const reordered = {
      edges: [{ target: 'a', source: 't', id: 'e1' }],
      nodes: [
        { position: { y: 0, x: 0 }, id: 't', blockType: 'manual_trigger' },
        {
          config: { instructions: 'do it' },
          id: 'a',
          position: { y: 1, x: 0 },
          blockType: 'agent',
        },
      ],
    } as FlowGraph;
    const v2 = await createFlowVersion(db, { flowId, graph: reordered, expectedVersionNumber: 1 });
    expect(v2.id).toBe(v1.id);
  });

  it('appends a new version when the graph differs', async () => {
    await createFlowVersion(db, { flowId, graph: graph('do it') });
    const v2 = await createFlowVersion(db, {
      flowId,
      graph: graph('do something else'),
      expectedVersionNumber: 1,
    });
    expect(v2.versionNumber).toBe(2);
  });

  it('still throws on stale expectedVersionNumber even if the graph matches', async () => {
    await createFlowVersion(db, { flowId, graph: graph('do it') }); // version 1
    await createFlowVersion(db, { flowId, graph: graph('v2'), expectedVersionNumber: 1 }); // version 2
    // Client thinks it's still on version 1 and sends an identical-to-v1 graph: the conflict
    // check runs first, so this is a CONFLICT, not a silent no-op.
    await expect(
      createFlowVersion(db, { flowId, graph: graph('do it'), expectedVersionNumber: 1 }),
    ).rejects.toBeInstanceOf(FlowVersionConflictError);
  });

  it('no-ops on identical graph even when expectedVersionNumber is omitted', async () => {
    // The conflict check is skipped when expectedVersionNumber is undefined; the no-op branch
    // must still fire so an initial-style save of an unchanged graph does not append a row.
    const v1 = await createFlowVersion(db, { flowId, graph: graph('do it') });
    const again = await createFlowVersion(db, { flowId, graph: graph('do it') });
    expect(again.id).toBe(v1.id);
    expect((await getLatestVersion(db, flowId))?.versionNumber).toBe(1);
  });

  it('compares against the LATEST version, not an older one', async () => {
    await createFlowVersion(db, { flowId, graph: graph('v1') }); // version 1
    await createFlowVersion(db, { flowId, graph: graph('v2'), expectedVersionNumber: 1 }); // version 2
    // Re-submitting the v1 graph differs from the latest (v2), so it must append v3 — the guard
    // must not mistake "equal to some historical version" for a no-op.
    const v3 = await createFlowVersion(db, {
      flowId,
      graph: graph('v1'),
      expectedVersionNumber: 2,
    });
    expect(v3.versionNumber).toBe(3);
  });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const graphWithBriefing = (instructions: string, briefing: string): FlowGraph =>
  ({ ...graph(instructions), settings: { briefing } }) as FlowGraph;

const persistedBatchId = (v: { graph: unknown }): string | undefined =>
  (v.graph as { settings?: { currentBatchId?: string } }).settings?.currentBatchId;

describe('createFlowVersion — currentBatchId minting on briefing transition', () => {
  let db: TestDb;
  let flowId: string;

  beforeEach(async () => {
    db = freshDb();
    const flow = await createFlow(db, { name: 'F' });
    flowId = flow.id;
  });

  it('mints a UUID currentBatchId when a briefing is first set', async () => {
    const v = await createFlowVersion(db, { flowId, graph: graphWithBriefing('do it', 'PRD') });
    expect(persistedBatchId(v)).toMatch(UUID_RE);
  });

  it('carries the same currentBatchId across an edit while the briefing stays set', async () => {
    const v1 = await createFlowVersion(db, { flowId, graph: graphWithBriefing('do it', 'PRD') });
    const v2 = await createFlowVersion(db, {
      flowId,
      graph: graphWithBriefing('do it differently', 'PRD'),
      expectedVersionNumber: 1,
    });
    expect(persistedBatchId(v2)).toBe(persistedBatchId(v1));
    expect(v2.versionNumber).toBe(2);
  });

  it('strips a client-sent currentBatchId and re-mints it server-side', async () => {
    const forged = {
      ...graph('do it'),
      settings: { briefing: 'PRD', currentBatchId: 'client-forged' },
    } as FlowGraph;
    const v = await createFlowVersion(db, { flowId, graph: forged });
    expect(persistedBatchId(v)).not.toBe('client-forged');
    expect(persistedBatchId(v)).toMatch(UUID_RE);
  });

  it('does not set currentBatchId when there is no briefing', async () => {
    const v = await createFlowVersion(db, { flowId, graph: graph('do it') });
    expect(persistedBatchId(v)).toBeUndefined();
  });
});
