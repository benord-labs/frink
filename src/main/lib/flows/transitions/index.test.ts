import { beforeEach, describe, expect, it, vi } from 'vitest';

const captureFlowAdmissionException = vi.hoisted(() => vi.fn());
vi.mock('../admission/activity', () => ({ captureFlowAdmissionException }));

import { getFlowRun } from '../../db/repos/flow-runs';
import {
  cancelTaskDetailed,
  createTask,
  getTaskById,
  updateTaskStatus,
} from '../../db/repos/tasks';
import { seedActiveAdmission, seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import {
  _resetFlowAdmissionControllerMutexForTests,
  FlowAdmissionController,
} from '../admission/controller';
import type { readFlowAdmissionConfig } from '../admission/config';
import { admissionByTicket, cancelAdmission } from '../admission/store';
import { runTransition } from '.';

const GRAPH = { nodes: [], edges: [], settings: {} };

describe('FlowAdmissionController.transition', () => {
  let db: TestDb;
  let controller: FlowAdmissionController;
  let flowRunId: string;
  let ticket: number;

  beforeEach(async () => {
    _resetFlowAdmissionControllerMutexForTests();
    captureFlowAdmissionException.mockReset();
    db = freshDb();
    controller = new FlowAdmissionController(db);
    ({ flowRunId } = await seedFlowRun(db, GRAPH));
    ticket = seedActiveAdmission(db, flowRunId);
  });

  it('commits a command whose helper opens its own transaction, then runs afterCommit on the committed state', async () => {
    const task = await createTask(db, { description: 'step', source: 'flow', flowRunId });
    await updateTaskStatus(db, task.id, 'running');
    const seen: string[] = [];

    const result = await controller.transition(
      () => {
        cancelAdmission(db, ticket, new Date());
        queueMicrotask(() => seen.push('microtask'));
        return cancelTaskDetailed(db, task.id);
      },
      (cancelled) => {
        seen.push(
          `${cancelled.task?.status}`,
          `${admissionByTicket(db, ticket)?.state}`,
          `inTransaction=${db.$client.inTransaction}`,
        );
      },
    );

    expect(result.previous?.status).toBe('running');
    expect(seen).toEqual(['cancelled', 'releasing', 'inTransaction=false', 'microtask']);
    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
    expect((await getTaskById(db, task.id))?.status).toBe('cancelled');
  });

  it('returns the committed result and captures the error when afterCommit throws', async () => {
    const afterCommitError = new Error('abort fan-out failed');

    const result = await controller.transition(
      () => cancelAdmission(db, ticket, new Date())?.state,
      () => {
        throw afterCommitError;
      },
    );

    expect(result).toBe('releasing');
    expect(admissionByTicket(db, ticket)?.state).toBe('releasing');
    expect(captureFlowAdmissionException).toHaveBeenCalledWith(afterCommitError, 'after-commit');
  });

  it('waits for another controller operation holding the admission mutex', async () => {
    let releaseRead: () => void = () => {};
    const parked = new FlowAdmissionController(
      db,
      () =>
        new Promise((resolve) => {
          releaseRead = () => resolve({} as Awaited<ReturnType<typeof readFlowAdmissionConfig>>);
        }),
    );
    const command = vi.fn(() => 'done');

    const refreshing = parked.refreshConfig();
    const transitioning = parked.transition(command);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(command).not.toHaveBeenCalled();

    releaseRead();
    await refreshing;
    await expect(transitioning).resolves.toBe('done');
  });

  it('rolls the command back and skips afterCommit when the command throws', async () => {
    const afterCommit = vi.fn();

    await expect(
      controller.transition(() => {
        cancelAdmission(db, ticket, new Date());
        throw new Error('decided to refuse');
      }, afterCommit),
    ).rejects.toThrow('decided to refuse');

    expect(afterCommit).not.toHaveBeenCalled();
    expect(admissionByTicket(db, ticket)?.state).toBe('active');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
  });
});

describe('runTransition', () => {
  it('rejects an async command and rolls back its writes', async () => {
    const db = freshDb();
    const { flowRunId } = await seedFlowRun(db, GRAPH);

    expect(() =>
      runTransition(db, async () => {
        db.$client.prepare("update flow_runs set status = 'failed' where id = ?").run(flowRunId);
      }),
    ).toThrow('must be synchronous');

    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
  });
});
