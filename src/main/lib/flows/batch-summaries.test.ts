import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createChat } from '../db/repos/chats';
import { getOrCreateFlowRunByIdempotencyKey } from '../db/repos/flow-runs';
import { createFlowVersion } from '../db/repos/flow-versions';
import { createFlow } from '../db/repos/flows';
import { setKv } from '../db/repos/flow-kv-state';
import { createNodeRun } from '../db/repos/node-runs';
import { createTask } from '../db/repos/tasks';
import { seedCompletedNodeRun } from '../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import { nodeRuns } from '../db/schema';
import { listSidebarBatchGroups } from './batch-summaries';

const GRAPH = { nodes: [], edges: [] };

describe('listSidebarBatchGroups', () => {
  let db: TestDb;
  let versionId: string;
  let flowId: string;

  beforeEach(async () => {
    db = freshDb();
    const flow = await createFlow(db, { name: 'Triage' });
    const version = await createFlowVersion(db, { flowId: flow.id, graph: GRAPH });
    versionId = version.id;
    flowId = flow.id;
  });

  type RunStatus = 'running' | 'completed' | 'failed' | 'paused' | 'pending' | 'cancelled';
  /** A batch run linked to a live chat through its trigger context, as the sidebar requires. */
  async function seedRun(batchId: string | null, status: RunStatus, createdAt?: Date) {
    const chat = await createChat(db, { name: 'member' });
    return getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: versionId,
      status,
      triggerContext: { chatId: chat.id },
      idempotencyKey: null,
      batchId,
      startedAt: new Date(),
      ...(createdAt ? { createdAt } : {}),
    });
  }

  it('aggregates a batch by status with the flow name, ignoring non-batch runs', async () => {
    await seedRun('b1', 'completed');
    await seedRun('b1', 'failed');
    await seedRun('b1', 'running');
    await seedRun(null, 'running'); // not in a batch — must not appear

    const groups = await listSidebarBatchGroups(db, ['b1']);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      batch_id: 'b1',
      kind: 'batch',
      flow_name: 'Triage',
      run_count: 3,
      completed_count: 1,
      failed_count: 1,
      running_count: 1,
    });
    // Activity timestamps surface as ISO strings for the renderer.
    expect(typeof groups[0].last_activity_at).toBe('string');
  });

  it('returns one entry per distinct batch', async () => {
    await seedRun('b1', 'completed');
    await seedRun('b2', 'running');

    const groups = await listSidebarBatchGroups(db, ['b1', 'b2']);

    expect(groups.map((g) => g.batch_id).sort()).toEqual(['b1', 'b2']);
  });

  it('keeps summarising a batch when one of its steps saved malformed output', async () => {
    const chat = await createChat(db, { name: 'branch' });
    const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: versionId,
      status: 'running',
      triggerContext: null,
      idempotencyKey: null,
      batchId: 'b1',
      startedAt: new Date(),
    });
    const broken = await seedCompletedNodeRun(db, {
      flowRunId: run.id,
      nodeId: 'x',
      blockType: 'agent',
    });
    db.run(sql`UPDATE ${nodeRuns} SET node_output = '{broken' WHERE ${eq(nodeRuns.id, broken.id)}`);
    await createTask(db, {
      description: 'branch',
      source: 'flow',
      flowRunId: run.id,
      result: { chatId: chat.id },
    });

    await expect(listSidebarBatchGroups(db, ['b1'])).resolves.toEqual([
      expect.objectContaining({ batch_id: 'b1', run_count: 1 }),
    ]);
  });

  it('returns [] when no group is requested', async () => {
    await seedRun('b1', 'completed');
    await expect(listSidebarBatchGroups(db, [])).resolves.toEqual([]);
  });

  it('summarises only the requested groups, however many exist', async () => {
    await seedRun('older', 'completed', new Date('2026-01-01T00:00:00.000Z'));
    await seedRun('newer', 'running', new Date('2026-06-01T00:00:00.000Z'));
    await seedRun('not-shown', 'running', new Date('2026-07-01T00:00:00.000Z'));

    const groups = await listSidebarBatchGroups(db, ['older', 'newer']);

    expect(groups.map((g) => g.batch_id).sort()).toEqual(['newer', 'older']);
  });

  it('counts paused/pending/cancelled runs in run_count but never in the broken-out counts', async () => {
    // flow_runs has 6 statuses; SidebarBatchGroup only breaks out completed/failed/running.
    // The other three must still inflate run_count (so "X of N" is honest) but stay out of the
    // three sums — running_count in particular must NOT absorb paused/pending (it drives the
    // delete-batch "N running" warning).
    await seedRun('b1', 'completed');
    await seedRun('b1', 'paused');
    await seedRun('b1', 'pending');
    await seedRun('b1', 'cancelled');

    const [g] = await listSidebarBatchGroups(db, ['b1']);

    expect(g).toMatchObject({
      batch_id: 'b1',
      run_count: 4,
      completed_count: 1,
      failed_count: 0,
      running_count: 0,
    });
  });

  // The header counts the rows the group shows: a member whose chat was deleted or archived leaves
  // both, while a branch chat linked only through a task result still counts.
  it('counts only runs whose linked chat is live', async () => {
    const seedLinked = async (
      batchId: string,
      status: RunStatus,
      triggerContext: { chatId: string } | null,
    ) =>
      (
        await getOrCreateFlowRunByIdempotencyKey(db, {
          flowVersionId: versionId,
          status,
          triggerContext,
          idempotencyKey: null,
          batchId,
          startedAt: new Date(),
        })
      ).run.id;
    const archived = await createChat(db, { name: 'archived', archivedAt: new Date() });
    const branch = await createChat(db, { name: 'branch' });

    await seedRun('b1', 'failed'); // live chat → counted
    await seedLinked('b1', 'failed', { chatId: 'deleted-chat' }); // chat deleted → dropped
    await seedLinked('b1', 'completed', { chatId: archived.id }); // chat archived → dropped
    await seedLinked('b1', 'running', null); // never minted a chat → dropped
    const branchRun = await seedLinked('b1', 'completed', null);
    await createTask(db, {
      description: 'branch agent',
      source: 'flow',
      flowRunId: branchRun,
      result: { chatId: branch.id },
    }); // linked only via tasks.result → counted
    await seedLinked('b2', 'failed', { chatId: 'gone' }); // a batch with no live chat → absent

    const groups = await listSidebarBatchGroups(db, ['b1', 'b2']);

    expect(groups).toEqual([
      expect.objectContaining({
        batch_id: 'b1',
        run_count: 2,
        completed_count: 1,
        failed_count: 1,
      }),
    ]);
  });

  /** A live Fan Out run whose home chat precedes the loop; `currentIndex` is the loop's live item. */
  async function seedFanOutRun(currentIndex: number) {
    const home = await createChat(db, { name: 'home' });
    const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: versionId,
      status: 'paused',
      triggerContext: null,
      idempotencyKey: null,
      startedAt: new Date(),
    });
    const homeIds = { chatId: home.id };
    await seedCompletedNodeRun(db, {
      flowRunId: run.id,
      nodeId: 'start',
      blockType: 'start_task',
      outputs: homeIds,
    });
    const fan = await seedCompletedNodeRun(db, {
      flowRunId: run.id,
      nodeId: 'fan',
      blockType: 'fan_out',
    });
    await setKv(db, flowId, `_fanOut:${run.id}:fan`, { currentIndex });
    const lane = (laneIndex: number) => ({
      flowRunId: run.id,
      laneIndex,
      parentFanOutNodeRunId: fan.id,
    });
    return { runId: run.id, homeIds, lane };
  }

  it('summarises a Fan Out run by item: finished, failed on the latest attempt, and listed', async () => {
    const { runId, lane } = await seedFanOutRun(3);
    for (const laneIndex of [0, 1, 2, 3]) {
      const archivedAt = laneIndex === 0 ? new Date() : null;
      const chat = await createChat(db, { name: `item ${laneIndex}`, archivedAt });
      await seedCompletedNodeRun(db, {
        ...lane(laneIndex),
        nodeId: 'item-start',
        blockType: 'start_task',
        outputs: { chatId: chat.id },
      });
    }
    const draft = { nodeId: 'draft', blockType: 'agent' };
    await createNodeRun(db, { ...lane(2), ...draft, status: 'failed' });
    await seedCompletedNodeRun(db, { ...lane(2), ...draft }); // retried, so the failure is history
    await createNodeRun(db, { ...lane(3), ...draft, status: 'failed' });

    expect(await listSidebarBatchGroups(db, [runId])).toEqual([
      expect.objectContaining({
        batch_id: runId,
        kind: 'run',
        flow_name: 'Triage',
        run_count: 3,
        completed_count: 2,
        failed_count: 1,
        running_count: 1,
      }),
    ]);
  });

  it('makes no group for a Fan Out whose items reply in the home chat', async () => {
    const { runId, homeIds, lane } = await seedFanOutRun(1);
    for (const laneIndex of [0, 1]) {
      await seedCompletedNodeRun(db, {
        ...lane(laneIndex),
        nodeId: 'reply',
        blockType: 'chat_reply',
        outputs: homeIds,
      });
    }

    await expect(listSidebarBatchGroups(db, [runId])).resolves.toEqual([]);
  });
});
