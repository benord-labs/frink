import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOrCreateFlowRunByIdempotencyKey } from '../db/repos/flow-runs';
import { create as createBinding } from '../db/repos/flow-trigger-bindings';
import { createFlowVersion } from '../db/repos/flow-versions';
import { createFlow } from '../db/repos/flows';
import { createProject } from '../db/repos/projects';
import { TRIGGER_SCHEMAS } from '../../../shared/lib/output-schemas';
import { chats, flows, flowTriggerBindings, projects, tasks } from '../db/schema';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';

const startFlowRunMock = vi.hoisted(() => vi.fn());
let db: TestDb;

// getDatabase is the process-wide connection with no injection seam; this swaps in a fresh SQLite.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../db', () => ({ getDatabase: () => db }));
// startFlowRun executes the whole flow graph; the tick under test only decides whether to call it.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('./start', () => ({ startFlowRun: startFlowRunMock }));

import log from 'electron-log';
import {
  type PostTaskTriggerDeps,
  postTaskIdempotencyKey,
  runPostTaskTriggerTick,
  selectPendingPairs,
  startPostTaskTriggerLoop,
  stopPostTaskTriggerLoop,
} from './post-task-trigger';
import type { StartFlowRunInput } from './start';

describe('post_task_trigger tick with a project-less binding (sc-3299)', () => {
  beforeEach(async () => {
    db = freshDb();
    startFlowRunMock.mockReset();
    await db.insert(projects).values({ id: 'proj-1', name: 'P', path: '/tmp/sc-3299' });
    await db.insert(flows).values([
      { id: 'flow-scoped', name: 'Scoped' },
      { id: 'flow-unscoped', name: 'Unscoped' },
    ]);
    // Only flows with a saved version can start; like the real start, the mock records the run.
    const version = await createFlowVersion(db, {
      flowId: 'flow-scoped',
      graph: { nodes: [], edges: [] },
    });
    startFlowRunMock.mockImplementation(async (input: StartFlowRunInput) => {
      if (!input.idempotencyKey) throw new Error('post-task starts always carry a key');
      await seedFiredRun(db, version.id, input.idempotencyKey);
      return { isReplay: false };
    });
    // Direct inserts: the repo now rejects a project-less post_task_trigger, but legacy rows exist.
    await db.insert(flowTriggerBindings).values([
      {
        id: 'b-scoped',
        flowId: 'flow-scoped',
        projectId: 'proj-1',
        triggerType: 'post_task_trigger',
      },
      {
        id: 'b-unscoped',
        flowId: 'flow-unscoped',
        projectId: null,
        triggerType: 'post_task_trigger',
      },
    ]);
    await db.insert(tasks).values({
      id: 'task-1',
      projectId: 'proj-1',
      description: 'd',
      source: 'manual',
      status: 'done',
      completedAt: new Date(),
    });
  });

  afterEach(() => {
    stopPostTaskTriggerLoop();
    vi.restoreAllMocks();
  });

  it('fires the scoped binding and warns once about the project-less one', async () => {
    const warn = vi.spyOn(log, 'warn');

    await runPostTaskTriggerTick();
    await runPostTaskTriggerTick();

    expect(startFlowRunMock).toHaveBeenCalledTimes(1);
    expect(startFlowRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: 'flow-scoped',
        idempotencyKey: 'post_task:b-scoped:task-1',
      }),
    );
    const unscopedWarns = warn.mock.calls.filter(
      ([msg]) => msg === '[PostTaskTrigger] skipping binding with no projectId',
    );
    expect(unscopedWarns).toEqual([
      [
        '[PostTaskTrigger] skipping binding with no projectId',
        { bindingId: 'b-unscoped', flowId: 'flow-unscoped' },
      ],
    ]);
  });

  it('warns even when every active binding is project-less', async () => {
    await db.delete(flowTriggerBindings);
    await db.insert(flowTriggerBindings).values({
      id: 'b-only',
      flowId: 'flow-unscoped',
      projectId: '  ',
      triggerType: 'post_task_trigger',
    });
    const warn = vi.spyOn(log, 'warn');

    await expect(runPostTaskTriggerTick()).resolves.toEqual({ fired: 0, skipped: 0 });

    expect(startFlowRunMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[PostTaskTrigger] skipping binding with no projectId', {
      bindingId: 'b-only',
      flowId: 'flow-unscoped',
    });
  });
});

