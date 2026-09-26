import { beforeEach, describe, expect, it } from 'vitest';
import { createChat } from '../db/repos/chats';
import { getOrCreateFlowRunByIdempotencyKey } from '../db/repos/flow-runs';
import { createFlowVersion } from '../db/repos/flow-versions';
import { createFlow } from '../db/repos/flows';
import { createTask } from '../db/repos/tasks';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import { listSidebarBatchGroups } from './batch-summaries';

const GRAPH = { nodes: [], edges: [] };

describe('listSidebarBatchGroups', () => {
  let db: TestDb;
  let versionId: string;

  beforeEach(async () => {
    db = freshDb();
    const flow = await createFlow(db, { name: 'Triage' });
    const version = await createFlowVersion(db, { flowId: flow.id, graph: GRAPH });
    versionId = version.id;
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

    const groups = await listSidebarBatchGroups(db);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      batch_id: 'b1',
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

    const groups = await listSidebarBatchGroups(db);

    expect(groups.map((g) => g.batch_id).sort()).toEqual(['b1', 'b2']);
  });

  it('returns [] when no run belongs to a batch', async () => {
    await seedRun(null, 'completed');
    await expect(listSidebarBatchGroups(db)).resolves.toEqual([]);
  });

  it('orders by most-recent activity and truncates at the limit (the "20 most-active" contract)', async () => {
    await seedRun('older', 'completed', new Date('2026-01-01T00:00:00.000Z'));
    await seedRun('newer', 'running', new Date('2026-06-01T00:00:00.000Z'));

    // limit=1 must keep the most-recently-active batch, not an arbitrary one.
    const groups = await listSidebarBatchGroups(db, 1);

    expect(groups.map((g) => g.batch_id)).toEqual(['newer']);
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

    const [g] = await listSidebarBatchGroups(db);

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

    const groups = await listSidebarBatchGroups(db);

    expect(groups).toEqual([
      expect.objectContaining({
        batch_id: 'b1',
        run_count: 2,
        completed_count: 1,
        failed_count: 1,
      }),
    ]);
  });
});
