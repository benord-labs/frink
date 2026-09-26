/**
 * Session gate for a `continuation` terminal-resume dispatch: decides whether the node
 * being re-dispatched can CONTINUE the driving sub-chat's surviving Claude session
 * instead of re-sending its instructions.
 *
 * Two halves, both required (mirrors `resolveInterruptedResumeMode` in flows/resume.ts —
 * a session id alone proves a session exists, not that it holds THIS node's turn):
 *   1. the chat's sub-chat — the one `createChatForTask` resolves for a `continue_chat`
 *      task (both go through `getSubChatForChat`, or the nudge lands in a session-less
 *      sub-chat) — has a live `sessionId`, and
 *   2. that sub-chat's newest flow task was minted for the SAME node of the SAME run
 *      (task.sourceId → node_run.nodeId). A node that failed before streaming, a
 *      non-agent anchor, or a session last driven by an upstream node all fail here and
 *      fall back to an honest full re-dispatch.
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ChatMode } from '../../../../shared/types/chat-mode';
import type { TriggerStartMode } from '../../../../shared/types/trigger-context';
import type { getDatabase } from '../../db';
import { getNodeRun } from '../../db/repos/node-runs';
import { getSubChatForChat } from '../../db/repos/sub-chats';
import { getLatestFlowTaskForSubChat } from '../../db/repos/tasks';
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

  const latest = await getLatestFlowTaskForSubChat(db, subChat.id);
  if (!latest || latest.flowRunId !== input.flowRunId) return null;
  const [latestTask] = await db
    .select({ sourceId: tasks.sourceId, result: tasks.result })
    .from(tasks)
    .where(eq(tasks.id, latest.id))
    .limit(1);
  if (!latestTask?.sourceId) return null;
  const mintingNodeRun = await getNodeRun(db, latestTask.sourceId);
  if (mintingNodeRun?.nodeId !== input.nodeId) return null;

  const priorError = extractPriorError(latestTask.result);
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