const BINDING_CREATED_AT = new Date('2026-01-01T00:00:00Z');
const BEFORE = new Date('2025-12-31T00:00:00Z');
const AFTER = new Date('2026-01-02T00:00:00Z');

async function seedFlow(db: TestDb, opts: { enabled?: boolean } = {}) {
  const flow = await createFlow(db, { name: 'F', isEnabled: opts.enabled ?? true });
  const version = await createFlowVersion(db, {
    flowId: flow.id,
    graph: { nodes: [], edges: [] },
  });
  return { flowId: flow.id, versionId: version.id };
}

async function seedBinding(
  db: TestDb,
  flowId: string,
  projectId: string,
  overrides: { triggerType?: string; isActive?: boolean } = {},
) {
  return createBinding(db, {
    flowId,
    projectId,
    triggerType: 'post_task_trigger',
    createdAt: BINDING_CREATED_AT,
    ...overrides,
  });
}

async function seedTerminalTask(
  db: TestDb,
  projectId: string,
  completedAt: Date | null,
  status = 'completed',
) {
  const [row] = await db
    .insert(tasks)
    .values({
      projectId,
      title: 'T',
      description: 'd',
      source: 'manual',
      status,
      completedAt,
    })
    .returning();
  return row;
}

/** What a real startFlowRun leaves behind: a flow_run carrying the idempotency key. */
async function seedFiredRun(db: TestDb, versionId: string, idempotencyKey: string) {
  await getOrCreateFlowRunByIdempotencyKey(db, {
    flowVersionId: versionId,
    status: 'completed',
    triggerContext: null,
    idempotencyKey,
    startedAt: new Date(),
  });
}

