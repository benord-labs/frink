import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flows, flowTriggerBindings, projects, tasks } from '../db/schema';
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
import { runPostTaskTriggerTick, stopPostTaskTriggerLoop } from './post-task-trigger';

describe('post_task_trigger tick with a project-less binding (sc-3299)', () => {
  beforeEach(async () => {
    db = freshDb();
    startFlowRunMock.mockReset();
    startFlowRunMock.mockResolvedValue({ id: 'run-1' });
    await db.insert(projects).values({ id: 'proj-1', name: 'P', path: '/tmp/sc-3299' });
    await db.insert(flows).values([
      { id: 'flow-scoped', name: 'Scoped' },
      { id: 'flow-unscoped', name: 'Unscoped' },
    ]);
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
