import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { flowRunAdmissions, flowRuns, flows, flowVersions, nodeRuns } from '../../db/schema';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import { FlowAdmissionController } from './controller';
import { FLOW_ADMISSION_QUEUE_ORDER_BY } from './queue-order';
import { enqueueFlowAdmission } from './store';
import {
  flowRunAdmissionSnapshotsForRuns,
  queuedFlowAdmissions,
  queuedRunsForFlows,
} from './visibility';

const GRAPH = { nodes: [], edges: [], settings: {} };
const CONFIG = {
  version: 1 as const,
  queuePaused: false,
  concurrencyLimitEnabled: true,
  maxConcurrentRuns: 10,
};

function seedRun(db: TestDb, id: string, status: 'pending' | 'failed' = 'pending'): void {
  db.insert(flows)
    .values({ id: `flow-${id}`, name: `Flow ${id}` })
    .run();
  db.insert(flowVersions)
    .values({ id: `version-${id}`, flowId: `flow-${id}`, versionNumber: 1, graph: GRAPH })
    .run();
  db.insert(flowRuns)
    .values({ id, flowVersionId: `version-${id}`, status })
    .run();
}

function controller(db: TestDb, maxConcurrentRuns = 10): FlowAdmissionController {
  return new FlowAdmissionController(db, async () => ({ ...CONFIG, maxConcurrentRuns }));
}

async function enqueueStart(
  admissions: FlowAdmissionController,
  flowRunId: string,
  runFirst?: boolean,
) {
  return admissions.enqueue({
    intent: { version: 1, action: 'start', flow_run_id: flowRunId },
    runFirst,
  });
}

function seedResumableRun(db: TestDb, id: string): void {
  seedRun(db, id, 'failed');
  db.insert(nodeRuns)
    .values({
      id: `${id}-node`,
      flowRunId: id,
      nodeId: 'agent',
      blockType: 'agent',
      status: 'awaiting_input',
    })
    .run();
}

function enqueueResume(admissions: FlowAdmissionController, flowRunId: string) {
  return admissions.enqueue({
    intent: {
      version: 1,
      action: 'resume',
      flow_run_id: flowRunId,
      node_run_id: `${flowRunId}-node`,
    },
  });
}

function queryPlan(db: TestDb, query: { toSQL(): { sql: string; params: unknown[] } }): string {
  const { sql, params } = query.toSQL();
  // SAFETY: node:sqlite binds plain values, which is all drizzle emits for these queries.
  return JSON.stringify(
    db.$client.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])),
  );
}

function orderedRunIds(db: TestDb): string[] {
  return db
    .select({ flowRunId: flowRunAdmissions.flowRunId })
    .from(flowRunAdmissions)
    .where(eq(flowRunAdmissions.state, 'queued'))
    .orderBy(...FLOW_ADMISSION_QUEUE_ORDER_BY)
    .all()
    .map((row) => row.flowRunId);
}

