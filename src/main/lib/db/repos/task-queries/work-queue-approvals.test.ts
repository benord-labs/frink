import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { flowRunAdmissions, nodeRuns } from '../../schema';
import { freshDb, type TestDb } from '../../test-utils/fresh-db';
import { getOrCreateFlowRunByIdempotencyKey, setFlowRunStatus } from '../flow-runs';
import { createFlowVersion } from '../flow-versions';
import { createFlow } from '../flows';
import { createProject } from '../projects';
import {
  createTask,
  getTaskCounts,
  listTasksWithProjectPaginated,
  updateTaskStatus,
} from '../tasks';
import { getWorkQueueOverviewCounts } from './work-queue-overview-counts';
import { listAwaitingApprovals } from './work-queue-overview-filter';

const PARKED_AT = new Date('2026-10-14T14:41:00.000Z');

const approvalGraph = (config: { message?: string }) => ({
  nodes: [{ id: 'gate', blockType: 'approval', config, position: { x: 0, y: 0 } }],
  edges: [],
});

type GateRunOptions = {
  flowName?: string;
  message?: string;
  parkedAt?: Date;
  runStatus?: 'paused' | 'running' | 'cancelled';
  gateStatus?: string;
  blockType?: string;
};

/** A Flow run in a project, parked at its Approval step. */
async function seedGateRun(db: TestDb, key: string, options: GateRunOptions = {}) {
  const project = await createProject(db, { name: 'frink-oss', path: `/tmp/${key}` });
  const flow = await createFlow(db, {
    name: options.flowName ?? 'Release train',
    projectId: project.id,
  });
  const config = options.message === undefined ? {} : { message: options.message };
  const version = await createFlowVersion(db, { flowId: flow.id, graph: approvalGraph(config) });
  const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
    flowVersionId: version.id,
    status: options.runStatus ?? 'paused',
    triggerContext: null,
    idempotencyKey: key,
    startedAt: new Date(),
  });
  const gate = addGate(db, run.id, `${key}-gate`, options);
  return { flowId: flow.id, flowRunId: run.id, gateId: gate };
}

function addGate(
  db: TestDb,
  flowRunId: string,
  id: string,
  options: Pick<GateRunOptions, 'parkedAt' | 'gateStatus' | 'blockType'> & { laneIndex?: number },
) {
  db.insert(nodeRuns)
    .values({
      id,
      flowRunId,
      nodeId: 'gate',
      blockType: options.blockType ?? 'approval',
      status: options.gateStatus ?? 'awaiting_input',
      laneIndex: options.laneIndex ?? null,
      completedAt: options.parkedAt ?? PARKED_AT,
    })
    .run();
  return id;
}

async function addFlowTask(
  db: TestDb,
  flowRunId: string,
  status: 'done' | 'running' | 'needs_attention',
) {
  const task = await createTask(db, { description: status, source: 'flow', flowRunId });
  await updateTaskStatus(db, task.id, status);
  return task;
}

const sectionIds = async (db: TestDb, section: 'attention' | 'running') =>
  (await listTasksWithProjectPaginated(db, { workQueueSection: section, limit: 50 })).items.map(
    (task) => task.id,
  );

