/** `frink_task_signal`: parse, check the target can still consume the signal (sc-2771), and
 * record it on the execution context. */

import log from 'electron-log';
import type { TaskSignalPayload } from '../../../shared/types/task-signal';
import { getDatabase } from '../db';
import { getFlowRun } from '../db/repos/flow-runs';
import { getTaskById } from '../db/repos/tasks';
import {
  canApplyTaskSignalForStatus,
  parseTaskSignalInput,
} from '../trpc/routers/frink-task-signal';
import { type McpToolResult, toolResult } from './tool-result';

/** A signal the tool recorded — `at` is always stamped. */
export type RecordedTaskSignal = TaskSignalPayload & { at: string };

/** The slice of an execution context the tool reads and writes. */
export type TaskSignalToolContext = {
  /** False when no live task expects a lifecycle signal; also flipped off by a refusal here. */
  taskSignalEnabled: boolean;
  /** The task row an accepted signal lands on (the executor's `signalTaskId`). */
  signalTaskId?: string | null;
  latestTaskSignal?: RecordedTaskSignal;
};

const DISARMED_MESSAGE =
  'No active task expects a lifecycle signal in this chat — the flow/task already completed. Do not call this tool again; just answer the user.';

export async function handleTaskSignalToolCall(
  ctx: TaskSignalToolContext,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  // Resumed sessions can carry the tool in their transcript even after it is hidden from
  // tools/list — refuse instead of recording a signal nothing will consume.
  if (!ctx.taskSignalEnabled) return toolResult(DISARMED_MESSAGE, true);
  // Same parser as the canUseTool persist, so the two paths never disagree on a valid signal.
  const signal = parseTaskSignalInput(args);
  if (!signal) return toolResult('Invalid arguments: malformed frink_task_signal payload', true);
  const refusal = await refuseDeadSignalTarget(ctx.signalTaskId);
  if (refusal) {
    // Disarm for the turn: hides the tool and releases the Codex stop guard and Claude Stop hook,
    // so nobody chases the agent to re-send a signal nothing will accept.
    ctx.taskSignalEnabled = false;
    return toolResult(refusal, true);
  }
  // parseTaskSignalInput always stamps `at`; the `??` only satisfies its optional return type.
  ctx.latestTaskSignal = { ...signal, at: signal.at ?? new Date().toISOString() };
  // Accepted by a live target. The task transition — and any flow advance — applies when this
  // turn ends (flow-node-advance-timing), so this deliberately promises no advance.
  const body = { ok: true, accepted: true, appliesAt: 'turn-end', signal: ctx.latestTaskSignal };
  return toolResult(JSON.stringify(body, null, 2));
}

/** Refusal text when the target can't consume a signal, else null. A read fault fails OPEN. */
async function refuseDeadSignalTarget(signalTaskId: string | null | undefined) {
  if (!signalTaskId) return null;
  try {
    const db = getDatabase();
    const task = await getTaskById(db, signalTaskId);
    if (!(await isUnsignalable(task))) return null;
    const run = task?.flowRunId ? await getFlowRun(db, task.flowRunId) : null;
    return refusalText(task, run);
  } catch (error) {
    log.warn('[DynamicChat] frink_task_signal target check failed; accepting signal', {
      taskId: signalTaskId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Row gone, non-signalable, or run terminal. A parked `needs_attention` row stays signalable. */
async function isUnsignalable(task: Awaited<ReturnType<typeof getTaskById>>): Promise<boolean> {
  // Lazy: socket/ reaches back into mcp/ (see dynamic-chat-server's CIRCULAR DEP NOTE).
  const { isSignalTargetDead } = await import('../socket/flow-signal');
  if (await isSignalTargetDead(task)) return true;
  return task != null && task.status !== 'needs_attention' && !canApplyTaskSignalForStatus(task);
}

function refusalText(task: { status: string } | null, run: { status: string } | null): string {
  const taskState = task ? `is ${task.status}` : 'no longer exists';
  const runState = run ? ` (flow run ${run.status})` : '';
  return (
    `Signal not accepted: the linked task ${taskState}${runState}, so nothing will act on this ` +
    'signal and the flow will not advance on it. Do not call this tool again; report the ' +
    'outcome to the user in your reply instead.'
  );
}
