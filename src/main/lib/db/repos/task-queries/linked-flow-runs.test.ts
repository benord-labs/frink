import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fanOutItemChatRunIds } from '../../../flows/fan-out/sql';
import { type FlowRun, flowRuns, nodeRuns, subChats } from '../../schema';
import {
  getActiveFlowRunForSubChat,
  getBatchIdByChatId,
  getOrCreateFlowRunByIdempotencyKey,
  listChatIdsWithActiveFlowRun,
} from '../flow-runs';
import { setKv } from '../flow-kv-state';
import { createTask, updateTaskStatus } from '../tasks';
import { seedCompletedNodeRun, seedFlowRun } from '../../test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../test-utils/fresh-db';
import { linkedFlowRunIds } from './linked-flow-runs';
import { activeFlowRunForSubChatId } from './subchat-driver';

let db: TestDb;

beforeEach(() => {
  db = freshDb();
});

function queryPlan(query: { toSQL(): { sql: string; params: unknown[] } }): string {
  const { sql: text, params } = query.toSQL();
  const rows = db.$client
    .prepare(`EXPLAIN QUERY PLAN ${text}`)
    .all(...(params as never[])) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join('\n');
}

describe('linkedFlowRunIds', () => {
  it('reads every chat link source through its expression index', () => {
    const plan = queryPlan(linkedFlowRunIds(db, 'chatId', ['chat-1', 'chat-2']));
    expect(plan).toContain('USING INDEX flow_runs_trigger_chat_idx');
    expect(plan).toContain('USING INDEX node_runs_output_chat_idx');
    expect(plan).toContain('USING INDEX tasks_result_chat_idx');
  });

  it('keeps the per-pane sub-chat lookup on the sub-chat indexes', () => {
    const plan = queryPlan(activeFlowRunForSubChatId(db, 'sub-1'));
    expect(plan).toContain('USING INDEX flow_runs_trigger_sub_chat_idx');
    expect(plan).toContain('USING INDEX node_runs_output_sub_chat_idx');
    expect(plan).toContain('USING INDEX tasks_result_sub_chat_idx');
    expect(plan).toContain('USING INDEX flow_kv_state_uniq');
    expect(plan).not.toMatch(/SCAN (node_runs|fo_)/);
  });

  it('resolves the Fan Out item check through indexes in the correlated form', () => {
    const plan = queryPlan(
      db
        .select({ runId: sql`(${activeFlowRunForSubChatId(db, sql`${subChats.id}`)})` })
        .from(subChats),
    );
    expect(plan).toContain('SEARCH fo_kv USING INDEX flow_kv_state_uniq');
    expect(plan).not.toMatch(/SCAN fo_/);
  });

  it('finds Fan Out runs that open item chats through the lane index, not a node_runs scan', () => {
    const plan = queryPlan(
      db.select({ id: sql`flow_run_id` }).from(sql`(${fanOutItemChatRunIds})`),
    );
    expect(plan).toContain('USING INDEX node_runs_parent_fan_out_idx');
    expect(plan).not.toMatch(/SCAN fo_/);
  });

  it('finds a run through node outputs and tolerates a malformed JSON row', async () => {
    const { flowRunId } = await seedFlowRun(db, { nodes: [], edges: [] });
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'start',
      blockType: 'start_task',
      outputs: { chatId: 'chat-1', subChatId: 'sub-1' },
    });
    const broken = await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'other',
      blockType: 'agent',
    });
    // The indexes evaluate on write, so a malformed row must stay writable rather than fail.
    db.run(sql`UPDATE ${nodeRuns} SET node_output = '{broken' WHERE ${eq(nodeRuns.id, broken.id)}`);

    expect(linkedFlowRunIds(db, 'chatId', ['chat-1']).all()).toEqual([{ id: flowRunId }]);
    expect(linkedFlowRunIds(db, 'subChatId', 'sub-1').all()).toEqual([{ id: flowRunId }]);
  });

  it('finds a run a branch chat is linked to only through its task result', async () => {
    const { flowRunId } = await seedFlowRun(db, { nodes: [], edges: [] });
    await createTask(db, {
      description: 'branch',
      source: 'flow',
      flowRunId,
      result: { chatId: 'branch-chat', subChatId: 'branch-sub' },
    });

    expect(linkedFlowRunIds(db, 'chatId', ['branch-chat']).all()).toEqual([{ id: flowRunId }]);
    expect(linkedFlowRunIds(db, 'subChatId', 'branch-sub').all()).toEqual([{ id: flowRunId }]);
  });

  // Catches a post-task run being owned by the finished task's chat: archiving that chat
  // would cancel the run, and the run would drive the chat's tab, badge, banner and rollback guard.
  it('does not link a post-task run to the chat its trigger names, only other triggers', async () => {
    const { versionId } = await seedFlowRun(db, { nodes: [], edges: [] });
    const ids = { chatId: 'done-chat', subChatId: 'done-sub' };
    const seedRun = async (key: string, triggerContext: FlowRun['triggerContext']) =>
      (
        await getOrCreateFlowRunByIdempotencyKey(db, {
          flowVersionId: versionId,
          status: 'running',
          triggerContext,
          idempotencyKey: key,
          startedAt: new Date(),
        })
      ).run.id;
    const postTask = await seedRun('pt', {
      _frinkTrigger: 'post_task_trigger',
      taskId: 't',
      ...ids,
    });
    const fromChat = await seedRun('chat', ids);

    const only = [{ id: fromChat }];
    expect(linkedFlowRunIds(db, 'chatId', ['done-chat']).all()).toEqual(only);
    expect(linkedFlowRunIds(db, 'subChatId', 'done-sub').all()).toEqual(only);

    await db.delete(flowRuns).where(eq(flowRuns.id, fromChat));
    expect(await listChatIdsWithActiveFlowRun(db)).toEqual([]);
    // A grouped run (a batch, or a Fan Out that opened item chats) must not fold that chat in.
    await db.update(flowRuns).set({ batchId: 'group-1' }).where(eq(flowRuns.id, postTask));
    expect((await getBatchIdByChatId(db)).has('done-chat')).toBe(false);
  });
});

