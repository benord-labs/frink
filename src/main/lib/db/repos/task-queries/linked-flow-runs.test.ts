import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { nodeRuns } from '../../schema';
import { createTask } from '../tasks';
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
    expect(plan).not.toMatch(/SCAN node_runs/);
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
});
