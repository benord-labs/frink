/**
 * How a claimed task's flow `_config` is read at execution time — the dispatch→executor claim
 * contract. dispatchAgent (and the cloud node-dispatch mirror) embed `_config` in the task's
 * trigger context; the executor reads it here when claiming the task.
 */

import { z } from 'zod';
import { extractRawTriggerConfig } from '../../../../shared/lib/trigger-rule-config';
import { taskResultSchema } from '../../../../shared/types/task-result';
import type { Task as DbTask } from '../../db/schema';

export const taskClaimResultSchema = z.object({
  chatId: z.string().optional().catch(undefined),
  subChatId: z.string().optional().catch(undefined),
  retryMode: z.enum(['continue', 'restart']).optional().catch(undefined),
  retryPriorError: z.string().nullable().optional().catch(undefined),
});

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function getFlowConfigField<T>(
  rawConfig: unknown,
  key: string,
  guard: (value: unknown) => value is T,
): T | null {
  if (!isRecord(rawConfig)) return null;
  const value = rawConfig[key];
  return guard(value) ? value : null;
}

function extractTaskTriggerConfig(triggerContext: DbTask['triggerContext']) {
  const parsed = taskResultSchema.safeParse(triggerContext);
  return extractRawTriggerConfig(parsed.success ? parsed.data : undefined);
}

/**
 * True when the task was minted by a deliberate flow re-dispatch (resume/retry paths create a
 * fresh node_run for a node that already ran — dispatchAgent stamps `_config.isNodeRedispatch`).
 * Widens the renderer's `isRetry` dedup bypass so the re-dispatched prompt, already persisted as a
 * user message in the reused chat, is re-sent instead of swallowed. Distinct from a `tasks.retry`
 * claim (result.retryMode), which alone drives the flow-run unpark.
 */
export function isDeliberateRedispatch(rawFlowConfig: unknown): boolean {
  return (
    getFlowConfigField(rawFlowConfig, 'isNodeRedispatch', (v): v is true => v === true) === true
  );
}

/**
 * The two flags derived per task claim. They MUST stay split: `isRetry` (the renderer's
 * alreadySent-dedup bypass) widens to deliberate re-dispatches, while `isUserRetryClaim` (the
 * flow-run unpark gate) keys on the tasks.retry claim ONLY — a re-dispatch has already flipped its
 * run back to `running` before dispatch, so unparking would refuse and wrongly fail the fresh task.
 */
export function deriveTaskClaimFlags(
  retryMode: 'continue' | 'restart' | null,
  rawFlowConfig: unknown,
): { isRetry: boolean; isUserRetryClaim: boolean } {
  return {
    isRetry: retryMode != null || isDeliberateRedispatch(rawFlowConfig),
    isUserRetryClaim: retryMode != null,
  };
}

/**
 * Whether this claim should CONTINUE the sub-chat's resumed session (hidden nudge)
 * instead of sending the task's full prompt, and the prior-attempt error the nudge
 * names. Two writers, one reader: a `tasks.retry` claim carries `result.retryMode`;
 * a continuation terminal-resume dispatch stamps `_config.resumeSession` (+
 * `resumeSubChatId` + `resumePriorError`) at mint because a fresh task cannot carry a
 * retryMode — routing it through retryMode would trip `isUserRetryClaim`'s unpark,
 * which refuses on a run admission already flipped to `running` and would force-fail
 * the task. The `_config` lane only fires when the claim resolved the SAME sub-chat the
 * mint-time gate validated (`claimSubChatId`): the chat's sub-chat is re-derived at claim,
 * and any other row must get the full prompt, not the nudge.
 */
export function resolveClaimResume(
  retryMode: 'continue' | 'restart' | null,
  retryPriorError: string | null,
  rawFlowConfig: unknown,
  claimSubChatId: string | null,
): { continueSession: boolean; priorError: string | null } {
  const pinnedSubChatId = getFlowConfigField(rawFlowConfig, 'resumeSubChatId', isString);
  return {
    continueSession:
      retryMode === 'continue' ||
      (getFlowConfigField(rawFlowConfig, 'resumeSession', (v): v is true => v === true) === true &&
        pinnedSubChatId !== null &&
        pinnedSubChatId === claimSubChatId),
    priorError: retryPriorError ?? getFlowConfigField(rawFlowConfig, 'resumePriorError', isString),
  };
}

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

/**
 * The Flow-owned Auto value for a task, or undefined when no Flow owns one.
 *
 * Gated on Flow PROVENANCE, never on `_config`'s contents alone: that key is not allowlisted and
 * reaches the row from caller-supplied context (flow batch-mutations, `frink_flows_run`), so
 * trusting the field by itself would let a caller grant itself Auto. `source` is what covers cloud
 * fire-and-forget, which carries the Flow's setting with NO `flow_run_id` — linking that row would
 * drag it into the flow-run recovery sweeps that force-finalize a task outliving its run.
 *
 * Flow-LINKED graphs predating this setting default on; a task carrying no value has none.
 */
export function resolveFlowAutoReviewToolsForTask(
  task: Pick<DbTask, 'flowRunId' | 'triggerContext' | 'source'>,
): boolean | undefined {
  if (!task.flowRunId && task.source !== 'flow') return undefined;
  const cfg = extractTaskTriggerConfig(task.triggerContext);
  return (
    getFlowConfigField(cfg, 'autoReviewTools', isBoolean) ?? (task.flowRunId ? true : undefined)
  );
}

/**
 * Flow-level Codex Fast mode for a claimed task, or `undefined` when it does not apply.
 *
 * Same Flow-PROVENANCE gate as {@link resolveFlowAutoReviewToolsForTask}, and for a sharper
 * reason: `_config` is caller-supplied, so trusting the field alone would let a caller opt itself
 * into a tier that bills 2-2.5x credits.
 *
 * Unlike Auto there is NO legacy-on fallback — a flow-linked task carrying no value yields
 * `undefined`, which leaves the chat's own Fast state untouched. Defaulting a missing value to
 * `true` would spend a user's credits on graphs that never asked for it.
 */
export function resolveFlowCodexFastModeForTask(
  task: Pick<DbTask, 'flowRunId' | 'triggerContext' | 'source'>,
): boolean | undefined {
  if (!task.flowRunId && task.source !== 'flow') return undefined;
  // `?? undefined`, not the raw null: a null would survive the `!== undefined` spread guards in
  // task-executor and then fail `isOptionalBoolean`, silently dropping the whole chat-ready payload.
  return (
    getFlowConfigField(extractTaskTriggerConfig(task.triggerContext), 'codexFastMode', isBoolean) ??
    undefined
  );
}
