/**
 * Shared flow-engine test fixtures — bootstrap a flow run (project + flow +
 * version + flow_run) and seed completed node_runs. Extracted from the dispatch
 * test files, which all repeat the same setup (agent-chain / run-command /
 * chat-reply / start-task).
 */

import { getOrCreateFlowRunByIdempotencyKey } from '../repos/flow-runs';
import { createFlowVersion } from '../repos/flow-versions';
import { createFlow } from '../repos/flows';
import { createNodeRun, setNodeRunStatus } from '../repos/node-runs';
import { createProject } from '../repos/projects';
import {
  flowRunAdmissions,
  type NodeRun,
  nodeRuns,
  subChatMessages,
  type Task,
  tasks,
} from '../schema';
import type { TestDb } from './fresh-db';

/** Creates a project + flow + version(graph) + a running flow_run; returns their ids. */
export async function seedFlowRun(
  db: TestDb,
  graph: unknown,
  opts: { idempotencyKey?: string } = {},
): Promise<{ projectId: string; flowId: string; versionId: string; flowRunId: string }> {
  const project = await createProject(db, { name: 'P', path: '/tmp/p' });
  const flow = await createFlow(db, { name: 'F' });
  const version = await createFlowVersion(db, { flowId: flow.id, graph });
  const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
    flowVersionId: version.id,
    status: 'running',
    triggerContext: null,
    idempotencyKey: opts.idempotencyKey ?? 'k1',
    startedAt: new Date(),
  });
  return { projectId: project.id, flowId: flow.id, versionId: version.id, flowRunId: run.id };
}

/**
 * Seeds a completed node_run with a persisted node_output — what advanceFlowRun
 * writes in production (dispatchers alone don't). Pass `outputs` (wrapped in the
 * standard envelope) or a full `nodeOutput` for callers that already have one.
 */
export async function seedCompletedNodeRun(
  db: TestDb,
  input: {
    flowRunId: string;
    nodeId: string;
    blockType: string;
    outputs?: Record<string, unknown>;
    nodeOutput?: unknown;
    completedAt?: Date;
    laneIndex?: number;
    parentFanOutNodeRunId?: string;
  },
): Promise<NodeRun> {
  const run = await createNodeRun(db, {
    flowRunId: input.flowRunId,
    nodeId: input.nodeId,
    blockType: input.blockType,
    status: 'pending',
    laneIndex: input.laneIndex ?? null,
    parentFanOutNodeRunId: input.parentFanOutNodeRunId ?? null,
  });
  const nodeOutput = input.nodeOutput ?? {
    status: 'completed',
    outputs: input.outputs ?? {},
    artifacts: [],
    durationMs: 0,
  };
  await setNodeRunStatus(db, run.id, 'completed', {
    nodeOutput,
    completedAt: input.completedAt ?? new Date(),
  });
  return run;
}

/** Seeds the admission a dispatched run holds: its live ticket in state `active`. Returns the ticket. */
export function seedActiveAdmission(db: TestDb, flowRunId: string): number {
  return db
    .insert(flowRunAdmissions)
    .values({
      flowRunId,
      state: 'active',
      priorityClass: 'start',
      intentVersion: 1,
      intentJson: { version: 1, action: 'start', flow_run_id: flowRunId },
      startedAt: new Date(),
    })
    .returning({ ticket: flowRunAdmissions.ticket })
    .get().ticket;
}

/**
 * A step of `flowRunId` and the task that drove it, in chat `chat-1` / sub-chat `sub-1` (the caller
 * seeds those). `answered` persists the task's prompt and the session's reply.
 */
export async function seedFlowStep(
  db: TestDb,
  flowRunId: string,
  id: string,
  status: Task['status'],
  step: Partial<typeof nodeRuns.$inferInsert>,
  answered = false,
): Promise<Task> {
  await db
    .insert(nodeRuns)
    .values({ id, flowRunId, nodeId: id, blockType: 'agent', status: 'completed', ...step });
  const [task] = await db
    .insert(tasks)
    .values({
      id: `task-${id}`,
      description: id,
      source: 'flow',
      status,
      result: { chatId: 'chat-1', subChatId: 'sub-1' },
      flowRunId,
      sourceId: id,
      nodeRunId: id,
    })
    .returning();
  if (answered) {
    const prompt = {
      id: `u-${id}`,
      role: 'user',
      parts: [],
      metadata: { dispatchTaskId: task.id },
    };
    const reply = { id: `a-${id}`, role: 'assistant', parts: [] };
    await db.insert(subChatMessages).values([
      { subChatId: 'sub-1', seq: 0, message: JSON.stringify(prompt) },
      { subChatId: 'sub-1', seq: 1, message: JSON.stringify(reply) },
    ]);
  }
  return task;
}
