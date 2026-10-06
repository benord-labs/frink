import { beforeEach, describe, expect, it } from 'vitest';
import { createNodeRun } from '../../db/repos/node-runs';
import { seedActiveAdmission, seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import {
  countSlotDispatches,
  dispatchCeilingFailure,
  insertNodeRunIfFenced,
  type RunFence,
  readRunFence,
  runTransition,
} from '.';

let db: TestDb;
let flowRunId: string;
let ticket: number;
let fence: RunFence;

beforeEach(async () => {
  db = freshDb();
  ({ flowRunId } = await seedFlowRun(db, { nodes: [], edges: [] }));
  ticket = seedActiveAdmission(db, flowRunId);
  const live = readRunFence(db, flowRunId);
  if (!live) throw new Error('seeded run has no fence');
  fence = live;
});

const insert = () =>
  runTransition(db, () =>
    insertNodeRunIfFenced(db, fence, { nodeId: 'a', blockType: 'x', status: 'running' }),
  );

describe('countSlotDispatches', () => {
  const seed = (patch: Partial<Parameters<typeof createNodeRun>[1]> = {}) =>
    createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'x',
      status: 'completed',
      admissionTicket: ticket,
      ...patch,
    });

  it('counts rows the fenced insert stamps with its ticket', () => {
    insert();
    insert();

    expect(countSlotDispatches(db, fence, { nodeId: 'a' })).toBe(2);
  });

  it('counts only the slot asked for: same node, same Fan Out item', async () => {
    await seed();
    await seed({ nodeId: 'b' });
    await seed({ laneIndex: 0, parentFanOutNodeRunId: 'fan-1' });
    await seed({ laneIndex: 1, parentFanOutNodeRunId: 'fan-1' });
    await seed({ laneIndex: 0, parentFanOutNodeRunId: 'fan-2' });

    expect(countSlotDispatches(db, fence, { nodeId: 'a' })).toBe(1);
    expect(
      countSlotDispatches(db, fence, { nodeId: 'a', laneIndex: 0, parentFanOutNodeRunId: 'fan-1' }),
    ).toBe(1);
  });

  it("ignores superseded attempts, other admissions' rows and unstamped rows", async () => {
    await seed();
    await seed({ status: 'superseded' });
    await seed({ admissionTicket: ticket + 1 });
    await seed({ admissionTicket: null });

    expect(countSlotDispatches(db, fence, { nodeId: 'a' })).toBe(1);
  });
});

describe('dispatchCeilingFailure', () => {
  // The editor lets an author clear a block's label; the message must still say which node it was.
  it('names the node by id when its label is blank', () => {
    expect(dispatchCeilingFailure({ id: 'n1', label: '' }).error?.message).toContain('Node "n1"');
    expect(dispatchCeilingFailure({ id: 'n1', label: '  ' }).error?.message).toContain('Node "n1"');
  });
});
