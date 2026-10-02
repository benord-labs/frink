import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getFlowRun, setFlowRunStatus } from '../../db/repos/flow-runs';
import { createNodeRun, getNodeRun, listNodeRunsForFlowRun } from '../../db/repos/node-runs';
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

describe('retry supersedes the replaced attempt', () => {
  const seedAttempt = (status: string, attemptNumber = 1) =>
    createNodeRun(db, { flowRunId, nodeId: 'a', blockType: 'x', status, attemptNumber });
  const retry = (supersedesNodeRunId: string) =>
    runTransition(db, () =>
      insertNodeRunIfFenced(
        db,
        fence,
        { nodeId: 'a', blockType: 'x', status: 'running' },
        supersedesNodeRunId,
      ),
    );

  it.each(['failed', 'awaiting_input', 'blocked'])(
    'terminalizes a %s attempt and numbers the retry after it',
    async (status) => {
      const prior = await seedAttempt(status);

      expect(retry(prior.id)).toMatchObject({ status: 'running', attemptNumber: 2 });
      const superseded = await getNodeRun(db, prior.id);
      expect(superseded?.status).toBe('superseded');
      expect(superseded?.completedAt).toBeInstanceOf(Date);
    },
  );

  it('counts on from the replaced attempt, not from 1', async () => {
    const prior = await seedAttempt('awaiting_input', 2);

    expect(retry(prior.id)).toMatchObject({ attemptNumber: 3 });
  });

  it('leaves an attempt that is no longer actionable as it is', async () => {
    const prior = await seedAttempt('completed');

    expect(retry(prior.id)).toMatchObject({ attemptNumber: 2 });
    expect((await getNodeRun(db, prior.id))?.status).toBe('completed');
  });

  it('writes neither row once a Cancel has won the fence', async () => {
    const prior = await seedAttempt('awaiting_input');
    await setFlowRunStatus(db, flowRunId, 'cancelled');

    expect(retry(prior.id)).toBeNull();
    expect((await getNodeRun(db, prior.id))?.status).toBe('awaiting_input');
    expect(await listNodeRunsForFlowRun(db, flowRunId)).toHaveLength(1);
  });
});