describe('Flow admission queue order', () => {
  it('keeps migrated NULL rows FIFO, persists a move, and drives claims and visibility', async () => {
    const db = freshDb();
    for (const id of ['run-1', 'run-2', 'run-3']) seedRun(db, id);
    const admissions = controller(db);
    const [first, second, third] = await Promise.all(
      ['run-1', 'run-2', 'run-3'].map((id) => enqueueStart(admissions, id)),
    );

    expect(orderedRunIds(db)).toEqual(['run-1', 'run-2', 'run-3']);
    expect(
      db
        .select()
        .from(flowRunAdmissions)
        .all()
        .every((row) => row.queueOrder === null),
    ).toBe(true);
    await expect(
      admissions.moveQueued(first.admission.ticket, third.admission.ticket),
    ).resolves.toEqual({ status: 'moved' });
    expect(orderedRunIds(db)).toEqual(['run-2', 'run-3', 'run-1']);
    db.update(flowRuns)
      .set({ triggerContext: { label: '#7 batch item' } })
      .where(eq(flowRuns.id, 'run-3'))
      .run();
    expect(queuedFlowAdmissions(db).map((row) => row.triggerContext)).toEqual([
      null,
      { label: '#7 batch item' },
      null,
    ]);
    expect(queuedFlowAdmissions(db).map((row) => row.flowName)).toEqual([
      'Flow run-2',
      'Flow run-3',
      'Flow run-1',
    ]);
    const snapshots = flowRunAdmissionSnapshotsForRuns(db, ['run-1', 'run-2', 'run-3']);
    expect([
      snapshots.get('run-2')?.admission?.queuePosition,
      snapshots.get('run-3')?.admission?.queuePosition,
      snapshots.get('run-1')?.admission?.queuePosition,
    ]).toEqual([1, 2, 3]);

    const restarted = controller(db);
    await expect(restarted.claimEligible()).resolves.toMatchObject({
      admissions: [
        { ticket: second.admission.ticket },
        { ticket: third.admission.ticket },
        { ticket: first.admission.ticket },
      ],
    });
  });

  it('moves a ticket within the class and leaves the rest in order', async () => {
    const db = freshDb();
    for (const id of ['run-a', 'run-b', 'run-c', 'run-d']) seedRun(db, id);
    const admissions = controller(db);
    const a = await enqueueStart(admissions, 'run-a');
    await enqueueStart(admissions, 'run-b');
    const c = await enqueueStart(admissions, 'run-c');
    await enqueueStart(admissions, 'run-d');

    await expect(admissions.moveQueued(a.admission.ticket, c.admission.ticket)).resolves.toEqual({
      status: 'moved',
    });
    expect(orderedRunIds(db)).toEqual(['run-b', 'run-c', 'run-a', 'run-d']);
    expect(queuedFlowAdmissions(db).map((row) => row.flowName)).toEqual([
      'Flow run-b',
      'Flow run-c',
      'Flow run-a',
      'Flow run-d',
    ]);
    await expect(
      admissions.moveQueued(a.admission.ticket + 1000, c.admission.ticket),
    ).resolves.toEqual({ status: 'stale' });
    await expect(admissions.moveQueued(a.admission.ticket, a.admission.ticket)).resolves.toEqual({
      status: 'unchanged',
    });

    seedRun(db, 'run-new');
    await enqueueStart(admissions, 'run-new');
    expect(orderedRunIds(db)).toEqual(['run-b', 'run-c', 'run-a', 'run-d', 'run-new']);
  });

  it('rejects cross-class moves and preserves resume precedence', async () => {
    const db = freshDb();
    seedRun(db, 'start');
    seedResumableRun(db, 'resume');
    const admissions = controller(db, 1);
    const start = await enqueueStart(admissions, 'start');
    const resume = await enqueueResume(admissions, 'resume');

    await expect(
      admissions.moveQueued(start.admission.ticket, resume.admission.ticket),
    ).resolves.toEqual({ status: 'priority_mismatch' });
    await expect(admissions.claimEligible()).resolves.toMatchObject({
      admissions: [{ ticket: resume.admission.ticket }],
    });
    await expect(
      admissions.moveQueued(resume.admission.ticket, resume.admission.ticket),
    ).resolves.toEqual({ status: 'stale' });
  });

  it('claims resumes, then run-first starts, then other starts, each in arrival order', async () => {
    const db = freshDb();
    for (const id of ['normal-1', 'first-2', 'normal-4', 'first-5']) seedRun(db, id);
    seedResumableRun(db, 'resume-3');
    const admissions = controller(db);
    await enqueueStart(admissions, 'normal-1');
    await enqueueStart(admissions, 'first-2', true);
    await enqueueResume(admissions, 'resume-3');
    await enqueueStart(admissions, 'normal-4');
    await enqueueStart(admissions, 'first-5', true);

    const expected = ['resume-3', 'first-2', 'first-5', 'normal-1', 'normal-4'];
    expect(orderedRunIds(db)).toEqual(expected);
    expect(queuedFlowAdmissions(db).map((row) => [row.flowName, row.runFirst])).toEqual(
      expected.map((id) => [`Flow ${id}`, id.startsWith('first')]),
    );
    const claimed = await admissions.claimEligible();
    expect(claimed.admissions.map((row) => row.flowRunId)).toEqual(expected);
  });

  it('starts a run-first row ahead of a backlog longer than one claim window', async () => {
    const db = freshDb();
    const admissions = controller(db, 1);
    for (let index = 0; index < 101; index++) {
      seedRun(db, `backlog-${index}`);
      await enqueueStart(admissions, `backlog-${index}`);
    }
    seedRun(db, 'urgent');
    await enqueueStart(admissions, 'urgent', true);

    await expect(admissions.claimEligible()).resolves.toMatchObject({
      admissions: [{ flowRunId: 'urgent' }],
    });
  });

  it('reorders only inside a lane and refuses a move across lanes', async () => {
    const db = freshDb();
    for (const id of ['normal-a', 'first-b', 'first-c', 'normal-d']) seedRun(db, id);
    const admissions = controller(db);
    const normalA = await enqueueStart(admissions, 'normal-a');
    const firstB = await enqueueStart(admissions, 'first-b', true);
    const firstC = await enqueueStart(admissions, 'first-c', true);
    const normalD = await enqueueStart(admissions, 'normal-d');

    await expect(
      admissions.moveQueued(firstC.admission.ticket, firstB.admission.ticket),
    ).resolves.toEqual({ status: 'moved' });
    expect(orderedRunIds(db)).toEqual(['first-c', 'first-b', 'normal-a', 'normal-d']);
    const normalOrder = db
      .select({ queueOrder: flowRunAdmissions.queueOrder })
      .from(flowRunAdmissions)
      .where(eq(flowRunAdmissions.runFirst, false))
      .all();
    expect(normalOrder).toEqual([{ queueOrder: null }, { queueOrder: null }]);

    for (const [ticket, target] of [
      [normalD.admission.ticket, firstB.admission.ticket],
      [firstB.admission.ticket, normalA.admission.ticket],
    ]) {
      await expect(admissions.moveQueued(ticket, target)).resolves.toEqual({
        status: 'priority_mismatch',
      });
    }
    expect(orderedRunIds(db)).toEqual(['first-c', 'first-b', 'normal-a', 'normal-d']);
  });

  it('never stores a resume as run-first', () => {
    const db = freshDb();
    seedResumableRun(db, 'resume');

    expect(() =>
      enqueueFlowAdmission(db, {
        intent: { version: 1, action: 'resume', flow_run_id: 'resume', node_run_id: 'resume-node' },
        runFirst: true,
      }),
    ).toThrow(/flow_run_admissions_run_first_check|CHECK constraint/);
    expect(db.select().from(flowRunAdmissions).all()).toEqual([]);
  });

  it('serves every queued read from the partial queue index', () => {
    const db = freshDb();
    // SAFETY: sqlite_master.sql is text for a named index row and absent only when it is missing.
    const schemaRow = db.$client
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'flow_run_admissions_queue_idx'",
      )
      .get() as { sql: string } | undefined;
    const claimOrder = db
      .select({ ticket: flowRunAdmissions.ticket })
      .from(flowRunAdmissions)
      .where(eq(flowRunAdmissions.state, 'queued'))
      .orderBy(...FLOW_ADMISSION_QUEUE_ORDER_BY);

    expect(schemaRow?.sql).toContain("(`priority_class` = 'resume') DESC, `run_first` DESC");
    const claimPlan = queryPlan(db, claimOrder);
    expect(claimPlan).toContain('flow_run_admissions_queue_idx');
    expect(claimPlan).not.toContain('TEMP B-TREE');
  });

  it('still finds only queued resumes for the per-flow lookup', async () => {
    const db = freshDb();
    seedRun(db, 'start');
    seedResumableRun(db, 'resume');
    const admissions = controller(db);
    await enqueueStart(admissions, 'start', true);
    await enqueueResume(admissions, 'resume');

    expect([...queuedRunsForFlows(db, ['flow-start', 'flow-resume']).keys()]).toEqual([
      'flow-resume',
    ]);
  });
});
