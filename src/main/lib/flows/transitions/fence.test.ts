import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getFlowRun, setFlowRunStatus } from '../../db/repos/flow-runs';
import { listNodeRunsForFlowRun } from '../../db/repos/node-runs';
import { flowRunAdmissions } from '../../db/schema';
import { seedActiveAdmission, seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import {
  insertNodeRunIfFenced,
  type RunFence,
  readRunFence,
  runTransition,
  setFencedRunStatus,
} from '.';

let db: TestDb;
let flowRunId: string;
let ticket: number;
let fence: RunFence;

beforeEach(async () => {
  db = freshDb();
  ({ flowRunId } = await seedFlowRun(db, { nodes: [], edges: [] }));
  ticket = seedActiveAdmission(db, flowRunId);
  fence = readRunFence(db, flowRunId) as RunFence;
});

const setTicket = (patch: Partial<typeof flowRunAdmissions.$inferInsert>) =>
  db.update(flowRunAdmissions).set(patch).where(eq(flowRunAdmissions.ticket, ticket)).run();
const insert = () =>
  runTransition(db, () =>
    insertNodeRunIfFenced(db, fence, { nodeId: 'a', blockType: 'x', status: 'running' }),
  );
const runStatus = async () => (await getFlowRun(db, flowRunId))?.status;

describe('readRunFence', () => {
  it.each(['running', 'paused'] as const)('names the live ticket of a %s run', async (status) => {
    await setFlowRunStatus(db, flowRunId, status);

    expect(readRunFence(db, flowRunId)).toEqual({ flowRunId, ticket });
    expect(readRunFence(db, flowRunId, ticket)).toEqual({ flowRunId, ticket });
  });

  it('passes a releasing slot that retained a cleanup error', () => {
    setTicket({ state: 'releasing', error: 'teardown failed' });

    expect(readRunFence(db, flowRunId, ticket)).toEqual({ flowRunId, ticket });
  });

  it.each(['pending', 'completed', 'failed', 'cancelled'] as const)(
    'declines a %s run',
    async (status) => {
      await setFlowRunStatus(db, flowRunId, status);

      expect(readRunFence(db, flowRunId)).toBeNull();
    },
  );

  it('declines a settled ticket, and any ticket but the live one', () => {
    setTicket({ state: 'released', settledAt: new Date() });
    expect(readRunFence(db, flowRunId)).toBeNull();

    const retried = seedActiveAdmission(db, flowRunId);

    expect(readRunFence(db, flowRunId, ticket)).toBeNull();
    expect(readRunFence(db, flowRunId)).toEqual({ flowRunId, ticket: retried });
  });
});

describe('fenced writes', () => {
  it('insert and write while the run holds the fenced ticket', async () => {
    setTicket({ state: 'releasing', error: 'teardown failed' });

    expect(insert()).toMatchObject({ flowRunId, nodeId: 'a', status: 'running' });
    expect(setFencedRunStatus(db, fence, 'completed')).toMatchObject({ status: 'completed' });
  });

  it("writes only from the caller's expected statuses", async () => {
    await setFlowRunStatus(db, flowRunId, 'paused');

    expect(setFencedRunStatus(db, fence, 'paused', {}, ['running'])).toBeNull();
  });

  it.each([
    ['the run was cancelled', () => setFlowRunStatus(db, flowRunId, 'cancelled')],
    ['its ticket settled', () => setTicket({ state: 'released', settledAt: new Date() })],
    [
      'a Cancel and a Retry re-admitted the run under a new ticket',
      () => {
        setTicket({ state: 'released', settledAt: new Date() });
        seedActiveAdmission(db, flowRunId);
      },
    ],
  ])('write nothing once %s', async (_, replace) => {
    await replace();
    const status = await runStatus();

    expect(insert()).toBeNull();
    expect(setFencedRunStatus(db, fence, 'completed')).toBeNull();
    expect(await listNodeRunsForFlowRun(db, flowRunId)).toEqual([]);
    expect(await runStatus()).toBe(status);
  });
});
