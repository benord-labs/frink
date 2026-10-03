/** A finished batch group and two queued Flow admissions for the Work Queue panels. */
import * as schema from '../../../src/main/lib/db/schema';
import { FIXTURE_PROJECT_ID, T0, T1, T2, type SqliteDb } from './base';
import { FIXTURE_PAUSED_GRAPH, FIXTURE_QUEUED_FLOW_ID, FIXTURE_QUEUED_FLOW_VERSION_ID, FIXTURE_QUEUED_RESUME_RUN_ID, FIXTURE_QUEUED_START_RUN_ID } from './flows';

/** A UUID: `chats.listByBatch` validates its batchId input as one. */
export const FIXTURE_BATCH_GROUP_ID = '0f1c9e2a-4b3d-4c5e-8f6a-7b8c9d0e1f2a';
export const FIXTURE_BATCH_MEMBER_CHAT_IDS = [
  'qa-fixture-chat-batch-member-a',
  'qa-fixture-chat-batch-member-b',
] as const;

/**
 * A finished two-member batch under the fixture project, each member linked to its chat through its
 * start_task output. The sidebar groups them under one "Batch QA flow" row that expands on demand.
 */
export function seedBatchGroupFixture(db: SqliteDb): void {
  const flowId = 'qa-fixture-batch-group-flow';
  const versionId = 'qa-fixture-batch-group-flow-v1';
  db.insert(schema.flows)
    .values({
      id: flowId,
      projectId: FIXTURE_PROJECT_ID,
      name: 'Batch QA flow',
      createdAt: T0,
      updatedAt: T0,
    })
    .run();
  db.insert(schema.flowVersions)
    .values({ id: versionId, flowId, versionNumber: 1, graph: FIXTURE_PAUSED_GRAPH, createdAt: T0 })
    .run();
  FIXTURE_BATCH_MEMBER_CHAT_IDS.forEach((chatId, index) => {
    const runId = `qa-fixture-batch-group-run-${index}`;
    db.insert(schema.flowRuns)
      .values({
        id: runId,
        flowVersionId: versionId,
        status: 'completed',
        batchId: FIXTURE_BATCH_GROUP_ID,
        startedAt: T1,
        completedAt: T1,
        createdAt: T1,
      })
      .run();
    db.insert(schema.nodeRuns)
      .values({
        id: `${runId}-start`,
        flowRunId: runId,
        nodeId: 'start',
        blockType: 'start_task',
        status: 'completed',
        nodeOutput: { status: 'completed', outputs: { chatId }, artifacts: [], durationMs: 0 },
        startedAt: T1,
        completedAt: T1,
        createdAt: T1,
      })
      .run();
    db.insert(schema.chats)
      .values({
        id: chatId,
        name: `Batch member ${index === 0 ? 'A' : 'B'}`,
        projectId: FIXTURE_PROJECT_ID,
        createdAt: T1,
        updatedAt: T1,
      })
      .run();
  });
}

/**
 * Two rows for Work Queue's "Queued to run" panel — the only surface that renders queued Flow
 * admissions, and a state no UI action can produce (it needs the machine concurrency cap to be
 * full). Without them the panel is empty and its reorder + remove controls cannot be driven at all.
 *
 * One per priority class, because removing them differs: the `start` never ran and is a batch
 * member (so the confirm dialog states the batch consequence), while the `resume` run is already
 * terminal and survives its own removal. Both reuse the paused fixture's flow version — the panel
 * reads only the flow name and project.
 */
export function seedQueuedAdmissionFixture(db: SqliteDb): void {
  // Its own flow, not the paused fixture's: the panel titles each row by flow name, and borrowing
  // "Paused QA flow" would read as the paused chat's run sitting in the queue.
  db.insert(schema.flows)
    .values({
      id: FIXTURE_QUEUED_FLOW_ID,
      projectId: FIXTURE_PROJECT_ID,
      name: 'Nightly release',
      createdAt: T0,
      updatedAt: T0,
    })
    .run();
  db.insert(schema.flowVersions)
    .values({
      id: FIXTURE_QUEUED_FLOW_VERSION_ID,
      flowId: FIXTURE_QUEUED_FLOW_ID,
      versionNumber: 1,
      graph: FIXTURE_PAUSED_GRAPH,
      createdAt: T0,
    })
    .run();
  db.insert(schema.flowRuns)
    .values([
      {
        id: FIXTURE_QUEUED_START_RUN_ID,
        flowVersionId: FIXTURE_QUEUED_FLOW_VERSION_ID,
        status: 'pending',
        batchId: 'qa-fixture-batch',
        createdAt: T2,
      },
      {
        id: FIXTURE_QUEUED_RESUME_RUN_ID,
        flowVersionId: FIXTURE_QUEUED_FLOW_VERSION_ID,
        status: 'failed',
        createdAt: T2,
        completedAt: T2,
      },
    ])
    .run();
  db.insert(schema.flowRunAdmissions)
    .values([
      {
        flowRunId: FIXTURE_QUEUED_RESUME_RUN_ID,
        state: 'queued',
        priorityClass: 'resume',
        intentVersion: 1,
        intentJson: { version: 1, action: 'resume', flow_run_id: FIXTURE_QUEUED_RESUME_RUN_ID },
        requestedAt: T1,
      },
      {
        flowRunId: FIXTURE_QUEUED_START_RUN_ID,
        state: 'queued',
        priorityClass: 'start',
        intentVersion: 1,
        intentJson: { version: 1, action: 'start', flow_run_id: FIXTURE_QUEUED_START_RUN_ID },
        requestedAt: T2,
      },
    ])
    .run();
}