describe('post-task-trigger tick', () => {
  let projectId: string;
  // Real flow starts dispatch agents; the boundary under test is which pairs reach the start.
  const start = vi.fn<PostTaskTriggerDeps['startFlowRun']>();
  const tick = () => runPostTaskTriggerTick({ db, startFlowRun: start });

  // What a real start leaves behind, so the next tick sees the pair as fired.
  const recordFiredRun = async (versionId: string, input: StartFlowRunInput) => {
    if (!input.idempotencyKey) throw new Error('post-task starts always carry a key');
    await seedFiredRun(db, versionId, input.idempotencyKey);
    return { isReplay: false };
  };

  beforeEach(async () => {
    db = freshDb();
    start.mockReset();
    stopPostTaskTriggerLoop();
    projectId = (await createProject(db, { name: 'P', path: '/tmp/p' })).id;
  });

  it('after a restart, history whose pairs already fired starts nothing', async () => {
    const { flowId, versionId } = await seedFlow(db);
    const bindings = [
      await seedBinding(db, flowId, projectId),
      await seedBinding(db, (await seedFlow(db)).flowId, projectId),
    ];
    for (let i = 0; i < 20; i += 1) {
      const task = await seedTerminalTask(db, projectId, AFTER);
      for (const b of bindings) {
        await seedFiredRun(db, versionId, postTaskIdempotencyKey(b.id, task.id));
      }
    }

    stopPostTaskTriggerLoop();
    const result = await tick();

    expect(result).toEqual({ fired: 0, skipped: 0 });
    expect(start).not.toHaveBeenCalled();
  });

  it('fires only for tasks completed at or after binding creation, once each', async () => {
    const { flowId, versionId } = await seedFlow(db);
    const binding = await seedBinding(db, flowId, projectId);
    await seedTerminalTask(db, projectId, BEFORE);
    const sameSecond = await seedTerminalTask(db, projectId, BINDING_CREATED_AT);
    const after = await seedTerminalTask(db, projectId, AFTER);
    start.mockImplementation((input) => recordFiredRun(versionId, input));

    await tick();
    await tick();

    const keys = start.mock.calls.map(([input]) => input.idempotencyKey).sort();
    expect(keys).toEqual(
      [
        postTaskIdempotencyKey(binding.id, sameSecond.id),
        postTaskIdempotencyKey(binding.id, after.id),
      ].sort(),
    );
  });

  it('skips bindings whose flow is disabled or has no saved version', async () => {
    const disabled = await seedFlow(db, { enabled: false });
    const unsaved = await createFlow(db, { name: 'unsaved' });
    await seedBinding(db, disabled.flowId, projectId);
    await seedBinding(db, unsaved.id, projectId);
    await seedTerminalTask(db, projectId, AFTER);

    await tick();
    await tick();

    expect(start).not.toHaveBeenCalled();
  });

  it('a retried task that completes again does not fire a second run', async () => {
    const { flowId, versionId } = await seedFlow(db);
    const binding = await seedBinding(db, flowId, projectId);
    const task = await seedTerminalTask(db, projectId, AFTER);
    await seedFiredRun(db, versionId, postTaskIdempotencyKey(binding.id, task.id));

    await db
      .update(tasks)
      .set({ status: 'failed', completedAt: new Date('2026-02-01T00:00:00Z') })
      .where(eq(tasks.id, task.id));
    await tick();

    expect(start).not.toHaveBeenCalled();
  });
  // Catches a broken join: wrong project column, a dropped isActive/triggerType filter, a dropped
  // status/completedAt filter, or a projection that swaps binding and task ids in the context.
  it('fires once per eligible binding of the task own project, with that pair context', async () => {
    const other = (await createProject(db, { name: 'Q', path: '/tmp/q' })).id;
    const flowA = await seedFlow(db);
    const flowB = await seedFlow(db);
    const bindingA = await seedBinding(db, flowA.flowId, projectId);
    const bindingB = await seedBinding(db, flowB.flowId, projectId);
    await seedBinding(db, (await seedFlow(db)).flowId, projectId, { isActive: false });
    await seedBinding(db, (await seedFlow(db)).flowId, projectId, {
      triggerType: 'schedule_trigger',
    });
    await seedBinding(db, (await seedFlow(db)).flowId, other);
    const task = await seedTerminalTask(db, projectId, AFTER);
    await seedTerminalTask(db, projectId, AFTER, 'running');
    await seedTerminalTask(db, projectId, null);

    const result = await tick();

    expect(result).toEqual({ fired: 2, skipped: 0 });
    const calls = start.mock.calls.map(([input]) => input);
    expect(calls.map((c) => c.flowId).sort()).toEqual([flowA.flowId, flowB.flowId].sort());
    expect(calls.find((c) => c.flowId === flowA.flowId)).toEqual({
      flowId: flowA.flowId,
      idempotencyKey: postTaskIdempotencyKey(bindingA.id, task.id),
      triggerContext: {
        _frinkTrigger: 'post_task_trigger',
        bindingId: bindingA.id,
        taskId: task.id,
        projectId,
        taskStatus: 'completed',
        taskTitle: 'T',
        source: 'manual',
        taskCompletedAt: AFTER.toISOString(),
        projectPath: '/tmp/p',
      },
    });
    expect(calls.find((c) => c.flowId === flowB.flowId)?.idempotencyKey).toBe(
      postTaskIdempotencyKey(bindingB.id, task.id),
    );
  });

  // Catches the schema advertising a field the trigger never saves, or the reverse.
  it('saves every field TRIGGER_SCHEMAS lists for a task that ran in a chat', async () => {
    const { flowId } = await seedFlow(db);
    await seedBinding(db, flowId, projectId);
    await db.insert(chats).values({
      id: 'chat-1',
      projectId,
      worktreePath: '/tmp/p-wt',
      branch: 'feature',
      baseBranch: 'main',
    });
    const task = await seedTerminalTask(db, projectId, AFTER);
    await db
      .update(tasks)
      .set({
        result: {
          chatId: 'chat-1',
          subChatId: 'sub-1',
          executionLeaseId: 'lease-1',
          agentSignal: { state: 'done', summary: 'Shipped it' },
        },
      })
      .where(eq(tasks.id, task.id));

    await tick();

    const { _frinkTrigger, bindingId, ...fields } = start.mock.calls[0][0].triggerContext ?? {};
    expect({ _frinkTrigger, bindingId }).toEqual({
      _frinkTrigger: 'post_task_trigger',
      bindingId: expect.any(String),
    });
    expect(Object.keys(fields).sort()).toEqual(
      (TRIGGER_SCHEMAS.post_task_trigger ?? []).map((f) => f.key).sort(),
    );
    expect(fields).toMatchObject({
      result: 'Shipped it',
      chatId: 'chat-1',
      subChatId: 'sub-1',
      branch: 'feature',
      baseBranch: 'main',
      worktreePath: '/tmp/p-wt',
      projectPath: '/tmp/p',
    });
  });

  it('leaves out the optional fields a task without a chat or summary cannot fill', async () => {
    const { flowId } = await seedFlow(db);
    await seedBinding(db, flowId, projectId);
    const task = await seedTerminalTask(db, projectId, AFTER, 'cancelled');
    // A cancel result, and a chat link to a chat that no longer exists.
    await db
      .update(tasks)
      .set({ result: { cancelled: true, chatId: 'gone', subChatId: 'sub-gone' } })
      .where(eq(tasks.id, task.id));

    expect(await tick()).toEqual({ fired: 1, skipped: 0 });

    const ctx = start.mock.calls[0][0].triggerContext ?? {};
    const optional = (TRIGGER_SCHEMAS.post_task_trigger ?? [])
      .filter((f) => f.guaranteed === false && f.key !== 'projectPath')
      .map((f) => f.key);
    expect(optional.filter((key) => key in ctx)).toEqual([]);
    expect(ctx).toMatchObject({ taskId: task.id, taskStatus: 'cancelled', source: 'manual' });
  });

  // Catches a regression that memoises failed starts (the pair would never fire) or miscounts them.
  it('a failed start is counted as skipped and retried on the next tick', async () => {
    const { flowId } = await seedFlow(db);
    await seedBinding(db, flowId, projectId);
    await seedTerminalTask(db, projectId, AFTER);
    start.mockRejectedValueOnce(new Error('transient'));

    expect(await tick()).toEqual({ fired: 0, skipped: 1 });
    expect(await tick()).toEqual({ fired: 1, skipped: 0 });
    expect(start).toHaveBeenCalledTimes(2);
  });
  // Catches broken wiring (loop never runs the tick), a double start stacking two intervals, and
  // stop() failing to halt polling — each unit above can pass while the loop itself is wrong.
  it('the loop ticks once per interval, ignores a second start, and stops cleanly', async () => {
    const { flowId, versionId } = await seedFlow(db);
    await seedBinding(db, flowId, projectId);
    await seedTerminalTask(db, projectId, AFTER);
    await seedTerminalTask(db, projectId, AFTER);
    start.mockImplementation((input) => recordFiredRun(versionId, input));
    vi.useFakeTimers();
    try {
      startPostTaskTriggerLoop(() => ({ db, startFlowRun: start }));
      startPostTaskTriggerLoop(() => ({ db, startFlowRun: start }));
      expect(start).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(start).toHaveBeenCalledTimes(2);

      stopPostTaskTriggerLoop();
      await seedTerminalTask(db, projectId, AFTER);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(start).toHaveBeenCalledTimes(2);
    } finally {
      stopPostTaskTriggerLoop();
      vi.useRealTimers();
    }
  });
  // Catches the poll falling back to a full tasks scan (index missing from the migration, or the
  // query drifting off its columns) — it runs every 2s over the project's terminal-task history.
  it('seeks tasks through the project/status/completed index instead of scanning', async () => {
    const plan = (
      await db.all<{ detail: string }>(
        sql`EXPLAIN QUERY PLAN `.append(selectPendingPairs(db).getSQL()),
      )
    )
      .map((row) => row.detail)
      .join('\n');

    expect(plan).toContain('USING INDEX tasks_project_status_completed_idx');
    expect(plan).not.toMatch(/SCAN (tasks|flow_runs)\b/);
  });
});
