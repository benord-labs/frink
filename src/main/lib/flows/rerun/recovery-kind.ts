/**
 * How a stopped step recovers: `continue` when its live session answered the step's prompt, else
 * `retry`; shared by every label and the server routing so a button never promises the other.
 */

import { TRPCError } from '@trpc/server';
import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import { RESUME_ACTIONABLE_NODE_STATUSES } from '../../../../shared/types/flow';
import type { RecoveryKind, RunRecovery } from '../../../../shared/types/flow-run/resume';
import type { getDatabase } from '../../db';
import { listNodeRunsForFlowRun } from '../../db/repos/node-runs';
import {
  latestAnsweredDispatchTaskIds,
  latestDispatchTaskIds,
} from '../../db/repos/sub-chat-messages';
import { type NodeRun, nodeRuns, subChats, type Task, tasks } from '../../db/schema';
import { extractTaskTriggerConfig } from '../../task-executor/task-prompt';
import {
  restartMarkedNode,
  runTransition,
  type SettledRun,
  type StopNode,
  settledStopNodes,
} from '../transitions';

type Db = ReturnType<typeof getDatabase>;
type StoppedTask = Pick<Task, 'id' | 'flowRunId' | 'result'>;

const ACTIONABLE_STATUSES: readonly string[] = RESUME_ACTIONABLE_NODE_STATUSES;
/** The part of a task's result naming the sub-chat that drove it. */
const taskSubChatSchema = z.object({ subChatId: z.string() });

/** The sub-chats among `ids` that still hold a session (a rollback empties it). */
function liveSessionSubChatIds(db: Db, ids: string[]): string[] {
  return db
    .select({ id: subChats.id })
    .from(subChats)
    .where(
      and(inArray(subChats.id, ids), isNotNull(subChats.sessionId), ne(subChats.sessionId, '')),
    )
    .all()
    .map((row) => row.id);
}

/** A continuation attempt (Continue / carry-on) stamps this on its dispatch `_config`. */
const continuationConfigSchema = z.object({ resumeSession: z.literal(true) });

type FlowTaskNode = { node: string; continuation: boolean };

/** Each flow task's run + node identity, for the tasks among `taskIds` that drove a node. */
function flowTaskNodes(db: Db, taskIds: string[]): Map<string, FlowTaskNode> {
  const rows = db
    .select({
      id: tasks.id,
      flowRunId: tasks.flowRunId,
      nodeId: nodeRuns.nodeId,
      triggerContext: tasks.triggerContext,
    })
    .from(tasks)
    .innerJoin(nodeRuns, eq(nodeRuns.id, tasks.sourceId))
    .where(and(inArray(tasks.id, taskIds), isNotNull(tasks.flowRunId)))
    .all();
  return new Map(
    rows.map((row) => [
      row.id,
      {
        node: `${row.flowRunId}:${row.nodeId}`,
        continuation: continuationConfigSchema.safeParse(
          extractTaskTriggerConfig(row.triggerContext),
        ).success,
      },
    ]),
  );
}

/** A continuation's nudge may not have sent yet, so it rides the answer to its node's prompt. */
function continuesAnsweredNode(own?: FlowTaskNode, answered?: FlowTaskNode): boolean {
  return own?.continuation === true && own.node === answered?.node;
}

/** Whether `promptTaskId`'s prompt is this task's own: itself, or its node's for a continuation. */
function ownsPrompt(nodeOf: Map<string, FlowTaskNode>, taskId: string, promptTaskId = ''): boolean {
  return (
    promptTaskId === taskId || continuesAnsweredNode(nodeOf.get(taskId), nodeOf.get(promptTaskId))
  );
}

/** Each task's recovery from the sub-chat it ran in, a fixed number of queries for any count. One
 * transaction, so a rollback or a new turn never lands between the session and transcript reads. */
function recoveryKindsBySubChat(db: Db, subChatOf: Map<string, string>): Map<string, RecoveryKind> {
  return db.transaction(() => {
    const live = liveSessionSubChatIds(db, [...new Set(subChatOf.values())]);
    const answeredBy = latestAnsweredDispatchTaskIds(db, live);
    const newestBy = latestDispatchTaskIds(db, live);
    const prompted = [...answeredBy.values(), ...newestBy.values()];
    const nodeOf = flowTaskNodes(db, [...subChatOf.keys(), ...prompted]);
    return new Map<string, RecoveryKind>(
      [...subChatOf].map(([taskId, subChatId]) => {
        // Flow nodes share one sub-chat: another task's later prompt means it drove the session
        // since, and an earlier attempt's answer never continues a fresh Retry.
        const answered =
          ownsPrompt(nodeOf, taskId, newestBy.get(subChatId)) &&
          ownsPrompt(nodeOf, taskId, answeredBy.get(subChatId));
        return [taskId, answered ? 'continue' : 'retry'];
      }),
    );
  });
}

