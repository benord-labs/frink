import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real in-memory SQLite + mocked startFlowRun (same harness as ../batch-dispatch.test.ts): the unit
// under test is dependency-branch inheritance from completed start_task outputs into successor runs.

const { mocks } = vi.hoisted(() => ({
  mocks: { startFlowRun: vi.fn(), getDatabase: vi.fn() },
}));

vi.mock('../../db', () => ({ getDatabase: mocks.getDatabase }));
vi.mock('../start', () => ({ startFlowRun: mocks.startFlowRun }));

import { listRunsForStage } from '../../db/repos/batch-stage-runs';
import { getBatchStage, setStageStatusIf } from '../../db/repos/batch-stages';
import { createNodeRun } from '../../db/repos/node-runs';
import { batchStageRuns, flowRuns } from '../../db/schema';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import { mergeDependencyBranches } from './dependency-branches';
import { onBatchRunTerminal, recoverBatchStages, startFlowBatchLocal } from '../batch-dispatch';
import {
  makeStartFlowRunMock,
  runId,
  seedBatchFlow,
  seedBatchStage,
} from '../batch-test-factories';

let db: TestDb;
let flowId: string;
let versionId: string;
const BATCH = 'batch-1';

const seedStage = (input: Parameters<typeof seedBatchStage>[2]) => seedBatchStage(db, BATCH, input);

type StartTaskSeed = {
  branch: string | null; // null = no start_task node_run at all
  status?: string;
  attemptNumber?: number;
  laneIndex?: number;
  completedAt?: Date;
};

/** Persist what the engine would for a finished run: start_task node_run(s), run row, terminal event. */
async function finishRun(
  flowRunId: string,
  status: 'completed' | 'failed' | 'cancelled',
  completedAt: Date,
  startTasks: StartTaskSeed[] = [],
) {
  for (const st of startTasks) {
    if (st.branch === null) continue;
    await createNodeRun(db, {
      flowRunId,
      nodeId: 'st',
      blockType: 'start_task',
      status: st.status ?? 'completed',
      attemptNumber: st.attemptNumber ?? 1,
      laneIndex: st.laneIndex ?? null,
      parentFanOutNodeRunId: st.laneIndex === undefined ? null : 'fan-out-1',
      nodeOutput: { status: 'completed', outputs: { branch: st.branch }, artifacts: [] },
      completedAt: st.completedAt ?? completedAt,
    });
  }
  await db.update(flowRuns).set({ status, completedAt }).where(eq(flowRuns.id, flowRunId));
  await onBatchRunTerminal(flowRunId);
}

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));

/** Trigger context the successor's Nth startFlowRun call received. */
function dispatchedContext(stageRunId: string): Record<string, unknown> | null {
  const call = mocks.startFlowRun.mock.calls.find(
    ([input]) => input.batchStageRunId === stageRunId,
  );
  if (!call) throw new Error(`no dispatch for ${stageRunId}`);
  return call[0].triggerContext as Record<string, unknown> | null;
}

beforeEach(async () => {
  vi.clearAllMocks();
  db = freshDb();
  mocks.getDatabase.mockReturnValue(db);
  mocks.startFlowRun.mockImplementation(makeStartFlowRunMock(db, () => versionId));
  ({ flowId, versionId } = await seedBatchFlow(db));
});