/**
 * A sequential Fan Out run: the home chat from the Start Task before the loop, then three items, each
 * opening its own chat. `currentIndex` is the loop's live item; null means the loop has finished.
 */
async function seedFanOutRun(currentIndex: number | null) {
  const { flowId, flowRunId } = await seedFlowRun(db, { nodes: [], edges: [] });
  await seedCompletedNodeRun(db, {
    flowRunId,
    nodeId: 'start',
    blockType: 'start_task',
    outputs: { chatId: 'home', subChatId: 'home-sub' },
  });
  const fan = await seedCompletedNodeRun(db, { flowRunId, nodeId: 'fan', blockType: 'fan_out' });
  for (const laneIndex of [0, 1, 2]) {
    const lane = { flowRunId, laneIndex, parentFanOutNodeRunId: fan.id };
    const ids = { chatId: `item-${laneIndex}`, subChatId: `item-${laneIndex}-sub` };
    await seedCompletedNodeRun(db, {
      ...lane,
      nodeId: 'item-start',
      blockType: 'start_task',
      outputs: ids,
    });
    const draft = await seedCompletedNodeRun(db, { ...lane, nodeId: 'draft', blockType: 'agent' });
    const task = await createTask(db, {
      description: 'draft',
      source: 'flow',
      flowRunId,
      nodeRunId: draft.id,
      result: ids,
    });
    await updateTaskStatus(db, task.id, 'done');
  }
  if (currentIndex !== null) {
    await setKv(db, flowId, `_fanOut:${flowRunId}:fan`, { currentIndex });
  }
  return flowRunId;
}

describe('Fan Out item liveness', () => {
  it('lets only the current item and the home chat drive the live run', async () => {
    const flowRunId = await seedFanOutRun(1);

    expect((await listChatIdsWithActiveFlowRun(db)).sort()).toEqual(['home', 'item-1']);
    expect(await getActiveFlowRunForSubChat(db, 'item-0-sub')).toBeNull();
    expect(await getActiveFlowRunForSubChat(db, 'item-1-sub')).toEqual({ id: flowRunId });
    expect(await getActiveFlowRunForSubChat(db, 'item-2-sub')).toBeNull();
    expect(await getActiveFlowRunForSubChat(db, 'home-sub')).toEqual({ id: flowRunId });
  });

  it('releases every item once the loop finishes, while the home chat stays live', async () => {
    const flowRunId = await seedFanOutRun(null);

    expect(await listChatIdsWithActiveFlowRun(db)).toEqual(['home']);
    expect(await getActiveFlowRunForSubChat(db, 'item-2-sub')).toBeNull();
    expect(await getActiveFlowRunForSubChat(db, 'home-sub')).toEqual({ id: flowRunId });
  });

  it('still links a finished item to its run for history readers', async () => {
    const flowRunId = await seedFanOutRun(2);

    expect(linkedFlowRunIds(db, 'subChatId', 'item-0-sub').all()).toEqual([{ id: flowRunId }]);
  });

  it('keeps a chat live through a task that has no node run', async () => {
    const flowRunId = await seedFanOutRun(0);
    await createTask(db, {
      description: 'loose',
      source: 'flow',
      flowRunId,
      result: { chatId: 'loose', subChatId: 'loose-sub' },
    });

    expect((await listChatIdsWithActiveFlowRun(db)).sort()).toEqual(['home', 'item-0', 'loose']);
    expect(await getActiveFlowRunForSubChat(db, 'loose-sub')).toEqual({ id: flowRunId });
  });
});
