import { beforeEach, describe, expect, it } from 'vitest';

// Real in-memory SQLite (freshDb): under test are the batch run list's page/total snapshot and where
// each row's chat_id comes from.

import { createBatchStageRun } from '../db/repos/batch-stage-runs';
import { createBatchStage } from '../db/repos/batch-stages';
import { createNodeRun } from '../db/repos/node-runs';
import { eq } from 'drizzle-orm';
import { chats, flowRuns } from '../db/schema';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import { listBatchRunsForBatch } from './batch-runs-list';
import { pageAndCountStatements, recordPrepares, seedBatchFlow } from './batch-test-factories';

const BATCH_ID = 'batch-1';

let db: TestDb;
let versionId: string;
let stageId: string;

async function seedStage(stageNumber: number): Promise<string> {
  const stage = await createBatchStage(db, {
    batchId: BATCH_ID,
    stageNumber,
    name: `s${stageNumber}`,
    status: 'running',
    failureThreshold: 0,
    dependsOnStageIds: [],
  });
  return stage.id;
}

type RunContext = { label?: string; chatId?: string };

/** A batch flow run linked to one stage run, the way dispatch leaves it. */
async function seedBatchRun(
  input: {
    status?: string;
    createdAt?: Date;
    triggerContext?: RunContext;
    batchId?: string;
    inStage?: string;
  } = {},
): Promise<string> {
  const triggerContext = input.triggerContext ?? { label: 'r' };
  const [run] = await db
    .insert(flowRuns)
    .values({
      flowVersionId: versionId,
      status: input.status ?? 'running',
      batchId: input.batchId ?? BATCH_ID,
      triggerContext,
      createdAt: input.createdAt ?? new Date('2026-07-11T09:00:00Z'),
    })
    .returning();
  await createBatchStageRun(db, {
    stageId: input.inStage ?? stageId,
    status: 'dispatched',
    triggerContext,
    flowRunId: run.id,
  });
  return run.id;
}

/** A start_task node run whose output names a chat, and that chat. */
async function seedStartTask(
  flowRunId: string,
  input: {
    chatId: string;
    status?: string;
    completedAt?: Date;
    attemptNumber?: number;
    nodeId?: string;
    laneIndex?: number;
  },
) {
  const status = input.status ?? 'completed';
  await db.insert(chats).values({ id: input.chatId }).onConflictDoNothing();
  return createNodeRun(db, {
    flowRunId,
    nodeId: input.nodeId ?? 'st',
    blockType: 'start_task',
    status,
    nodeOutput: { status, outputs: { chatId: input.chatId, projectId: 'p' } },
    completedAt: input.completedAt ?? new Date('2026-07-11T10:01:00Z'),
    attemptNumber: input.attemptNumber ?? 1,
    laneIndex: input.laneIndex ?? null,
  });
}

