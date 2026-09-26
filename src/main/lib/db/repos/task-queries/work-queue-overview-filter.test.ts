import { describe, expect, it } from 'vitest';
import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import { RESTART_INTERRUPTION_REASON } from '../../../../../shared/types/flow';
import { flowRunAdmissions, nodeRuns } from '../../schema';
import { seedFlowRun } from '../../test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../test-utils/fresh-db';
import { setFlowRunStatus } from '../flow-runs';
import {
  createTask,
  getPendingTaskIds,
  listTasksWithProjectPaginated,
  updateTaskStatus,
} from '../tasks';

const GRAPH: FlowGraph = {
  nodes: [{ id: 'agent', blockType: 'agent', config: {}, position: { x: 0, y: 0 } }],
  edges: [],
};

const listSection = (db: TestDb, section: 'attention' | 'inbox' | 'running', limit = 50) =>
  listTasksWithProjectPaginated(db, { workQueueSection: section, limit });

async function addTask(
  db: TestDb,
  description: string,
  triggerContext?: unknown,
  flowRunId?: string,
) {
  return createTask(db, {
    description,
    source: flowRunId ? 'flow' : 'manual',
    triggerContext,
    flowRunId,
  });
}

describe('Work Queue Overview section filter', () => {
  it('recognizes every persisted wait-mode shape and keeps each out of executor pickup', async () => {
    const db = freshDb();
    const contexts = [
      { _config: { startMode: 'wait' } },
      { _config: { start_mode: 'wait' } },
      { Config: { startMode: 'WAIT' } },
      { Config: { start_mode: 'wait' } },
    ];
    const waits = await Promise.all(
      contexts.map((context, index) => addTask(db, `wait-${index}`, context)),
    );
    const execute = await addTask(db, 'execute', { _config: { startMode: 'execute' } });

    const inboxIds = (await listSection(db, 'inbox')).items.map((task) => task.id);
    expect(new Set(inboxIds)).toEqual(new Set(waits.map((task) => task.id)));
    await expect(getPendingTaskIds(db)).resolves.toEqual([{ id: execute.id }]);
  });

  it('puts a Flow wait task in Inbox before effective running classification', async () => {
    const db = freshDb();
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const waiting = await addTask(db, 'flow-wait', { _config: { startMode: 'wait' } }, flowRunId);

    await expect(
      listSection(db, 'inbox').then((page) =>
        page.items.map((task) => ({ id: task.id, effectiveStatus: task.effectiveStatus })),
      ),
    ).resolves.toEqual([{ id: waiting.id, effectiveStatus: 'running' }]);
    await expect(listSection(db, 'running').then((page) => page.items)).resolves.toEqual([]);
    await expect(getPendingTaskIds(db)).resolves.toEqual([]);
  });

  it('filters attention before pagination so newer Running rows cannot hide review work', async () => {
    const db = freshDb();
    const review = await addTask(db, 'review-ready');
    await updateTaskStatus(db, review.id, 'done');
    for (let index = 0; index < 51; index += 1) {
      const running = await addTask(db, `running-${index}`);
      await updateTaskStatus(db, running.id, 'running');
    }

    const attention = await listSection(db, 'attention', 1);
    expect(attention.items.map((task) => task.id)).toEqual([review.id]);
    expect(attention.hasMore).toBe(false);
    expect((await listSection(db, 'running', 1)).hasMore).toBe(true);
  });

  it('includes every actionable status and excludes terminal archive states', async () => {
    const db = freshDb();
    const actionableStatuses = ['plan_ready', 'needs_attention', 'failed', 'done'] as const;
    const actionable = await Promise.all(
      actionableStatuses.map(async (status) => {
        const task = await addTask(db, status);
        await updateTaskStatus(db, task.id, status);
        return task.id;
      }),
    );
    for (const status of ['completed', 'cancelled'] as const) {
      const task = await addTask(db, status);
      await updateTaskStatus(db, task.id, status);
    }

    const first = await listSection(db, 'attention', 2);
    const second = await listTasksWithProjectPaginated(db, {
      workQueueSection: 'attention',
      cursor: first.nextCursor,
      limit: 2,
    });
    const ids = [...first.items, ...second.items].map((task) => task.id);
    expect(new Set(ids)).toEqual(new Set(actionable));
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(false);
  });

  it('includes a restart-interrupted Flow in attention', async () => {
    const db = freshDb();
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const task = await addTask(db, 'interrupted', undefined, flowRunId);
    await updateTaskStatus(db, task.id, 'cancelled', {
      result: { cancelled: true, error: RESTART_INTERRUPTION_REASON },
    });
    await setFlowRunStatus(db, flowRunId, 'cancelled');
    await db.insert(nodeRuns).values([
      {
        id: 'fan-parent',
        flowRunId,
        nodeId: 'fan',
        blockType: 'fan_out',
        status: 'completed',
      },
      {
        id: 'fan-branch',
        flowRunId,
        nodeId: 'agent',
        blockType: 'agent',
        status: 'cancelled',
        parentFanOutNodeRunId: 'fan-parent',
        laneIndex: 0,
      },
    ]);

    const attention = await listSection(db, 'attention');
    expect(attention.items.map((item) => item.effectiveStatus)).toEqual(['interrupted']);
  });

  it('excludes a Flow waiting for machine admission from every task lane', async () => {
    const db = freshDb();
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const task = await addTask(db, 'queued-retry', undefined, flowRunId);
    await updateTaskStatus(db, task.id, 'failed');
    await setFlowRunStatus(db, flowRunId, 'failed');
    await db.insert(flowRunAdmissions).values({
      flowRunId,
      state: 'queued',
      priorityClass: 'resume',
      intentVersion: 1,
      intentJson: { version: 1, action: 'resume', flow_run_id: flowRunId },
      requestedAt: new Date(),
    });

    await expect(listSection(db, 'attention').then((page) => page.items)).resolves.toEqual([]);
    await expect(listSection(db, 'running').then((page) => page.items)).resolves.toEqual([]);
    await expect(listSection(db, 'inbox').then((page) => page.items)).resolves.toEqual([]);
  });

  it('rejects ambiguous section and status filters', async () => {
    const db = freshDb();
    await expect(
      listTasksWithProjectPaginated(db, {
        workQueueSection: 'attention',
        status: 'done',
      }),
    ).rejects.toThrow(/cannot be combined/i);
  });
});
