import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { flowRunAdmissions, flowRuns, tasks } from '../../db/schema';
import { claimTask, getPendingTaskIds, recoverOrphanedTasks } from '../../db/repos/tasks';
import { seedActiveAdmission, seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import { startPlanExecutionCommand, startWaitingTaskCommand } from './start-plan-execution';

const GRAPH = { nodes: [{ id: 'agent', blockType: 'agent', position: { x: 0, y: 0 } }], edges: [] };

async function seedPlanReady(flow: boolean) {
  const db = freshDb();
  const { flowRunId } = await seedFlowRun(db, GRAPH);
  const ticket = seedActiveAdmission(db, flowRunId);
  db.update(flowRuns).set({ status: 'paused' }).where(eq(flowRuns.id, flowRunId)).run();
  db.insert(tasks)
    .values({
      id: 'task-1',
      description: 'Plan',
      source: flow ? 'flow' : 'manual',
      flowRunId: flow ? flowRunId : null,
      status: 'plan_ready',
    })
    .run();
  return { db, flowRunId, ticket };
}

const taskStatus = (db: TestDb) =>
  db.select().from(tasks).where(eq(tasks.id, 'task-1')).get()?.status;

describe('startPlanExecutionCommand', () => {
  it('starts a Flow plan while its live run holds an active slot', async () => {
    const { db } = await seedPlanReady(true);
    const { task } = startPlanExecutionCommand(db, 'task-1', 'machine');
    expect(task).toMatchObject({ status: 'running', executedBy: 'machine' });
  });

  it('refuses, writing nothing, once the slot is releasing', async () => {
    const { db, ticket } = await seedPlanReady(true);
    db.update(flowRunAdmissions)
      .set({ state: 'releasing' })
      .where(eq(flowRunAdmissions.ticket, ticket))
      .run();
    expect(startPlanExecutionCommand(db, 'task-1', 'machine')).toEqual({
      task: null,
      reason: 'flow_admission_lost',
    });
    expect(taskStatus(db)).toBe('plan_ready');
  });

  it('refuses with no admission row at all', async () => {
    const { db, ticket } = await seedPlanReady(true);
    db.delete(flowRunAdmissions).where(eq(flowRunAdmissions.ticket, ticket)).run();
    expect(startPlanExecutionCommand(db, 'task-1', 'machine').reason).toBe('flow_admission_lost');
    expect(taskStatus(db)).toBe('plan_ready');
  });

  it.each(['cancelled', 'failed', 'completed'] as const)(
    'refuses a %s run whose slot is still active before its release reconciles',
    async (status) => {
      const { db, flowRunId } = await seedPlanReady(true);
      db.update(flowRuns).set({ status }).where(eq(flowRuns.id, flowRunId)).run();
      expect(startPlanExecutionCommand(db, 'task-1', 'machine').reason).toBe('flow_admission_lost');
      expect(taskStatus(db)).toBe('plan_ready');
    },
  );

  it('starts a non-Flow plan without any admission', async () => {
    const { db } = await seedPlanReady(false);
    db.delete(flowRunAdmissions).run();
    expect(startPlanExecutionCommand(db, 'task-1', null).task).toMatchObject({
      status: 'running',
    });
  });

  it('reports invalid_state for a task that is not plan_ready, and not_found for none', async () => {
    const { db } = await seedPlanReady(true);
    db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, 'task-1')).run();
    expect(startPlanExecutionCommand(db, 'task-1', 'machine').reason).toBe('invalid_state');
    expect(startPlanExecutionCommand(db, 'missing', 'machine').reason).toBe('not_found');
  });
});

/** A Wait-mode Flow step as its dispatch creates it: pending, linked to its chat, never claimed. */
async function seedWaiting() {
  const { db, flowRunId, ticket } = await seedPlanReady(true);
  db.update(tasks)
    .set({
      status: 'pending',
      result: { chatId: 'chat-1', subChatId: 'sub-1' },
      triggerContext: { _config: { startMode: 'wait', executionMode: 'continue_chat' } },
    })
    .where(eq(tasks.id, 'task-1'))
    .run();
  return { db, flowRunId, ticket };
}

const taskRow = (db: TestDb) => db.select().from(tasks).where(eq(tasks.id, 'task-1')).get();

describe('startWaitingTaskCommand', () => {
  it('releases a waiting step to the poller in its own chat, leaving it pending', async () => {
    const { db } = await seedWaiting();
    expect(await getPendingTaskIds(db)).toEqual([]);

    const { task } = startWaitingTaskCommand(db, 'task-1');

    expect(task).toMatchObject({
      status: 'pending',
      result: { chatId: 'chat-1', subChatId: 'sub-1', startMode: 'execute' },
    });
    expect(await getPendingTaskIds(db)).toEqual([{ id: 'task-1' }]);
  });

  it('returns the started task on a repeat Start, before and after the claim', async () => {
    const { db } = await seedWaiting();
    const first = startWaitingTaskCommand(db, 'task-1').task;
    expect(startWaitingTaskCommand(db, 'task-1').task).toEqual(first);

    await claimTask(db, 'task-1', 'machine');
    expect(startWaitingTaskCommand(db, 'task-1').task).toMatchObject({ status: 'running' });
  });

  it('still starts after the boot sweep, which leaves a waiting step alone', async () => {
    const { db } = await seedWaiting();
    expect(await recoverOrphanedTasks(db)).toEqual([]);
    expect(startWaitingTaskCommand(db, 'task-1').task?.result).toMatchObject({
      startMode: 'execute',
    });
  });

  it.each<'cancelled' | 'failed' | 'completed'>(['cancelled', 'failed', 'completed'])(
    'refuses under a %s run, leaving the step waiting',
    async (status) => {
      const { db, flowRunId } = await seedWaiting();
      db.update(flowRuns).set({ status }).where(eq(flowRuns.id, flowRunId)).run();
      expect(startWaitingTaskCommand(db, 'task-1').reason).toBe('flow_admission_lost');
      expect(taskRow(db)?.result).toEqual({ chatId: 'chat-1', subChatId: 'sub-1' });
    },
  );

  it('refuses once the run no longer holds its slot', async () => {
    const { db, ticket } = await seedWaiting();
    db.update(flowRunAdmissions)
      .set({ state: 'releasing' })
      .where(eq(flowRunAdmissions.ticket, ticket))
      .run();
    expect(startWaitingTaskCommand(db, 'task-1').reason).toBe('flow_admission_lost');
  });

  it('reports a stopped step as invalid_state even when its run is gone, and not_found for none', async () => {
    const { db, flowRunId } = await seedWaiting();
    db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, 'task-1')).run();
    db.update(flowRuns).set({ status: 'cancelled' }).where(eq(flowRuns.id, flowRunId)).run();
    expect(startWaitingTaskCommand(db, 'task-1').reason).toBe('invalid_state');
    expect(startWaitingTaskCommand(db, 'missing').reason).toBe('not_found');
  });
});
