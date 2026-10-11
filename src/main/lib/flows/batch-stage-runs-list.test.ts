import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real in-memory SQLite (freshDb): under test are the batch read queries' enrichment — start_task
// (latest attempt, merge-conflict surfacing, absence), the needs_input / attention_count readouts,
// each row's chat_id and the page/total snapshot.

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getDatabase: vi.fn(),
  },
}));

vi.mock('../db', () => ({ getDatabase: mocks.getDatabase }));

import { createBatchStageRun } from '../db/repos/batch-stage-runs';
import { createBatchStage } from '../db/repos/batch-stages';
import { createNodeRun, listHumanWaitFlowRunIds } from '../db/repos/node-runs';
import { eq } from 'drizzle-orm';
import { chats, flowRuns, tasks } from '../db/schema';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import { listBatchStageDetail } from './batch-stage-detail';
import { listBatchRunsForBatch } from './batch-runs-list';
import { listBatchStageRunsForStage } from './batch-stage-runs-list';
import { pageAndCountStatements, recordPrepares, seedBatchFlow } from './batch-test-factories';

let db: TestDb;
let stageId: string;
let versionId: string;

async function seedFlowRun(): Promise<string> {
  const [run] = await db
    .insert(flowRuns)
    .values({
      flowVersionId: versionId,
      status: 'running',
      startedAt: new Date('2026-07-11T10:00:00Z'),
    })
    .returning();
  return run.id;
}

async function seedStageRun(flowRunId: string | null): Promise<string> {
  const run = await createBatchStageRun(db, {
    stageId,
    status: flowRunId ? 'dispatched' : 'pending',
    triggerContext: { label: 'r' },
    ...(flowRunId ? { flowRunId } : {}),
  });
  return run.id;
}

function seedStartTask(
  flowRunId: string,
  input: {
    nodeId: string;
    status: string;
    outputs?: Record<string, unknown>;
    createdAt: Date;
    attemptNumber?: number;
  },
) {
  return createNodeRun(db, {
    flowRunId,
    nodeId: input.nodeId,
    blockType: 'start_task',
    status: input.status,
    nodeOutput: input.outputs ? { status: input.status, outputs: input.outputs } : null,
    createdAt: input.createdAt,
    ...(input.attemptNumber !== undefined ? { attemptNumber: input.attemptNumber } : {}),
  });
}

