import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { flowRunAdmissions, flowRuns, tasks } from '../../db/schema';
import { seedActiveAdmission, seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import { startPlanExecutionCommand } from './start-plan-execution';

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
