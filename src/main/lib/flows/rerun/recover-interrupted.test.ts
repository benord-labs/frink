import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RESTART_INTERRUPTION_REASON } from '../../../../shared/types/flow';
import { getOrCreateFlowRunByIdempotencyKey, setFlowRunStatus } from '../../db/repos/flow-runs';
import { createNodeRun, setNodeRunStatus } from '../../db/repos/node-runs';
import { tasks } from '../../db/schema';
import { seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import { type RecoverOne, recoverInterruptedRuns } from './recover-interrupted';

let db: TestDb;
let versionId: string;
let runCount = 0;

beforeEach(async () => {
  db = freshDb();
  runCount = 0;
  ({ versionId } = await seedFlowRun(db, { nodes: [], edges: [] }, { idempotencyKey: 'seed' }));
});

type SeedOpts = { blockType?: string; started?: boolean; marked?: boolean };

/** A run a restart cancelled mid-step (or a user Stop, without the marker), and the task that drove
 * its step. Returns the task id. */
async function seedStoppedRun(
  opts: SeedOpts = {},
): Promise<{ taskId: string; nodeRunId: string; flowRunId: string }> {
  runCount += 1;
  const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
    flowVersionId: versionId,
    status: 'running',
    triggerContext: null,
    idempotencyKey: `run-${runCount}`,
    startedAt: new Date(),
  });
  const blockType = opts.blockType ?? 'agent';
  const nodeRun = await createNodeRun(db, {
    flowRunId: run.id,
    nodeId: `node-${runCount}`,
    blockType,
    status: 'running',
  });
  await setNodeRunStatus(db, nodeRun.id, 'cancelled', {
    startedAt: opts.started === false ? null : new Date(),
    completedAt: new Date(),
    nodeOutput: {
      status: 'cancelled',
      outputs: {},
      artifacts: [],
      durationMs: 0,
      error: opts.marked === false ? undefined : { message: RESTART_INTERRUPTION_REASON },
    },
  });
  await setFlowRunStatus(db, run.id, 'cancelled');
  const taskId = `task-${runCount}`;
  await db.insert(tasks).values({
    id: taskId,
    description: taskId,
    source: 'flow',
    status: 'cancelled',
    result: { error: RESTART_INTERRUPTION_REASON },
    flowRunId: run.id,
    sourceId: nodeRun.id,
    nodeRunId: nodeRun.id,
  });
  return { taskId, nodeRunId: nodeRun.id, flowRunId: run.id };
}

const recoverOne = vi.fn<RecoverOne>(async () => 'queued');
const hasQueuedResume = vi.fn(async (_flowRunId: string) => false);
const deps = { recoverOne, hasQueuedResume };

beforeEach(() => {
  recoverOne.mockReset();
  recoverOne.mockResolvedValue('queued');
  hasQueuedResume.mockReset();
  hasQueuedResume.mockResolvedValue(false);
});

describe('recoverInterruptedRuns', () => {
  it('recovers each agent step through its own recovery, in the order given', async () => {
    const first = await seedStoppedRun();
    const second = await seedStoppedRun();
    recoverOne.mockResolvedValueOnce('resumed');

    const results = await recoverInterruptedRuns(
      db,
      [
        { taskId: second.taskId, kind: 'retry' },
        { taskId: first.taskId, kind: 'retry', recoveryNodeRunId: first.nodeRunId },
      ],
      deps,
    );

    expect(recoverOne.mock.calls).toEqual([
      [second.taskId, 'retry', second.nodeRunId],
      [first.taskId, 'retry', first.nodeRunId],
    ]);
    expect(results.map((r) => [r.taskId, r.outcome])).toEqual([
      [second.taskId, 'resumed'],
      [first.taskId, 'queued'],
    ]);
  });

  it('never re-runs a started non-agent step: it is listed for its own confirm', async () => {
    const agent = await seedStoppedRun();
    const command = await seedStoppedRun({ blockType: 'run_command' });

    const results = await recoverInterruptedRuns(
      db,
      [
        { taskId: command.taskId, kind: 'retry' },
        { taskId: agent.taskId, kind: 'retry' },
      ],
      deps,
    );

    expect(results[0]).toMatchObject({ taskId: command.taskId, outcome: 'needs-confirmation' });
    expect(results[1]).toMatchObject({ taskId: agent.taskId, outcome: 'queued' });
    expect(recoverOne).toHaveBeenCalledTimes(1);
    expect(recoverOne).toHaveBeenCalledWith(agent.taskId, 'retry', agent.nodeRunId);
  });

  // Startup queues its own resume (no recovery kind) for some interrupted runs; a click's ticket
  // carries one, so the enqueue would refuse it as a different live admission.
  it('reports a run whose resume is already queued as already queued, without enqueueing again', async () => {
    const queued = await seedStoppedRun();
    const fresh = await seedStoppedRun();
    hasQueuedResume.mockImplementation(async (flowRunId) => flowRunId === queued.flowRunId);

    const results = await recoverInterruptedRuns(
      db,
      [
        { taskId: queued.taskId, kind: 'retry' },
        { taskId: fresh.taskId, kind: 'retry' },
      ],
      deps,
    );

    expect(results.map((r) => r.outcome)).toEqual(['already-queued', 'queued']);
    expect(recoverOne).toHaveBeenCalledTimes(1);
    expect(recoverOne).toHaveBeenCalledWith(fresh.taskId, 'retry', fresh.nodeRunId);
  });

  it('retries a non-agent step that never started without asking', async () => {
    const command = await seedStoppedRun({ blockType: 'run_command', started: false });

    const [result] = await recoverInterruptedRuns(
      db,
      [{ taskId: command.taskId, kind: 'retry' }],
      deps,
    );

    expect(result).toMatchObject({ outcome: 'queued' });
  });

  it('refuses a run that is no longer interrupted, or whose step changed, and keeps going', async () => {
    const stopped = await seedStoppedRun({ marked: false });
    const stale = await seedStoppedRun();
    const moved = await seedStoppedRun();
    const ok = await seedStoppedRun();

    const results = await recoverInterruptedRuns(
      db,
      [
        { taskId: stopped.taskId, kind: 'retry' },
        { taskId: stale.taskId, kind: 'continue' },
        { taskId: moved.taskId, kind: 'retry', recoveryNodeRunId: 'an-older-attempt' },
        { taskId: 'gone', kind: 'retry' },
        { taskId: ok.taskId, kind: 'retry' },
      ],
      deps,
    );

    expect(results.map((r) => [r.outcome, r.reason])).toEqual([
      ['refused', 'No longer interrupted'],
      ['refused', 'This step changed — refresh and try again'],
      ['refused', 'This step changed — refresh and try again'],
      ['refused', 'Task not found'],
      ['queued', undefined],
    ]);
    expect(recoverOne).toHaveBeenCalledTimes(1);
  });

  it("reports one run's refused recovery with its reason without costing the others theirs", async () => {
    const deleted = await seedStoppedRun();
    const ok = await seedStoppedRun();
    recoverOne.mockRejectedValueOnce(new Error("This run's chat was deleted"));
    recoverOne.mockResolvedValueOnce('already-queued');

    const results = await recoverInterruptedRuns(
      db,
      [
        { taskId: deleted.taskId, kind: 'retry' },
        { taskId: ok.taskId, kind: 'retry' },
      ],
      deps,
    );

    expect(results).toEqual([
      expect.objectContaining({ outcome: 'refused', reason: "This run's chat was deleted" }),
      expect.objectContaining({ outcome: 'already-queued' }),
    ]);
  });
});