describe('batch stage read paths', () => {
  beforeEach(async () => {
    db = freshDb();
    mocks.getDatabase.mockReturnValue(db);
    ({ versionId } = await seedBatchFlow(db));
    const stage = await createBatchStage(db, {
      batchId: 'batch-1',
      stageNumber: 1,
      name: 's1',
      status: 'running',
      failureThreshold: 0,
      dependsOnStageIds: [],
    });
    stageId = stage.id;
  });

  it('surfaces conflict fields (snake_case) from an awaiting_input start_task', async () => {
    const flowRunId = await seedFlowRun();
    await seedStageRun(flowRunId);
    await seedStartTask(flowRunId, {
      nodeId: 'st',
      status: 'awaiting_input',
      outputs: {
        mergeConflict: true,
        conflictingBranch: 'feat/b',
        conflictedFiles: ['src/a.ts', 'src/b.ts'],
        mergedBranches: ['feat/a'],
      },
      createdAt: new Date('2026-07-11T10:01:00Z'),
    });

    const { runs } = await listBatchStageRunsForStage(stageId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      start_task_status: 'awaiting_input',
      merge_conflict: true,
      conflicting_branch: 'feat/b',
      conflicted_files: ['src/a.ts', 'src/b.ts'],
      merged_branches: ['feat/a'],
    });
  });

  it('picks the latest start_task attempt — a later clean attempt clears the conflict', async () => {
    const flowRunId = await seedFlowRun();
    await seedStageRun(flowRunId);
    await seedStartTask(flowRunId, {
      nodeId: 'st-1',
      status: 'awaiting_input',
      outputs: { mergeConflict: true, conflictingBranch: 'feat/b' },
      createdAt: new Date('2026-07-11T10:01:00Z'),
    });
    await seedStartTask(flowRunId, {
      nodeId: 'st-2',
      status: 'completed',
      outputs: { mergedBranches: ['feat/a', 'feat/b'] },
      createdAt: new Date('2026-07-11T10:05:00Z'),
    });

    const { runs } = await listBatchStageRunsForStage(stageId);
    expect(runs[0].start_task_status).toBe('completed');
    expect(runs[0].merge_conflict).toBeUndefined();
    expect(runs[0].conflicting_branch).toBeUndefined();
    expect(runs[0].merged_branches).toEqual(['feat/a', 'feat/b']);
  });

  it('breaks same-second created_at ties by attempt_number (resumed attempt wins)', async () => {
    const flowRunId = await seedFlowRun();
    await seedStageRun(flowRunId);
    const sameSecond = new Date('2026-07-11T10:01:00Z');
    await seedStartTask(flowRunId, {
      nodeId: 'st',
      status: 'awaiting_input',
      outputs: { mergeConflict: true, conflictingBranch: 'feat/b' },
      createdAt: sameSecond,
      attemptNumber: 1,
    });
    await seedStartTask(flowRunId, {
      nodeId: 'st-resume',
      status: 'completed',
      outputs: { mergedBranches: ['feat/a', 'feat/b'] },
      createdAt: sameSecond,
      attemptNumber: 2,
    });

    const { runs } = await listBatchStageRunsForStage(stageId);
    expect(runs[0].start_task_status).toBe('completed');
    expect(runs[0].merge_conflict).toBeUndefined();
  });

  it('omits start_task fields for runs without a flow_run or without a start_task', async () => {
    await seedStageRun(null);
    const flowRunId = await seedFlowRun();
    await seedStageRun(flowRunId);

    const { runs } = await listBatchStageRunsForStage(stageId);
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.start_task_status).toBeUndefined();
      expect(run.merge_conflict).toBeUndefined();
    }
  });

  it('clean merge surfaces merged_branches without a conflict flag', async () => {
    const flowRunId = await seedFlowRun();
    await seedStageRun(flowRunId);
    await seedStartTask(flowRunId, {
      nodeId: 'st',
      status: 'completed',
      outputs: { mergedBranches: ['feat/a'], branch: 'frink/xyz' },
      createdAt: new Date('2026-07-11T10:01:00Z'),
    });

    const { runs } = await listBatchStageRunsForStage(stageId);
    expect(runs[0].start_task_status).toBe('completed');
    expect(runs[0].merge_conflict).toBeUndefined();
    expect(runs[0].merged_branches).toEqual(['feat/a']);
  });

  describe('chat_id', () => {
    it('is the chat the run start_task created', async () => {
      await db.insert(chats).values({ id: 'chat-1' });
      const flowRunId = await seedFlowRun();
      await seedStageRun(flowRunId);
      await seedStartTask(flowRunId, {
        nodeId: 'st',
        status: 'completed',
        outputs: { chatId: 'chat-1' },
        createdAt: new Date('2026-07-11T10:01:00Z'),
      });

      const { runs } = await listBatchStageRunsForStage(stageId);
      expect(runs[0].chat_id).toBe('chat-1');
    });

    it('is null for a run-less row and for a run whose start_task has not completed', async () => {
      await seedStageRun(null);
      const flowRunId = await seedFlowRun();
      await seedStageRun(flowRunId);
      await seedStartTask(flowRunId, {
        nodeId: 'st',
        status: 'awaiting_input',
        outputs: { chatId: 'chat-early' },
        createdAt: new Date('2026-07-11T10:01:00Z'),
      });

      const { runs } = await listBatchStageRunsForStage(stageId);
      expect(runs.map((r) => r.chat_id)).toEqual([null, null]);
    });

    it('falls back to a chatId the stage run trigger context carries', async () => {
      await db.insert(chats).values({ id: 'chat-ctx' });
      await createBatchStageRun(db, {
        stageId,
        status: 'pending',
        triggerContext: { chatId: 'chat-ctx' },
      });

      const { runs } = await listBatchStageRunsForStage(stageId);
      expect(runs[0].chat_id).toBe('chat-ctx');
    });

    it('is null once the chat it names has been deleted', async () => {
      const flowRunId = await seedFlowRun();
      await seedStageRun(flowRunId);
      await seedStartTask(flowRunId, {
        nodeId: 'st',
        status: 'completed',
        outputs: { chatId: 'chat-gone' },
        createdAt: new Date('2026-07-11T10:01:00Z'),
      });

      const { runs } = await listBatchStageRunsForStage(stageId);
      expect(runs.map((r) => r.chat_id)).toEqual([null]);
    });

    // Both readers describe the same run; the batch list is called as production calls it, with no db.
    it('agrees with the batch run list on a run both of them return', async () => {
      await db.insert(chats).values({ id: 'chat-shared' });
      const [run] = await db
        .insert(flowRuns)
        .values({ flowVersionId: versionId, status: 'running', batchId: 'batch-1' })
        .returning();
      await seedStageRun(run.id);
      await seedStartTask(run.id, {
        nodeId: 'st',
        status: 'completed',
        outputs: { chatId: 'chat-shared' },
        createdAt: new Date('2026-07-11T10:01:00Z'),
      });

      const stageList = await listBatchStageRunsForStage(stageId);
      const batchList = await listBatchRunsForBatch('batch-1', { stageId });

      expect(batchList.runs.map((r) => [r.id, r.chat_id])).toEqual([[run.id, 'chat-shared']]);
      expect(stageList.runs.map((r) => r.chat_id)).toEqual(['chat-shared']);
    });
  });

  describe('latest_chat_id', () => {
    /** A dispatched member whose top-level start_task completed and created `chatId`. */
    async function seedMemberWithChat(
      chatId: string,
      input: { laneIndex?: number } = {},
    ): Promise<string> {
      await db.insert(chats).values({ id: chatId }).onConflictDoNothing();
      const flowRunId = await seedFlowRun();
      await createBatchStageRun(db, {
        stageId,
        status: 'dispatched',
        triggerContext: { label: 'r' },
        flowRunId,
      });
      await createNodeRun(db, {
        flowRunId,
        nodeId: 'st',
        blockType: 'start_task',
        status: 'completed',
        nodeOutput: { status: 'completed', outputs: { chatId } },
        createdAt: new Date('2026-07-11T10:01:00Z'),
        laneIndex: input.laneIndex ?? null,
      });
      return flowRunId;
    }

    async function latestChatId(): Promise<string | null> {
      const [stage] = await listBatchStageDetail('batch-1');
      return stage.latest_chat_id;
    }

    it('is the chat the member start_task created, with none in the trigger context', async () => {
      await seedMemberWithChat('chat-1');

      expect(await latestChatId()).toBe('chat-1');
    });

    // Members seeded in one test share a created_at second, as bulk-defined stage runs do.
    it('takes the most recently dispatched member when members share a created_at', async () => {
      await seedMemberWithChat('chat-old');
      await seedMemberWithChat('chat-new');

      expect(await latestChatId()).toBe('chat-new');
    });

    it('goes by when the run was dispatched before insert order', async () => {
      const first = await seedMemberWithChat('chat-later-run');
      await seedMemberWithChat('chat-earlier-run');
      const later = new Date(Date.now() + 60_000);
      await db.update(flowRuns).set({ createdAt: later }).where(eq(flowRuns.id, first));

      expect(await latestChatId()).toBe('chat-later-run');
    });

    it('uses an older member when the newest has no completed start_task', async () => {
      await seedMemberWithChat('chat-old');
      const newest = await seedFlowRun();
      await seedStageRun(newest);
      await seedStartTask(newest, {
        nodeId: 'st',
        status: 'awaiting_input',
        outputs: { chatId: 'chat-early' },
        createdAt: new Date('2026-07-11T10:02:00Z'),
      });

      expect(await latestChatId()).toBe('chat-old');
    });

    it('skips a deleted chat for the next existing one, and is null when none exist', async () => {
      await seedMemberWithChat('chat-kept');
      await seedMemberWithChat('chat-gone');
      await db.delete(chats).where(eq(chats.id, 'chat-gone'));
      expect(await latestChatId()).toBe('chat-kept');

      await db.delete(chats).where(eq(chats.id, 'chat-kept'));
      expect(await latestChatId()).toBeNull();
    });

    it('ignores a start_task inside a fan-out lane', async () => {
      await seedMemberWithChat('chat-lane', { laneIndex: 0 });

      expect(await latestChatId()).toBeNull();
    });

    it('keeps an archived chat, which can still be opened', async () => {
      await seedMemberWithChat('chat-archived');
      await db.update(chats).set({ archivedAt: new Date() }).where(eq(chats.id, 'chat-archived'));

      expect(await latestChatId()).toBe('chat-archived');
    });

    it('falls back to a chatId the run trigger context carries', async () => {
      await db.insert(chats).values({ id: 'chat-ctx' });
      const [run] = await db
        .insert(flowRuns)
        .values({
          flowVersionId: versionId,
          status: 'running',
          triggerContext: { chatId: 'chat-ctx' },
        })
        .returning();
      await seedStageRun(run.id);

      expect(await latestChatId()).toBe('chat-ctx');
    });

    it('is null, with the counts intact, when no member has a chat to resolve', async () => {
      await seedStageRun(null);
      await seedStageRun(await seedFlowRun());

      const [stage] = await listBatchStageDetail('batch-1');
      expect(stage).toMatchObject({ latest_chat_id: null, run_count: 2, active_count: 2 });
    });

    // The chat lookup runs after the snapshot; the counts and the started rows must stay inside it.
    it('still reads the aggregates and the member rows inside one transaction', async () => {
      await seedMemberWithChat('chat-1');
      const prepared = recordPrepares(db);

      await listBatchStageDetail('batch-1');

      const snapshot = prepared.filter((s) => /group by|inner join "flow_runs"/i.test(s.sql));
      expect(snapshot).toHaveLength(2);
      expect(snapshot.map((s) => s.inTransaction)).toEqual([true, true]);
      expect(db.$client.inTransaction).toBe(false);
    });

    it('resolves each stage from its own members', async () => {
      await seedMemberWithChat('chat-s1');
      const second = await createBatchStage(db, {
        batchId: 'batch-1',
        stageNumber: 2,
        name: 's2',
        status: 'pending',
        failureThreshold: 0,
        dependsOnStageIds: [],
      });
      await createBatchStageRun(db, { stageId: second.id, status: 'pending', triggerContext: {} });

      const stages = await listBatchStageDetail('batch-1');
      expect(stages.map((s) => s.latest_chat_id)).toEqual(['chat-s1', null]);
    });
  });

  describe('page and total', () => {
    it('keeps the whole-stage total on every page, including one past the end', async () => {
      for (let i = 0; i < 3; i += 1) await seedStageRun(null);

      const first = await listBatchStageRunsForStage(stageId, { limit: 2 });
      expect(first.runs).toHaveLength(2);
      expect(first.total).toBe(3);

      const past = await listBatchStageRunsForStage(stageId, { limit: 2, offset: 10 });
      expect(past).toEqual({ runs: [], total: 3 });
    });

    it('reads the page and the total inside one transaction', async () => {
      await seedStageRun(await seedFlowRun());
      const prepared = recordPrepares(db);

      await listBatchStageRunsForStage(stageId);

      const statements = pageAndCountStatements(prepared);
      expect(statements).toHaveLength(2);
      expect(statements.map((s) => s.inTransaction)).toEqual([true, true]);
      expect(db.$client.inTransaction).toBe(false);
    });
  });

  describe('waiting on a human', () => {
    async function seedNode(flowRunId: string, status: string, nodeId = 'n1'): Promise<string> {
      const node = await createNodeRun(db, { flowRunId, nodeId, blockType: 'agent', status });
      return node.id;
    }

    async function seedTaskOnNode(nodeRunId: string, status: string): Promise<void> {
      await db.insert(tasks).values({ description: 'd', source: 'flow', status, nodeRunId });
    }

    // The cases the readouts have to tell apart: a run is `paused` for the life of every
    // agent node, so only the node + its task say whether a person is being waited on.
    const CASES: Array<{ name: string; node: string; task?: string; waiting: boolean }> = [
      {
        name: 'an agent hand-off whose task still runs',
        node: 'awaiting_input',
        task: 'running',
        waiting: false,
      },
      {
        name: 'a hand-off whose next task is still queued',
        node: 'awaiting_input',
        task: 'pending',
        waiting: false,
      },
      { name: 'a taskless window between nodes', node: 'running', waiting: false },
      {
        name: 'a parked task on a parked node',
        node: 'awaiting_input',
        task: 'needs_attention',
        waiting: true,
      },
      {
        name: 'a plan waiting for approval',
        node: 'awaiting_input',
        task: 'plan_ready',
        waiting: true,
      },
      { name: 'an approval node with no task', node: 'awaiting_input', waiting: true },
      { name: 'a blocked node with no task', node: 'blocked', waiting: true },
      {
        name: 'a task the restart sweep cancelled',
        node: 'awaiting_input',
        task: 'cancelled',
        waiting: true,
      },
      {
        name: 'a stale needs_attention task under a completed node',
        node: 'completed',
        task: 'needs_attention',
        waiting: false,
      },
    ];

    for (const c of CASES) {
      it(`${c.waiting ? 'flags' : 'ignores'} ${c.name}`, async () => {
        const flowRunId = await seedFlowRun();
        const nodeRunId = await seedNode(flowRunId, c.node);
        if (c.task) await seedTaskOnNode(nodeRunId, c.task);

        const waiting = await listHumanWaitFlowRunIds(db, [flowRunId]);
        expect(waiting.has(flowRunId)).toBe(c.waiting);
      });
    }

    it('flags a fan-out run on its parked lane while the other lane runs', async () => {
      const flowRunId = await seedFlowRun();
      await seedTaskOnNode(
        await seedNode(flowRunId, 'awaiting_input', 'lane-a'),
        'needs_attention',
      );
      await seedTaskOnNode(await seedNode(flowRunId, 'running', 'lane-b'), 'running');

      const waiting = await listHumanWaitFlowRunIds(db, [flowRunId]);
      expect(waiting.has(flowRunId)).toBe(true);
    });

    it('returns an empty set when there are no runs to check', async () => {
      expect(await listHumanWaitFlowRunIds(db, [])).toEqual(new Set());
    });

    it('marks a row needs_input when its run is parked with no live task', async () => {
      const flowRunId = await seedFlowRun();
      await seedStageRun(flowRunId);
      await seedTaskOnNode(await seedNode(flowRunId, 'awaiting_input'), 'needs_attention');

      const { runs } = await listBatchStageRunsForStage(stageId);
      expect(runs[0].needs_input).toBe(true);
    });

    it('leaves needs_input false for an agent hand-off and for a run-less row', async () => {
      await seedStageRun(null);
      const flowRunId = await seedFlowRun();
      await seedStageRun(flowRunId);
      await seedTaskOnNode(await seedNode(flowRunId, 'awaiting_input'), 'running');

      const { runs } = await listBatchStageRunsForStage(stageId);
      expect(runs.map((r) => r.needs_input)).toEqual([false, false]);
    });

    it('counts a parked member in attention_count and leaves the stage running', async () => {
      const parkedRun = await seedFlowRun();
      await seedStageRun(parkedRun);
      await seedTaskOnNode(await seedNode(parkedRun, 'awaiting_input'), 'needs_attention');
      const handoffRun = await seedFlowRun();
      await seedStageRun(handoffRun);
      await seedTaskOnNode(await seedNode(handoffRun, 'awaiting_input'), 'running');

      const [stage] = await listBatchStageDetail('batch-1');
      expect(stage).toMatchObject({
        attention_count: 1,
        active_count: 2,
        pending_count: 0,
        status: 'running',
      });
    });
  });
});
