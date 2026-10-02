/** Session gate for a `continuation` terminal-resume dispatch: continue the chat's live session only
 * when it answered THIS node's prompt in this run, else re-send the node's instructions in full. */

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ChatMode } from '../../../../shared/types/chat-mode';
import type { TriggerStartMode } from '../../../../shared/types/trigger-context';
import type { getDatabase } from '../../db';
import { getNodeRun } from '../../db/repos/node-runs';
import { latestAnsweredDispatchTaskId } from '../../db/repos/sub-chat-messages';
import { getSubChatForChat } from '../../db/repos/sub-chats';
import { tasks } from '../../db/schema';

type Db = ReturnType<typeof getDatabase>;

/** Per-node ChatMode → task startMode. Inverse of toChatMode; used to override the inherited mode. */
export const MODE_TO_START_MODE: Record<ChatMode, TriggerStartMode> = {
  agent: 'execute',
  plan: 'plan',
  debug: 'debug',
};

export type SessionResumeSeed = {
  /**
   * The `_config` seed for a continuation dispatch. `resumeSubChatId` pins the VALIDATED
   * sub-chat: the claim-time executor re-resolves the chat's sub-chat independently and
   * applies the continuation (hidden nudge instead of the full prompt, AND
   * `resumeStartMode` instead of the configured mode) only when it lands on this exact
   * row — any other row gets the full prompt in the configured mode. `resumeStartMode` clamps in TWO directions only: forward (configured `plan`,
   * live non-plan — the plan gate already passed, so the derived `skipReview` stays
   * true), and narrowing (configured non-plan, live `plan` — a resumed turn must not
   * reopen a plan-mode session with write permissions, per flow-agent-node-mode's
   * resume-in-current-mode rule). The narrowing direction also stamps an explicit
   * `skipReview: true`: derived-from-startMode would flip to false and park the run at
   * `plan_ready` on a review gate the graph never declared; on a pin miss the explicit
   * value equals the configured mode's derived one, so the stamp is race-safe.
   */
  config: {
    resumeSession: true;
    resumeSubChatId: string;
    resumeStartMode?: TriggerStartMode;
    skipReview?: true;
    resumePriorError?: string;
  };
};

const PRIOR_ERROR_MAX_LENGTH = 200;
const stringPriorErrorSchema = z.object({ error: z.string() });
const messagePriorErrorSchema = z.object({ error: z.object({ message: z.string() }) });

/** Reads `task.result.error` as either a string or an object with a message. */
function extractPriorError(result: unknown): string | null {
  const direct = stringPriorErrorSchema.safeParse(result);
  const nested = direct.success ? null : messagePriorErrorSchema.safeParse(result);
  const message = direct.success
    ? direct.data.error
    : nested?.success
      ? nested.data.error.message
      : '';
  return message.trim().length > 0 ? message.slice(0, PRIOR_ERROR_MAX_LENGTH) : null;
}

/** The run and node a flow task was minted for (task.sourceId → node_run), with its result. */
async function flowTaskNode(
  db: Db,
  taskId: string,
): Promise<{ flowRunId: string; nodeId: string; result: unknown } | null> {
  const [task] = await db
    .select({ flowRunId: tasks.flowRunId, sourceId: tasks.sourceId, result: tasks.result })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!task?.flowRunId || !task.sourceId) return null;
  const nodeRun = await getNodeRun(db, task.sourceId);
  return nodeRun
    ? { flowRunId: task.flowRunId, nodeId: nodeRun.nodeId, result: task.result }
    : null;
}

/** The newest answered dispatch's task when it drove this node of this run. Keyed on the node, as a
 * continuation mints a fresh task whose nudge may never have sent. */
async function answeredNodeTask(
  db: Db,
  subChatId: string,
  node: { flowRunId: string; nodeId: string },
): Promise<{ result: unknown } | null> {
  const taskId = latestAnsweredDispatchTaskId(db, subChatId);
  const answered = taskId ? await flowTaskNode(db, taskId) : null;
  return answered?.flowRunId === node.flowRunId && answered.nodeId === node.nodeId
    ? { result: answered.result }
    : null;
}

/** Whether the session answered the node this flow task drove: the gate every continue-in-place
 * entrance shares, so none wakes an agent on a node it never received. */
export async function sessionAnsweredTaskNode(
  db: Db,
  subChatId: string,
  taskId: string,
): Promise<boolean> {
  const node = await flowTaskNode(db, taskId);
  return node !== null && (await answeredNodeTask(db, subChatId, node)) !== null;
}

export async function resolveSessionResumeSeed(
  db: Db,
  input: {
    chatId: string;
    flowRunId: string;
    nodeId: string;
    /** Untyped string: the inherited value comes from a persisted start_task output. */
    configuredStartMode: string | undefined;
  },
): Promise<SessionResumeSeed | null> {
  const subChat = await getSubChatForChat(db, input.chatId);
  if (!subChat?.sessionId) return null;
  const answered = await answeredNodeTask(db, subChat.id, input);
  if (!answered) return null;

  const priorError = extractPriorError(answered.result);
  const liveStartMode = MODE_TO_START_MODE[subChat.mode as ChatMode] as
    | TriggerStartMode
    | undefined;
  const forwardStartMode =
    input.configuredStartMode === 'plan' && subChat.mode !== 'plan' ? liveStartMode : undefined;
  // UNSET configured mode narrows too: without the clamp the claim would persist the
  // executor's non-plan default onto the live plan session — the exact write-permission
  // escalation this seed exists to prevent.
  const narrowsToPlan = input.configuredStartMode !== 'plan' && subChat.mode === 'plan';

  return {
    config: {
      resumeSession: true,
      resumeSubChatId: subChat.id,
      ...(forwardStartMode ? { resumeStartMode: forwardStartMode } : {}),
      ...(narrowsToPlan ? { resumeStartMode: 'plan' as const, skipReview: true as const } : {}),
      ...(priorError ? { resumePriorError: priorError } : {}),
    },
  };
}