describe('listBatchRunsForBatch', () => {
  beforeEach(async () => {
    db = freshDb();
    ({ versionId } = await seedBatchFlow(db));
    stageId = await seedStage(1);
  });

  describe('chat_id', () => {
    it('is the chat the run start_task created, with no stage filter', async () => {
      const runId = await seedBatchRun();
      await seedStartTask(runId, { chatId: 'chat-1' });

      const { runs, total } = await listBatchRunsForBatch(BATCH_ID, {}, db);

      expect(total).toBe(1);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ id: runId, chat_id: 'chat-1' });
    });

    it('is the same row whether or not the list is filtered by stage', async () => {
      const runId = await seedBatchRun();
      await seedStartTask(runId, { chatId: 'chat-1' });

      const unfiltered = await listBatchRunsForBatch(BATCH_ID, {}, db);
      const filtered = await listBatchRunsForBatch(BATCH_ID, { stageId }, db);

      expect(filtered).toEqual(unfiltered);
      expect(filtered.runs[0].chat_id).toBe('chat-1');
    });

    it('is null, and the run still listed once, before start_task completes', async () => {
      const runId = await seedBatchRun();
      await seedStartTask(runId, { chatId: 'chat-early', status: 'running' });

      const { runs, total } = await listBatchRunsForBatch(BATCH_ID, {}, db);

      expect(total).toBe(1);
      expect(runs.map((r) => [r.id, r.chat_id])).toEqual([[runId, null]]);
    });

    it('takes the newest completed attempt of the top-level start_task', async () => {
      const runId = await seedBatchRun();
      await seedStartTask(runId, {
        chatId: 'chat-first',
        completedAt: new Date('2026-07-11T10:01:00Z'),
      });
      await seedStartTask(runId, {
        chatId: 'chat-retry',
        attemptNumber: 2,
        completedAt: new Date('2026-07-11T10:09:00Z'),
      });

      const { runs } = await listBatchRunsForBatch(BATCH_ID, {}, db);

      expect(runs[0].chat_id).toBe('chat-retry');
    });

    it('ignores a fan-out lane start_task, even a newer one', async () => {
      const runId = await seedBatchRun();
      await seedStartTask(runId, {
        chatId: 'chat-anchor',
        completedAt: new Date('2026-07-11T10:01:00Z'),
      });
      await seedStartTask(runId, {
        chatId: 'chat-lane',
        nodeId: 'st-lane',
        laneIndex: 0,
        completedAt: new Date('2026-07-11T10:09:00Z'),
      });

      const { runs } = await listBatchRunsForBatch(BATCH_ID, {}, db);

      expect(runs[0].chat_id).toBe('chat-anchor');
    });

    it('falls back to a chatId the trigger context carries only when start_task gave none', async () => {
      await db.insert(chats).values({ id: 'chat-ctx' });
      const fromContext = await seedBatchRun({
        triggerContext: { chatId: 'chat-ctx' },
        createdAt: new Date('2026-07-11T09:00:00Z'),
      });
      const fromStartTask = await seedBatchRun({
        triggerContext: { chatId: 'chat-ctx' },
        createdAt: new Date('2026-07-11T09:01:00Z'),
      });
      await seedStartTask(fromStartTask, { chatId: 'chat-started' });

      const { runs } = await listBatchRunsForBatch(BATCH_ID, {}, db);

      expect(runs.map((r) => [r.id, r.chat_id])).toEqual([
        [fromStartTask, 'chat-started'],
        [fromContext, 'chat-ctx'],
      ]);
    });

    // A settled run outlives its chat: start_task output still names it after the chat row is gone.
    it('is null once the chat it names has been deleted', async () => {
      const started = await seedBatchRun({ createdAt: new Date('2026-07-11T09:01:00Z') });
      await seedStartTask(started, { chatId: 'chat-gone' });
      const fromContext = await seedBatchRun({
        triggerContext: { chatId: 'chat-ctx-gone' },
        createdAt: new Date('2026-07-11T09:00:00Z'),
      });
      await db.delete(chats).where(eq(chats.id, 'chat-gone'));

      const { runs, total } = await listBatchRunsForBatch(BATCH_ID, {}, db);

      expect(total).toBe(2);
      expect(runs.map((r) => [r.id, r.chat_id])).toEqual([
        [started, null],
        [fromContext, null],
      ]);
    });

    it('keeps an archived chat, which can still be opened', async () => {
      const runId = await seedBatchRun();
      await seedStartTask(runId, { chatId: 'chat-archived' });
      await db.update(chats).set({ archivedAt: new Date() }).where(eq(chats.id, 'chat-archived'));

      const { runs } = await listBatchRunsForBatch(BATCH_ID, {}, db);

      expect(runs[0].chat_id).toBe('chat-archived');
    });

    it.each([
      ['no output', null],
      ['no outputs record', { status: 'completed' }],
      ['an empty chat id', { status: 'completed', outputs: { chatId: '' } }],
      ['a null chat id', { status: 'completed', outputs: { chatId: null } }],
      ['a non-string chat id', { status: 'completed', outputs: { chatId: 42 } }],
    ])('is null for a completed start_task with %s', async (_name, nodeOutput) => {
      const runId = await seedBatchRun();
      await createNodeRun(db, {
        flowRunId: runId,
        nodeId: 'st',
        blockType: 'start_task',
        status: 'completed',
        nodeOutput,
        completedAt: new Date('2026-07-11T10:01:00Z'),
      });

      const { runs } = await listBatchRunsForBatch(BATCH_ID, {}, db);

      expect(runs.map((r) => [r.id, r.chat_id])).toEqual([[runId, null]]);
    });
  });

  describe('page and total', () => {
    it('lists a run once, and counts it once, when two stage runs link to it', async () => {
      const runId = await seedBatchRun();
      await createBatchStageRun(db, {
        stageId,
        status: 'dispatched',
        triggerContext: { label: 'dup' },
        flowRunId: runId,
      });

      for (const opts of [{}, { stageId }]) {
        const { runs, total } = await listBatchRunsForBatch(BATCH_ID, opts, db);
        expect(runs.map((r) => r.id)).toEqual([runId]);
        expect(total).toBe(1);
      }
    });

    it('narrows both the page and the total by stage and by status', async () => {
      const otherStage = await seedStage(2);
      const done = await seedBatchRun({ status: 'completed' });
      await seedBatchRun({ status: 'running' });
      const elsewhere = await seedBatchRun({ status: 'completed', inStage: otherStage });
      await seedBatchRun({ status: 'completed', batchId: 'batch-other' });

      const byStatus = await listBatchRunsForBatch(BATCH_ID, { status: 'completed' }, db);
      expect(byStatus.total).toBe(2);
      expect(byStatus.runs.map((r) => r.id).sort()).toEqual([done, elsewhere].sort());

      const byStage = await listBatchRunsForBatch(BATCH_ID, { stageId: otherStage }, db);
      expect(byStage.total).toBe(1);
      expect(byStage.runs.map((r) => r.id)).toEqual([elsewhere]);

      const byBoth = await listBatchRunsForBatch(BATCH_ID, { stageId, status: 'completed' }, db);
      expect(byBoth.total).toBe(1);
      expect(byBoth.runs.map((r) => r.id)).toEqual([done]);
    });

    it('pages newest first and keeps the whole-batch total on every page', async () => {
      const oldest = await seedBatchRun({ createdAt: new Date('2026-07-11T09:00:00Z') });
      const middle = await seedBatchRun({ createdAt: new Date('2026-07-11T09:01:00Z') });
      const newest = await seedBatchRun({ createdAt: new Date('2026-07-11T09:02:00Z') });

      const first = await listBatchRunsForBatch(BATCH_ID, { limit: 2 }, db);
      expect(first.runs.map((r) => r.id)).toEqual([newest, middle]);
      expect(first.total).toBe(3);

      const second = await listBatchRunsForBatch(BATCH_ID, { limit: 2, offset: 2 }, db);
      expect(second.runs.map((r) => r.id)).toEqual([oldest]);
      expect(second.total).toBe(3);

      const past = await listBatchRunsForBatch(BATCH_ID, { limit: 2, offset: 10 }, db);
      expect(past).toEqual({ runs: [], total: 3 });
    });

    it('returns an empty result for a batch with no runs', async () => {
      await seedBatchRun();

      await expect(listBatchRunsForBatch('batch-unknown', {}, db)).resolves.toEqual({
        runs: [],
        total: 0,
      });
    });

    it.each([
      ['unfiltered', () => ({})],
      ['filtered by stage', () => ({ stageId })],
    ])('reads the page and the total inside one transaction (%s)', async (_name, opts) => {
      await seedBatchRun();
      const prepared = recordPrepares(db);

      await listBatchRunsForBatch(BATCH_ID, opts(), db);

      const statements = pageAndCountStatements(prepared);
      expect(statements).toHaveLength(2);
      expect(statements.map((s) => s.inTransaction)).toEqual([true, true]);
      expect(db.$client.inTransaction).toBe(false);
    });
  });
});