describe('Work Queue approvals', () => {
  it('lists each waiting run with its Flow, project, own message and park time, longest wait first', async () => {
    const db = freshDb();
    const later = await seedGateRun(db, 'later', {
      flowName: 'Nightly deploy',
      message: '  Deploy the release branch to staging?  ',
      parkedAt: new Date('2026-10-14T15:00:00.000Z'),
    });
    const earlier = await seedGateRun(db, 'earlier', { message: '   ' });

    expect(listAwaitingApprovals(db)).toEqual([
      {
        flowRunId: earlier.flowRunId,
        flowId: earlier.flowId,
        flowName: 'Release train',
        projectName: 'frink-oss',
        gateCount: 1,
        nodeRunId: earlier.gateId,
        message: null,
        waitingSince: PARKED_AT,
      },
      {
        flowRunId: later.flowRunId,
        flowId: later.flowId,
        flowName: 'Nightly deploy',
        projectName: 'frink-oss',
        gateCount: 1,
        nodeRunId: later.gateId,
        message: 'Deploy the release branch to staging?',
        waitingSince: new Date('2026-10-14T15:00:00.000Z'),
      },
    ]);
  });

  it("reads the message from the run's own Flow version, not a later edit", async () => {
    const db = freshDb();
    const { flowId } = await seedGateRun(db, 'versioned', { message: 'Ship version one?' });
    await createFlowVersion(db, { flowId, graph: approvalGraph({ message: 'Ship version two?' }) });

    expect(listAwaitingApprovals(db).map((gate) => gate.message)).toEqual(['Ship version one?']);
  });

  it('shows a run with several waiting gates once, answered from the run', async () => {
    const db = freshDb();
    const { flowRunId } = await seedGateRun(db, 'fan-out', { message: 'Merge this lane?' });
    addGate(db, flowRunId, 'second-lane-gate', { laneIndex: 1 });

    expect(listAwaitingApprovals(db)).toEqual([
      expect.objectContaining({ flowRunId, gateCount: 2, nodeRunId: null, message: null }),
    ]);
  });

  it('leaves out gates nobody can answer right now', async () => {
    const db = freshDb();
    await seedGateRun(db, 'running-run', { runStatus: 'running' });
    await seedGateRun(db, 'cancelled-run', { runStatus: 'cancelled' });
    await seedGateRun(db, 'answered', { gateStatus: 'completed' });
    await seedGateRun(db, 'agent-park', { blockType: 'agent' });
    const queued = await seedGateRun(db, 'queued');
    db.insert(flowRunAdmissions)
      .values({
        flowRunId: queued.flowRunId,
        state: 'queued',
        priorityClass: 'resume',
        intentVersion: 1,
        intentJson: { version: 1, action: 'resume', flow_run_id: queued.flowRunId },
      })
      .run();
    const working = await seedGateRun(db, 'working');
    await addFlowTask(db, working.flowRunId, 'running');
    const asking = await seedGateRun(db, 'asking');
    await addFlowTask(db, asking.flowRunId, 'running');
    await addFlowTask(db, asking.flowRunId, 'needs_attention');

    expect(listAwaitingApprovals(db).map((gate) => gate.flowRunId)).toEqual([asking.flowRunId]);
  });

  it('takes a run waiting on its gate out of Running until the gate is answered', async () => {
    const db = freshDb();
    const { flowRunId, gateId } = await seedGateRun(db, 'after-agent');
    const earlierStep = await addFlowTask(db, flowRunId, 'done');

    expect(await sectionIds(db, 'running')).toEqual([]);
    expect(await getWorkQueueOverviewCounts(db)).toMatchObject({ running: 0, review: 0 });
    expect(await getTaskCounts(db, { collapseByFlow: true })).toMatchObject({ running: 0 });

    db.update(nodeRuns).set({ status: 'completed' }).where(eq(nodeRuns.id, gateId)).run();
    await setFlowRunStatus(db, flowRunId, 'running');

    expect(await sectionIds(db, 'running')).toEqual([earlierStep.id]);
    expect(await getWorkQueueOverviewCounts(db)).toMatchObject({ running: 1 });
    expect(await getTaskCounts(db, { collapseByFlow: true })).toMatchObject({ running: 1 });
  });

  it('keeps manual running tasks in Running', async () => {
    const db = freshDb();
    await seedGateRun(db, 'gate');
    const manual = await createTask(db, { description: 'manual', source: 'manual' });
    await updateTaskStatus(db, manual.id, 'running');

    expect(await sectionIds(db, 'running')).toEqual([manual.id]);
    expect(await getWorkQueueOverviewCounts(db)).toMatchObject({ running: 1 });
  });

  it("keeps a waiting run's own question in Attention beside its approval", async () => {
    const db = freshDb();
    const { flowRunId } = await seedGateRun(db, 'question');
    const question = await addFlowTask(db, flowRunId, 'needs_attention');

    expect(await sectionIds(db, 'attention')).toEqual([question.id]);
    expect(await sectionIds(db, 'running')).toEqual([]);
    expect(listAwaitingApprovals(db).map((gate) => gate.flowRunId)).toEqual([flowRunId]);
  });
});
