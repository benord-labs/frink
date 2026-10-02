import { eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { batchStageRuns, batchStages } from '../schema';
import { freshDb, type TestDb } from '../test-utils/fresh-db';
import { insertBatchStagesWithRuns } from './batch-stages';

const BATCH = 'batch-define';

let db: TestDb;

function stagesInBatch() {
  return db.select().from(batchStages).where(eq(batchStages.batchId, BATCH)).all();
}

function runsInBatch() {
  const ids = stagesInBatch().map((s) => s.id);
  if (ids.length === 0) return db.select().from(batchStageRuns).all();
  return db.select().from(batchStageRuns).where(inArray(batchStageRuns.stageId, ids)).all();
}

beforeEach(() => {
  db = freshDb();
});

describe('insertBatchStagesWithRuns', () => {
  it('persists stages, resolved deps and runs', () => {
    const ids = insertBatchStagesWithRuns(db, BATCH, [
      { stageNumber: 1, name: 'one', runs: [{ triggerContext: { i: 1 } }, {}] },
      { stageNumber: 2, dependsOn: [1], runs: [{}] },
      { stageNumber: 3, dependsOn: [1, 2], failureThreshold: 2, runs: [{}] },
    ]);

    const byNumber = new Map(stagesInBatch().map((s) => [s.stageNumber, s]));
    expect(byNumber.size).toBe(3);
    expect(byNumber.get(1)).toMatchObject({
      name: 'one',
      status: 'pending',
      dependsOnStageIds: [],
    });
    expect(byNumber.get(2)?.dependsOnStageIds).toEqual([ids.get(1)]);
    expect(byNumber.get(3)).toMatchObject({
      failureThreshold: 2,
      dependsOnStageIds: [ids.get(1), ids.get(2)],
    });

    const runs = runsInBatch();
    expect(runs.filter((r) => r.stageId === ids.get(1))).toHaveLength(2);
    expect(runs.filter((r) => r.stageId === ids.get(2))).toHaveLength(1);
    expect(runs.find((r) => r.triggerContext !== null)?.triggerContext).toEqual({ i: 1 });
    expect(runs.every((r) => r.status === 'pending')).toBe(true);
  });

  it('rolls back every write when a stageNumber repeats within the call', () => {
    expect(() =>
      insertBatchStagesWithRuns(db, BATCH, [
        { stageNumber: 1, runs: [{}] },
        { stageNumber: 2, runs: [{}] },
        { stageNumber: 2, runs: [{}] },
      ]),
    ).toThrow('Stage(s) 2 defined more than once in this call');

    expect(stagesInBatch()).toHaveLength(0);
    expect(runsInBatch()).toHaveLength(0);
  });

  it('rejects a stageNumber from an earlier call and leaves that call untouched', () => {
    const first = insertBatchStagesWithRuns(db, BATCH, [{ stageNumber: 1, runs: [{}, {}] }]);

    expect(() =>
      insertBatchStagesWithRuns(db, BATCH, [
        { stageNumber: 2, runs: [{}] },
        { stageNumber: 1, runs: [{}] },
      ]),
    ).toThrow(/Stage\(s\) 1 already exist for batch batch-define; use frink_flows_add_stage_runs/);

    const stages = stagesInBatch();
    expect(stages.map((s) => s.stageNumber)).toEqual([1]);
    expect(stages[0].id).toBe(first.get(1));
    expect(runsInBatch()).toHaveLength(2);
  });

  it('rolls back a failure after stage rows are written so a corrected retry succeeds', () => {
    // A BigInt cannot be JSON-serialised, so stage 2's run insert throws after every stage row exists.
    expect(() =>
      insertBatchStagesWithRuns(db, BATCH, [
        { stageNumber: 1, runs: [{}] },
        { stageNumber: 2, dependsOn: [1], runs: [{ triggerContext: { n: BigInt(1) } }] },
      ]),
    ).toThrow();
    expect(stagesInBatch()).toHaveLength(0);
    expect(runsInBatch()).toHaveLength(0);

    insertBatchStagesWithRuns(db, BATCH, [
      { stageNumber: 1, runs: [{}] },
      { stageNumber: 2, dependsOn: [1], runs: [{ triggerContext: { n: 1 } }] },
    ]);
    expect(stagesInBatch()).toHaveLength(2);
    expect(runsInBatch()).toHaveLength(2);
  });

  it('resolves dependsOn against stages defined by an earlier call', () => {
    const first = insertBatchStagesWithRuns(db, BATCH, [{ stageNumber: 1, runs: [{}] }]);
    const second = insertBatchStagesWithRuns(db, BATCH, [
      { stageNumber: 2, dependsOn: [1, 99], runs: [{}] },
    ]);

    const stage2 = stagesInBatch().find((s) => s.stageNumber === 2);
    expect(stage2?.dependsOnStageIds).toEqual([first.get(1)]);
    expect(second.get(1)).toBe(first.get(1));
  });

  it('scopes stage numbers to their batch', () => {
    insertBatchStagesWithRuns(db, 'other-batch', [{ stageNumber: 1, runs: [{}] }]);
    expect(() =>
      insertBatchStagesWithRuns(db, BATCH, [{ stageNumber: 1, runs: [{}] }]),
    ).not.toThrow();
  });
});
