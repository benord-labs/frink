/**
 * Boot carry-on: stage a continuation for each restart-interrupted agent turn that can continue its
 * session, so its resume ticket takes the freed slot ahead of queued starts (see flow-run-restart-recovery).
 */

import { eq } from 'drizzle-orm';
import log from 'electron-log';
import { z } from 'zod';
import type { getDatabase } from '../../../db';
import { getFlowRun } from '../../../db/repos/flow-runs';
import { getVersion } from '../../../db/repos/flow-versions';
import { listNodeRunsForFlowRun } from '../../../db/repos/node-runs';
import { recoverOrphanedTasks } from '../../../db/repos/tasks';
import { chats, type FlowVersion, flowRuns, type Task } from '../../../db/schema';
import { type FlowGraphNode, findNodeById, parseGraph } from '../../graph';
import { lastUnfinishedNodeRun } from '../../rerun/resume-point';
import { resolveSessionResumeSeed } from '../../rerun/session-resume';
import { restartMarkedNode } from '../../transitions';
import { captureFlowAdmissionException } from '../activity';
import { hasActiveFlowAdmission } from '../runtime';
import { stageContinuationResume } from './continuation';

type Db = ReturnType<typeof getDatabase>;
type InterruptedTask = Pick<Task, 'flowRunId' | 'nodeRunId' | 'result'>;

/** The chat linkage dispatchAgent stamped on the task; it survives the cancel because the marker is merged. */
const taskLinkageSchema = z.object({ chatId: z.string(), startMode: z.string().optional() });

/**
 * Sync twin of resume.ts isRunRestartInterrupted for the enqueue transaction, plus the run's chat
 * still existing: deleting the chat is how an interrupted run is abandoned, and it must win.
 */
function stillInterrupted(db: Db, flowRunId: string, chatId: string): boolean {
  const run = db
    .select({ status: flowRuns.status })
    .from(flowRuns)
    .where(eq(flowRuns.id, flowRunId))
    .get();
  const chat = db.select({ id: chats.id }).from(chats).where(eq(chats.id, chatId)).get();
  return (
    run?.status === 'cancelled' && Boolean(chat) && restartMarkedNode(db, flowRunId) !== undefined
  );
}

/**
 * Boot step: sweep the turns a dead process left `running`, then stage a carry-on for each that
 * can continue — before the completion watcher turns them terminal and frees their slots.
 */
export async function recoverInterruptedFlowTasks(db: Db): Promise<void> {
  const recovered = await recoverOrphanedTasks(db);
  if (recovered.length === 0) return;
  log.info('[FlowAdmission] recoverOrphanedTasks recovered rows', { count: recovered.length });
  const staged = await stageRestartContinuations(db, recovered);
  if (staged > 0) log.info('[FlowAdmission] boot carry-on staged', { count: staged });
}

export async function stageRestartContinuations(
  db: Db,
  interrupted: InterruptedTask[],
): Promise<number> {
  let staged = 0;
  for (const task of interrupted) {
    if (!task.flowRunId || !task.nodeRunId) continue;
    try {
      if (await stageRestartContinuation(db, task.flowRunId, task.nodeRunId, task.result)) {
        staged += 1;
      }
    } catch (error) {
      // One run's bad row (e.g. an unparsable graph) must not cost the others their carry-on.
      log.warn('[FlowAdmission] boot carry-on skipped a run', { flowRunId: task.flowRunId, error });
      captureFlowAdmissionException(error, 'boot-carry-on-stage');
    }
  }
  return staged;
}

/**
 * The interrupted agent node this task drove, if the run can continue from it. Same anchor as the
 * claim-time resolver: the last unfinished node_run (still `running` here, still last once cancelled).
 */
async function continuableAgentTarget(
  db: Db,
  flowRunId: string,
  nodeRunId: string,
): Promise<FlowGraphNode | null> {
  // Only an `active` admission reaches the settle that fires a staged entry; a `releasing` row or
  // an already-settled run would leave the entry staged forever with no signal.
  if (!(await hasActiveFlowAdmission(flowRunId))) return null;
  const run = await getFlowRun(db, flowRunId);
  if (!run) return null;
  const unfinished = lastUnfinishedNodeRun(await listNodeRunsForFlowRun(db, flowRunId));
  if (unfinished?.id !== nodeRunId || unfinished.parentFanOutNodeRunId) return null;
  return agentNode(await getVersion(db, run.flowVersionId), unfinished.nodeId);
}

function agentNode(version: FlowVersion | null, nodeId: string): FlowGraphNode | null {
  const node = version ? findNodeById(parseGraph(version.graph).nodes, nodeId) : null;
  return node?.blockType === 'agent' ? node : null;
}

async function stageRestartContinuation(
  db: Db,
  flowRunId: string,
  nodeRunId: string,
  result: Task['result'],
): Promise<boolean> {
  const node = await continuableAgentTarget(db, flowRunId, nodeRunId);
  const linkage = taskLinkageSchema.safeParse(result);
  if (!node || !linkage.success) return false;
  // Same two-half gate the claim applies (the chat's sub-chat, its newest flow task minted
  // for this node of this run), so "staged" never diverges from "will actually continue".
  const seed = await resolveSessionResumeSeed(db, {
    chatId: linkage.data.chatId,
    flowRunId,
    nodeId: node.id,
    configuredStartMode: linkage.data.startMode,
  });
  if (!seed) return false;
  const { chatId } = linkage.data;
  // Re-checked inside the enqueue transaction, so an abandon that lands first wins by construction.
  stageContinuationResume(
    { flowRunId, nodeRunId, admit: (tx) => stillInterrupted(tx, flowRunId, chatId) },
    (message) => {
      log.warn('[FlowAdmission] boot carry-on failed', { flowRunId, message });
      captureFlowAdmissionException(new Error(message), 'boot-carry-on');
    },
  );
  return true;
}
