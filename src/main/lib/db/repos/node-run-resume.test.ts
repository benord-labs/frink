import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { FlowResumeSnapshot } from '../../../../shared/types/flow-run/resume';
import { chats, subChats, tasks } from '../schema';
import { seedFlowRun } from '../test-utils/flow-fixtures';
import { freshDb } from '../test-utils/fresh-db';
import {
  createNodeRun,
  getNodeRun,
  listNodeRunsForFlowRun,
  nodeMatchesResumeSnapshot,
  setNodeRunStatus,
} from './node-runs';

async function parkedNode() {
  const db = freshDb();
  const { flowRunId } = await seedFlowRun(db, { nodes: [], edges: [] });
  const node = await createNodeRun(db, {
    flowRunId,
    nodeId: 'plan',
    blockType: 'agent',
    status: 'awaiting_input',
    nodeOutput: { outputs: { summary: 'Review plan' } },
  });
  await db.insert(chats).values({ id: 'chat' });
  const messages = [{ id: 'plan', role: 'assistant', content: 'Plan A' }];
  await db
    .insert(subChats)
    .values({ id: 'sub', chatId: 'chat', messages: JSON.stringify(messages) });
  const result = { subChatId: 'sub', resumedAt: '2026-09-27T10:00:00.001Z' };
  await db.insert(tasks).values({
    id: 'task',
    description: 'Plan',
    source: 'flow',
    flowRunId,
    nodeRunId: node.id,
    status: 'plan_ready',
    result,
  });
  const snapshot: FlowResumeSnapshot = {
    status: node.status,
    nodeOutput: node.nodeOutput,
    startedAt: null,
    completedAt: null,
    attemptIds: [node.id],
    drivingTask: { id: 'task', status: 'plan_ready', result },
    plan: { subChatId: 'sub', messages },
  };
  return { db, node, snapshot, flowRunId };
}

describe('node resume snapshot CAS', () => {
  it('orders attempts by insertion when creation timestamps tie across different statuses', async () => {
    const { db, node, flowRunId } = await parkedNode();
    await setNodeRunStatus(db, node.id, 'failed');
    const next = await createNodeRun(db, {
      flowRunId,
      nodeId: node.nodeId,
      blockType: 'agent',
      status: 'awaiting_input',
      createdAt: node.createdAt,
    });
    expect((await listNodeRunsForFlowRun(db, flowRunId)).map((entry) => entry.id)).toEqual([
      node.id,
      next.id,
    ]);
  });

  it('completes the unchanged reviewed park', async () => {
    const { db, node, snapshot } = await parkedNode();
    expect(nodeMatchesResumeSnapshot(db, node.id, snapshot)).toBe(true);
    expect(
      await setNodeRunStatus(db, node.id, 'completed', { expectResumeSnapshot: snapshot }),
    ).toMatchObject({ status: 'completed' });
  });

  it('refuses a resumed and re-parked same node with a changed question', async () => {
    const { db, node, snapshot } = await parkedNode();
    await setNodeRunStatus(db, node.id, 'running', { nodeOutput: null });
    await setNodeRunStatus(db, node.id, 'awaiting_input', {
      nodeOutput: { signal: 'awaiting_input', outputs: { summary: 'New question' } },
    });
    expect(
      await setNodeRunStatus(db, node.id, 'completed', { expectResumeSnapshot: snapshot }),
    ).toBeNull();
    expect((await getNodeRun(db, node.id))?.nodeOutput).toMatchObject({ signal: 'awaiting_input' });
  });

  it('refuses a newer attempt even when the previous parked row did not change', async () => {
    const { db, node, snapshot, flowRunId } = await parkedNode();
    await createNodeRun(db, {
      flowRunId,
      nodeId: node.nodeId,
      blockType: 'agent',
      status: 'awaiting_input',
    });
    expect(nodeMatchesResumeSnapshot(db, node.id, snapshot)).toBe(false);
    expect(
      await setNodeRunStatus(db, node.id, 'completed', { expectResumeSnapshot: snapshot }),
    ).toBeNull();
  });

  it('refuses a changed task when the node state is identical', async () => {
    const { db, node, snapshot } = await parkedNode();
    await db
      .update(tasks)
      .set({
        result: {
          ...(snapshot.drivingTask!.result as object),
          resumedAt: '2026-09-27T10:00:00.002Z',
        },
      })
      .where(eq(tasks.id, 'task'));
    expect(
      await setNodeRunStatus(db, node.id, 'completed', { expectResumeSnapshot: snapshot }),
    ).toBeNull();
  });

  it('refuses a changed plan transcript when the task and node are unchanged', async () => {
    const { db, node, snapshot } = await parkedNode();
    await db
      .update(subChats)
      .set({ messages: JSON.stringify([{ role: 'assistant', content: 'Plan B' }]) })
      .where(eq(subChats.id, 'sub'));
    expect(
      await setNodeRunStatus(db, node.id, 'completed', { expectResumeSnapshot: snapshot }),
    ).toBeNull();
  });

  it('refuses a new sub-chat driver while the original node and task are unchanged', async () => {
    const { db, node, snapshot, flowRunId } = await parkedNode();
    const nextNode = await createNodeRun(db, {
      flowRunId,
      nodeId: 'other-agent',
      blockType: 'agent',
      status: 'awaiting_input',
    });
    await db.insert(tasks).values({
      id: 'new-task',
      description: 'New plan',
      source: 'flow',
      flowRunId,
      nodeRunId: nextNode.id,
      status: 'plan_ready',
      result: { subChatId: 'sub' },
      createdAt: new Date(Date.now() + 1000),
    });
    expect(
      await setNodeRunStatus(db, node.id, 'completed', { expectResumeSnapshot: snapshot }),
    ).toBeNull();
    expect((await getNodeRun(db, node.id))?.status).toBe('awaiting_input');
  });
});