/**
 * The recovery of each stopped task. Synchronous, so a mutation can re-check it in the same
 * transaction as the write that acts on it.
 */
export function resolveRecoveryKinds(
  db: Db,
  stopped: readonly StoppedTask[],
): Map<string, RecoveryKind> {
  const subChatOf = new Map<string, string>();
  for (const task of stopped) {
    const parsed = taskSubChatSchema.safeParse(task.result);
    if (parsed.success) subChatOf.set(task.id, parsed.data.subChatId);
  }
  const kinds = recoveryKindsBySubChat(db, subChatOf);
  return new Map(stopped.map((task) => [task.id, kinds.get(task.id) ?? 'retry']));
}

/** Whether `subChatId`'s session answered this task's own attempt: the gate every continue-in-place
 * entrance shares, so none wakes an agent on a prompt it never received. */
export function sessionAnsweredTask(db: Db, subChatId: string, taskId: string): boolean {
  return recoveryKindsBySubChat(db, new Map([[taskId, subChatId]])).get(taskId) === 'continue';
}

export function resolveRecoveryKind(db: Db, task: StoppedTask): RecoveryKind {
  return resolveRecoveryKinds(db, [task]).get(task.id) ?? 'retry';
}

/** The refusal when a step's recovery no longer matches the one the user clicked. */
export const recoveryChangedError = () =>
  new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: 'This step changed — refresh and try again',
  });

/**
 * Runs `write` in one transaction with the re-check that the task's CURRENT row still recovers as
 * `kind`, so no answer, rollback or newer attempt lands between check and write. Else null.
 */
export function withRecoveryKind<T>(
  db: Db,
  taskId: string,
  kind: RecoveryKind,
  write: () => T,
): T | null {
  return runTransition(db, () => {
    const current = db
      .select({ id: tasks.id, flowRunId: tasks.flowRunId, result: tasks.result })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get();
    return current && resolveRecoveryKind(db, current) === kind ? write() : null;
  });
}

/** Each step's recovery, from the tasks that drove it; a step without a task (non-agent) retries. */
function stepRecoveryKinds(db: Db, stepIds: string[]): Map<string, RecoveryKind> {
  const stepTasks = db
    .select({
      id: tasks.id,
      flowRunId: tasks.flowRunId,
      nodeRunId: tasks.nodeRunId,
      result: tasks.result,
    })
    .from(tasks)
    .where(inArray(tasks.nodeRunId, stepIds))
    .all();
  const kinds = resolveRecoveryKinds(db, stepTasks);
  return new Map(stepTasks.map((task) => [task.nodeRunId ?? '', kinds.get(task.id) ?? 'retry']));
}

/** One step's recovery. Synchronous, so a transition can re-check it before its first write. */
export function stepRecoveryKind(db: Db, nodeRunId: string): RecoveryKind {
  return stepRecoveryKinds(db, [nodeRunId]).get(nodeRunId) ?? 'retry';
}

/**
 * Recoveries for a restart-interrupted run's marked step, or each actionable step of a paused run
 * (a fan-out can park several). Other runs have none. `nodeRuns`: the run's steps, if already read.
 */
export async function resolveRunRecoveries(
  db: Db,
  run: { id: string; status: string },
  nodeRuns?: readonly NodeRun[],
): Promise<RunRecovery[]> {
  let steps: NodeRun[] = [];
  const marked = run.status === 'cancelled' ? restartMarkedNode(db, run.id) : undefined;
  if (marked) steps = [marked];
  if (run.status === 'paused') {
    const nodeRunsForRun = nodeRuns ?? (await listNodeRunsForFlowRun(db, run.id));
    steps = nodeRunsForRun.filter((nr) => ACTIONABLE_STATUSES.includes(nr.status));
  }
  return stepRecoveries(db, steps);
}

/** Each step's recovery, a fixed number of queries for any count. */
function stepRecoveries(db: Db, steps: readonly StopNode[]): RunRecovery[] {
  const kinds = stepRecoveryKinds(
    db,
    steps.map((step) => step.id),
  );
  return steps.map((step) => ({
    nodeRunId: step.id,
    kind: kinds.get(step.id) ?? 'retry',
    confirmSideEffects: step.blockType !== 'agent' && step.startedAt !== null,
  }));
}

/** Each settled run's recovery for the step it stopped on, by run id (see settledStopNodes). */
export function resolveSettledRunRecoveries(
  db: Db,
  runs: readonly SettledRun[],
): Map<string, RunRecovery> {
  const stoppedOn = settledStopNodes(db, runs);
  const recoveries = stepRecoveries(db, stoppedOn);
  return new Map(stoppedOn.map((step, i) => [step.flowRunId, recoveries[i]]));
}