describe('dependency branch inheritance at dispatch', () => {
  it('linear 1 → 2: the successor forks from the dependency branch', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 1 });
    const next = await seedStage({ stageNumber: 2, runCount: 1, dependsOnStageIds: [root.id] });
    await startFlowBatchLocal(flowId, BATCH);

    const [rootRun] = await listRunsForStage(db, root.id);
    await finishRun(runId(rootRun), 'completed', at(10), [{ branch: 'feat/root' }]);

    const [nextRun] = await listRunsForStage(db, next.id);
    expect(dispatchedContext(nextRun.id)).toEqual({
      label: 'run-0',
      baseBranch: 'feat/root',
      baseBranches: ['feat/root'],
    });
  });

  it('leaves root runs untouched', async () => {
    const root = await seedStage({
      stageNumber: 1,
      runCount: 1,
      triggerContext: { baseBranch: 'main' },
    });
    await startFlowBatchLocal(flowId, BATCH);

    const [rootRun] = await listRunsForStage(db, root.id);
    expect(dispatchedContext(rootRun.id)).toEqual({ baseBranch: 'main' });
  });

  it('fan-in: orders branches most-recently-completed first and sets mergeStrategy', async () => {
    const a = await seedStage({ stageNumber: 1, runCount: 1 });
    const b = await seedStage({ stageNumber: 2, runCount: 1 });
    const join = await seedStage({
      stageNumber: 3,
      runCount: 1,
      dependsOnStageIds: [a.id, b.id],
    });
    await startFlowBatchLocal(flowId, BATCH);

    // B's event arrives first but A completed later: completion time, not event order, wins.
    const [runB] = await listRunsForStage(db, b.id);
    await finishRun(runId(runB), 'completed', at(5), [{ branch: 'feat/b' }]);
    const [runA] = await listRunsForStage(db, a.id);
    await finishRun(runId(runA), 'completed', at(20), [{ branch: 'feat/a' }]);

    const [joinRun] = await listRunsForStage(db, join.id);
    expect(dispatchedContext(joinRun.id)).toMatchObject({
      baseBranch: 'feat/a',
      baseBranches: ['feat/a', 'feat/b'],
      mergeStrategy: 'most-recent',
    });
  });

  it.each([
    ['a then b', ['a', 'b'], ['feat/b', 'feat/a']],
    ['b then a', ['b', 'a'], ['feat/a', 'feat/b']],
  ])(
    'fan-in within the same second: the later finisher leads (%s)',
    async (_l, order, expected) => {
      const a = await seedStage({ stageNumber: 1, runCount: 1 });
      const b = await seedStage({ stageNumber: 2, runCount: 1 });
      const join = await seedStage({
        stageNumber: 3,
        runCount: 1,
        dependsOnStageIds: [a.id, b.id],
      });
      await startFlowBatchLocal(flowId, BATCH);
      const stages = { a, b };

      for (const key of order as ('a' | 'b')[]) {
        const [run] = await listRunsForStage(db, stages[key].id);
        await finishRun(runId(run), 'completed', at(7), [{ branch: `feat/${key}` }]);
      }

      const [joinRun] = await listRunsForStage(db, join.id);
      expect(dispatchedContext(joinRun.id)).toMatchObject({ baseBranches: expected });
    },
  );

  it('collects every completed member of a multi-run dependency and dedupes shared branches', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 3 });
    const next = await seedStage({ stageNumber: 2, runCount: 1, dependsOnStageIds: [root.id] });
    await startFlowBatchLocal(flowId, BATCH);

    const [r1, r2, r3] = await listRunsForStage(db, root.id);
    await finishRun(runId(r1), 'completed', at(1), [{ branch: 'feat/shared' }]);
    await finishRun(runId(r2), 'completed', at(2), [{ branch: 'feat/other' }]);
    await finishRun(runId(r3), 'completed', at(3), [{ branch: 'feat/shared' }]);

    const [nextRun] = await listRunsForStage(db, next.id);
    expect(dispatchedContext(nextRun.id)).toMatchObject({
      baseBranches: ['feat/shared', 'feat/other'],
      mergeStrategy: 'most-recent',
    });
  });

  it('excludes failed members of a never-blocking (-1) dependency', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 2, failureThreshold: -1 });
    const next = await seedStage({ stageNumber: 2, runCount: 1, dependsOnStageIds: [root.id] });
    await startFlowBatchLocal(flowId, BATCH);

    const [ok, bad] = await listRunsForStage(db, root.id);
    await finishRun(runId(ok), 'completed', at(1), [{ branch: 'feat/ok' }]);
    await finishRun(runId(bad), 'failed', at(2), [{ branch: 'feat/broken' }]);

    const [nextRun] = await listRunsForStage(db, next.id);
    expect(dispatchedContext(nextRun.id)).toMatchObject({ baseBranches: ['feat/ok'] });
  });

  it.each([
    ['ran without a worktree (branch "")', [{ branch: '' }]],
    ['has no start_task at all', [{ branch: null }]],
    ['parked its start_task (not completed)', [{ branch: 'feat/x', status: 'awaiting_input' }]],
  ])('leaves the successor context unchanged when the dependency %s', async (_l, startTasks) => {
    const root = await seedStage({ stageNumber: 1, runCount: 1 });
    const next = await seedStage({ stageNumber: 2, runCount: 1, dependsOnStageIds: [root.id] });
    await startFlowBatchLocal(flowId, BATCH);

    const [rootRun] = await listRunsForStage(db, root.id);
    await finishRun(runId(rootRun), 'completed', at(1), startTasks as StartTaskSeed[]);

    const [nextRun] = await listRunsForStage(db, next.id);
    expect(dispatchedContext(nextRun.id)).toEqual({ label: 'run-0' });
  });

  it('takes the retried start_task attempt, not the superseded one', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 1 });
    const next = await seedStage({ stageNumber: 2, runCount: 1, dependsOnStageIds: [root.id] });
    await startFlowBatchLocal(flowId, BATCH);

    const [rootRun] = await listRunsForStage(db, root.id);
    // Same second (completed_at is second-precision): attempt_number breaks the tie.
    await finishRun(runId(rootRun), 'completed', at(4), [
      { branch: 'feat/attempt-1', attemptNumber: 1, completedAt: at(4) },
      { branch: 'feat/attempt-2', attemptNumber: 2, completedAt: at(4) },
    ]);

    const [nextRun] = await listRunsForStage(db, next.id);
    expect(dispatchedContext(nextRun.id)).toMatchObject({ baseBranches: ['feat/attempt-2'] });
  });

  it('ignores fan-out lane start_tasks and reads the top-level one', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 1 });
    const next = await seedStage({ stageNumber: 2, runCount: 1, dependsOnStageIds: [root.id] });
    await startFlowBatchLocal(flowId, BATCH);

    const [rootRun] = await listRunsForStage(db, root.id);
    await finishRun(runId(rootRun), 'completed', at(9), [
      { branch: 'feat/top', completedAt: at(1) },
      { branch: 'feat/lane-0', laneIndex: 0, completedAt: at(8) },
    ]);

    const [nextRun] = await listRunsForStage(db, next.id);
    expect(dispatchedContext(nextRun.id)).toMatchObject({ baseBranches: ['feat/top'] });
  });

  it('overwrites a planner-pinned baseBranch: a dependent stage always forks off its deps', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 1 });
    const next = await seedStage({
      stageNumber: 2,
      runCount: 1,
      dependsOnStageIds: [root.id],
      triggerContext: { baseBranch: 'epic-943/slot-1' },
    });
    await startFlowBatchLocal(flowId, BATCH);

    const [rootRun] = await listRunsForStage(db, root.id);
    await finishRun(runId(rootRun), 'completed', at(1), [{ branch: 'feat/root' }]);

    const [nextRun] = await listRunsForStage(db, next.id);
    expect(dispatchedContext(nextRun.id)).toEqual({
      baseBranch: 'feat/root',
      baseBranches: ['feat/root'],
    });
  });

  it('inherits only from direct dependencies, not transitive ancestors', async () => {
    const s1 = await seedStage({ stageNumber: 1, runCount: 1 });
    const s2 = await seedStage({ stageNumber: 2, runCount: 1, dependsOnStageIds: [s1.id] });
    const s3 = await seedStage({ stageNumber: 3, runCount: 1, dependsOnStageIds: [s2.id] });
    await startFlowBatchLocal(flowId, BATCH);

    const [run1] = await listRunsForStage(db, s1.id);
    await finishRun(runId(run1), 'completed', at(1), [{ branch: 'feat/s1' }]);
    const [run2] = await listRunsForStage(db, s2.id);
    await finishRun(runId(run2), 'completed', at(2), [{ branch: 'feat/s2' }]);

    const [run3] = await listRunsForStage(db, s3.id);
    expect(dispatchedContext(run3.id)).toMatchObject({
      baseBranch: 'feat/s2',
      baseBranches: ['feat/s2'],
    });
  });

  it('injects into members dispatched later by slot-fill, not just the first wave', async () => {
    ({ flowId, versionId } = await seedBatchFlow(db, { maxBatchConcurrency: 1 }));
    const root = await seedStage({ stageNumber: 1, runCount: 1 });
    const next = await seedStage({ stageNumber: 2, runCount: 2, dependsOnStageIds: [root.id] });
    await startFlowBatchLocal(flowId, BATCH);

    const [rootRun] = await listRunsForStage(db, root.id);
    await finishRun(runId(rootRun), 'completed', at(1), [{ branch: 'feat/root' }]);

    const [first, second] = await listRunsForStage(db, next.id);
    expect(second.status).toBe('pending'); // concurrency 1 held it back
    await finishRun(runId(first), 'completed', at(2), [{ branch: 'feat/next-0' }]);

    expect(dispatchedContext(second.id)).toMatchObject({ baseBranches: ['feat/root'] });
  });

  it('passes injected keys through a declared batchTriggerSchema', async () => {
    ({ flowId, versionId } = await seedBatchFlow(db, {
      batchTriggerSchema: [{ key: 'baseBranch', type: 'string' }],
    }));
    const root = await seedStage({ stageNumber: 1, runCount: 1 });
    const next = await seedStage({ stageNumber: 2, runCount: 1, dependsOnStageIds: [root.id] });
    await startFlowBatchLocal(flowId, BATCH);

    const [rootRun] = await listRunsForStage(db, root.id);
    await finishRun(runId(rootRun), 'completed', at(1), [{ branch: 'feat/root' }]);

    const [nextRun] = await listRunsForStage(db, next.id);
    expect(nextRun.status).toBe('dispatched');
    expect(dispatchedContext(nextRun.id)).toMatchObject({ baseBranch: 'feat/root' });
  });

  it('restart recovery re-dispatches a pending successor with inherited branches', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 1 });
    const next = await seedStage({ stageNumber: 2, runCount: 1, dependsOnStageIds: [root.id] });
    await startFlowBatchLocal(flowId, BATCH);
    const [rootRun] = await listRunsForStage(db, root.id);

    // Crash between promotion and dispatch: successor running, its BSR still pending.
    mocks.startFlowRun.mockRejectedValueOnce(new Error('crash'));
    await finishRun(runId(rootRun), 'completed', at(1), [{ branch: 'feat/root' }]);
    const [nextRun] = await listRunsForStage(db, next.id);
    await db
      .update(batchStageRuns)
      .set({ status: 'pending' })
      .where(eq(batchStageRuns.id, nextRun.id));
    await setStageStatusIf(db, next.id, 'failed', 'running');
    mocks.startFlowRun.mockClear();

    await recoverBatchStages();

    expect((await getBatchStage(db, next.id))?.status).toBe('running');
    expect(dispatchedContext(nextRun.id)).toMatchObject({ baseBranches: ['feat/root'] });
  });
});

