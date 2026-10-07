import { randomUUID } from 'node:crypto';
import log from 'electron-log';
import { z } from 'zod';
import {
  boundStepName,
  type MessageOrigin,
  type MessageProvenance,
} from '../../../../../shared/lib/message-markers/message-provenance';
import { captureMainException } from '../../../sentry/init';
import { TOOL_TASK_SIGNAL_STATES } from '../../../trpc/routers/frink-task-signal';
import type { FlowSignalArming } from '../../flow-signal';

type SignalTask = {
  id?: string;
  flowRunId?: string | null;
  title?: string | null;
  status?: string | null;
  result?: unknown;
};
const isParked = (status?: string | null) => status === 'needs_attention' || status === 'failed';

export function createMessageProvenance(
  origin: MessageOrigin = { source: 'unknown', kind: 'message' },
  task?: SignalTask | null,
): MessageProvenance {
  const record: MessageProvenance = { v: 1, delivery_id: randomUUID(), ...origin };
  if (!task) return record;
  record.step = stepFromTask(task);
  return record;
}

/** A stored signal the tool would accept back; a synthetic park state fails the parse. */
const storedSignal = z.object({
  agentSignal: z.object({ state: z.enum(TOOL_TASK_SIGNAL_STATES) }),
});

function stepFromTask(task: SignalTask): MessageProvenance['step'] {
  const step: NonNullable<MessageProvenance['step']> = {};
  if (task.title) step.name = boundStepName(task.title);
  if (task.status) step.was_paused = isParked(task.status);
  const stored = storedSignal.safeParse(task.result);
  if (stored.success) {
    const { state } = stored.data.agentSignal;
    step.previous_signal = state === 'completed' ? 'done' : state;
  }
  return step;
}

/** A turn's record, or undefined when no Flow run was live in the chat as the turn was admitted. */
export function provenanceForTurn(
  armed: Pick<
    FlowSignalArming,
    'liveFlowRunId' | 'isFlowDrivenExecution' | 'restartInterruptedFlowRunId'
  > & { prefetchedSignalTask?: SignalTask | null; revivedTask?: SignalTask | null },
  delivery: { messageOrigin?: MessageOrigin; dispatchTaskId?: string },
  signalTaskId: string | null,
): MessageProvenance | undefined {
  // An admission-time snapshot on purpose: a run that ends later still had this delivery arrive
  // while it was live, and the next turn re-reads.
  if (!armed.liveFlowRunId) return undefined;
  const { messageOrigin, dispatchTaskId } = delivery;
  const isFlowTurn = armed.isFlowDrivenExecution || armed.restartInterruptedFlowRunId !== null;
  const task =
    isFlowTurn && signalTaskId ? (armed.prefetchedSignalTask ?? armed.revivedTask) : null;
  // On a reused chat a step can belong to an older run: only the live run's step is described.
  const step = task?.flowRunId === armed.liveFlowRunId ? task : null;
  // Task identity decides a dispatch: only the step that drives this chat speaks as the Flow, so a
  // flow marker with no matching task id (an older queue item) is not trusted either.
  const claimsDispatch = Boolean(dispatchTaskId) || messageOrigin?.source === 'flow';
  const drivesChat = step !== null && Boolean(dispatchTaskId) && dispatchTaskId === signalTaskId;
  return createMessageProvenance(
    claimsDispatch && messageOrigin?.kind === 'message'
      ? { source: drivesChat ? 'flow' : 'internal', kind: 'message' }
      : messageOrigin,
    step,
  );
}

async function currentTaskStatus(taskId: string): Promise<string | undefined> {
  const { getDatabase } = await import('../../../db');
  const { getTaskById } = await import('../../../db/repos/tasks');
  return (await getTaskById(getDatabase(), taskId))?.status;
}

/**
 * Mark the step's signal as cleared once the task really left its park. `flowLive` false does not
 * mean it stayed parked: the task can resume while its flow does not follow, so re-read it.
 */
export async function recordProvenanceResume(
  record: MessageProvenance,
  flowLive: boolean,
  task?: SignalTask | null,
  readStatus: (taskId: string) => Promise<string | undefined> = currentTaskStatus,
): Promise<void> {
  if (!record.step) return;
  if (!flowLive) {
    // Parked or restart-interrupted before; only a row that is running now was really resumed.
    if (!task?.id || task.status === 'running') return;
    // Metadata only: a failed read costs the record its claim, never the resumed turn.
    let status: string | undefined;
    try {
      status = await readStatus(task.id);
    } catch (err) {
      log.warn('[Socket Executor] provenance resume read failed; signal_cleared omitted', {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
      captureMainException(err, { surface: 'provenance-resume-read' });
    }
    // Only a step still running awaits a fresh signal; one already finished or re-parked does not.
    if (status !== 'running') return;
  }
  record.step = { ...(task ? stepFromTask(task) : record.step), signal_cleared: true };
}
