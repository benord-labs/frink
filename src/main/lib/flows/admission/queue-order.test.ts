import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { flowRunAdmissions, flowRuns, flows, flowVersions, nodeRuns } from '../../db/schema';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import { FlowAdmissionController } from './controller';
import { FLOW_ADMISSION_QUEUE_ORDER_BY } from './queue-order';
import { flowRunAdmissionSnapshotsForRuns, queuedFlowAdmissions } from './visibility';

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

async function enqueueStart(admissions: FlowAdmissionController, flowRunId: string) {
  return admissions.enqueue({ intent: { version: 1, action: 'start', flow_run_id: flowRunId } });
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
    seedRun(db, 'resume', 'failed');
    db.insert(nodeRuns)
      .values({
        id: 'resume-node',
        flowRunId: 'resume',
        nodeId: 'agent',
        blockType: 'agent',
        status: 'awaiting_input',
      })
      .run();
    const admissions = controller(db, 1);
    const start = await enqueueStart(admissions, 'start');
    const resume = await admissions.enqueue({
      intent: {
        version: 1,
        action: 'resume',
        flow_run_id: 'resume',
        node_run_id: 'resume-node',
      },
    });

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

  it('uses the partial expression index for the canonical queued order', () => {
    const db = freshDb();
    // SAFETY: sqlite_master.sql is text for a named index row and absent only when it is missing.
    const schemaRow = db.$client
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'flow_run_admissions_queue_idx'",
      )
      .get() as { sql: string } | undefined;
    const plan = db.$client
      .prepare(
        "EXPLAIN QUERY PLAN SELECT ticket FROM flow_run_admissions WHERE state = 'queued' ORDER BY priority_class, coalesce(queue_order, ticket), ticket",
      )
      .all();

    expect(schemaRow?.sql).toContain('coalesce(`queue_order`, `ticket`)');
    expect(JSON.stringify(plan)).toContain('flow_run_admissions_queue_idx');
  });
});