describe('mergeDependencyBranches', () => {
  it('returns the context unchanged (same reference) when no branches resolved', () => {
    const ctx = { label: 'x' };
    expect(mergeDependencyBranches(ctx, [])).toBe(ctx);
    expect(mergeDependencyBranches(null, [])).toBeNull();
  });

  it('builds a context from null when branches resolved', () => {
    expect(mergeDependencyBranches(null, ['a'])).toEqual({ baseBranch: 'a', baseBranches: ['a'] });
  });

  it.each([
    ['pinned baseBranches without baseBranch', { baseBranches: ['pinned-1', 'pinned-2'] }],
    ['malformed baseBranches', { baseBranches: [42, '  '] }],
    ['blank baseBranch', { baseBranch: '   ' }],
    ['non-string baseBranch', { baseBranch: 42 }],
  ])('overwrites %s with the resolved dependency branches', (_l, ctx) => {
    expect(mergeDependencyBranches(ctx, ['dep'])).toEqual({
      baseBranch: 'dep',
      baseBranches: ['dep'],
    });
  });

  it('keeps unrelated keys and drops a stale mergeStrategy for a single branch', () => {
    expect(mergeDependencyBranches({ label: 'x', mergeStrategy: 'most-recent' }, ['only'])).toEqual(
      { label: 'x', baseBranch: 'only', baseBranches: ['only'] },
    );
  });
});
