// An open Flow editor learned of an agent's save only from its 30s poll.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { FlowVersionConflictError } from '../../db/repos/flow-versions';
import { createFlow } from '../../db/repos/flows';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import {
  commitFlowVersion,
  type FlowVersionCommittedEvent,
  subscribeFlowVersionCommitted,
} from './index';

const graph = (instructions: string): FlowGraph => ({
  nodes: [
    { id: 't', blockType: 'manual_trigger', position: { x: 0, y: 0 } },
    { id: 'a', blockType: 'agent', config: { instructions }, position: { x: 0, y: 1 } },
  ],
  edges: [{ id: 'e1', source: 't', target: 'a' }],
});

describe('commitFlowVersion', () => {
  let db: TestDb;
  let flowId: string;
  let events: FlowVersionCommittedEvent[];
  let unsubscribe: () => void;

  beforeEach(async () => {
    db = freshDb();
    flowId = (await createFlow(db, { name: 'F' })).id;
    events = [];
    unsubscribe?.();
    unsubscribe = subscribeFlowVersionCommitted((e) => events.push(e));
  });

  it('announces a newly appended version with who wrote it', async () => {
    const row = await commitFlowVersion(db, { flowId, graph: graph('one') }, 'agent');

    expect(row.versionNumber).toBe(1);
    expect(events).toEqual([{ flowId, versionNumber: 1, source: 'agent' }]);
  });

  it('stays silent when the graph matches the latest version (no row appended)', async () => {
    await commitFlowVersion(db, { flowId, graph: graph('one') }, 'ui');
    events.length = 0;

    const row = await commitFlowVersion(
      db,
      { flowId, graph: graph('one'), expectedVersionNumber: 1 },
      'agent',
    );

    expect(row.versionNumber).toBe(1);
    expect(events).toEqual([]);
  });

  it('stays silent when the write is rejected as a version conflict', async () => {
    await commitFlowVersion(db, { flowId, graph: graph('one') }, 'ui');
    events.length = 0;

    await expect(
      commitFlowVersion(db, { flowId, graph: graph('two'), expectedVersionNumber: 0 }, 'ui'),
    ).rejects.toBeInstanceOf(FlowVersionConflictError);
    expect(events).toEqual([]);
  });

  it('the version is readable by the time a listener hears about it', async () => {
    const { getLatestVersion } = await import('../../db/repos/flow-versions');
    const seen: Array<number | undefined> = [];
    const off = subscribeFlowVersionCommitted(() => {
      void getLatestVersion(db, flowId).then((v) => seen.push(v?.versionNumber));
    });

    await commitFlowVersion(db, { flowId, graph: graph('one') }, 'agent');
    await vi.waitFor(() => expect(seen).toEqual([1]));
    off();
  });

  it('a throwing listener neither fails the save nor costs later windows the event', async () => {
    unsubscribe();
    const off = subscribeFlowVersionCommitted(() => {
      throw new Error('listener blew up');
    });
    const later: FlowVersionCommittedEvent[] = [];
    const offLater = subscribeFlowVersionCommitted((e) => later.push(e));

    const row = await commitFlowVersion(db, { flowId, graph: graph('one') }, 'agent');

    expect(row.versionNumber).toBe(1);
    expect(later).toEqual([{ flowId, versionNumber: 1, source: 'agent' }]);
    off();
    offLater();
  });

  it('delivers every commit, in order, to each open window listening', async () => {
    const otherWindow: FlowVersionCommittedEvent[] = [];
    const off = subscribeFlowVersionCommitted((e) => otherWindow.push(e));

    await commitFlowVersion(db, { flowId, graph: graph('one') }, 'ui');
    await commitFlowVersion(db, { flowId, graph: graph('two'), expectedVersionNumber: 1 }, 'agent');
    off();

    const expected = [
      { flowId, versionNumber: 1, source: 'ui' },
      { flowId, versionNumber: 2, source: 'agent' },
    ];
    expect(events).toEqual(expected);
    expect(otherWindow).toEqual(expected);
  });

  it('two writers racing from the same version: only the winner is announced', async () => {
    await commitFlowVersion(db, { flowId, graph: graph('one') }, 'ui');
    events.length = 0;

    const results = await Promise.allSettled([
      commitFlowVersion(db, { flowId, graph: graph('agent'), expectedVersionNumber: 1 }, 'agent'),
      commitFlowVersion(db, { flowId, graph: graph('user'), expectedVersionNumber: 1 }, 'ui'),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(events).toEqual([{ flowId, versionNumber: 2, source: 'agent' }]);
  });

  it('stops delivering once unsubscribed', async () => {
    unsubscribe();
    await commitFlowVersion(db, { flowId, graph: graph('one') }, 'agent');

    expect(events).toEqual([]);
  });
});
