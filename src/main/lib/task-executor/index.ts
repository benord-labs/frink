/* eslint-disable max-lines, max-lines-per-function */
/**
 * Task Executor Service
 * Creates chat sessions for claimed tasks and notifies renderer to execute
 *
 * Architecture:
 * - Listens for 'task:claimed' events from TaskPoller
 * - Creates a chat linked to the task via cloud-client (with taskId)
 * - Emits IPC event to renderer to open chat and auto-send prompt
 * - Task execution happens through normal chat UI (streaming, tool approval, etc.)
 * - Task status updated when agent done, user marks complete, or agent stuck
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { BrowserWindow } from 'electron';
import log from 'electron-log';
import { buildHiddenWakeMessage } from '../../../shared/lib/message-markers/hidden-wake-marker';
import { CLAUDE_MODEL_IDS } from '../../../shared/lib/models';
import { buildTriggerBubbleMessage } from '../../../shared/lib/trigger-bubble-marker';
import {
  extractRawTriggerConfig,
  type ResolvedTaskStartMode,
  resolveTaskExecutionMetadata,
  resolveTaskStartInWorktreeFromConfig,
  toChatMode,
} from '../../../shared/lib/trigger-rule-config';
import { buildTriggerSummary } from '../../../shared/lib/trigger-summary';
import type {
  TaskChatImageAttachment,
  TaskChatReadyData,
} from '../../../shared/types/task-chat-ready';
import {
  isValidTriggerContext,
  TRIGGER_START_MODES,
  type TriggerContext,
  type TriggerStartMode,
  withTriggerContextDefaults,
} from '../../../shared/types/trigger-context';
import {
  getClaudeCodeTokenById,
  getDefaultClaudeCodeToken,
  isResolvedCredential,
} from '../credentials';
import { getDatabase } from '../db';
import { createChat, updateChat } from '../db/repos/chats';
import { getProjectAiAccount as getProjectAiAccountLocal } from '../db/repos/project-ai-accounts';
import { getProjectById as getLocalProjectById } from '../db/repos/projects';
import { createSubChat, getSubChatById, getSubChatForChat } from '../db/repos/sub-chats';
import {
  getTaskById,
  parseResultRecord,
  taskResultSchema,
  type TaskResultRecord,
  updateTaskStatus as updateTaskStatusLocal,
} from '../db/repos/tasks';
import type { Task as DbTask } from '../db/schema';
import { projects } from '../db/schema';
import {
  deriveTaskClaimFlags,
  getFlowConfigField,
  isRecord,
  isString,
  resolveClaimResume,
  resolveFlowAutoReviewToolsForTask,
  resolveFlowCodexFastModeForTask,
  taskClaimResultSchema,
} from '../flows/rerun/claim-flags';
import { type DispatchErrorMeta, persistDispatchFailure } from '../tasks';
import { fetchAttachmentImages } from './attachment-images';
import { extractTrailingUserReply } from './trailing-reply';

/** Thin wrapper that auto-binds the local SQLite handle. */
const getProjectAiAccount = (projectId: string) =>
  getProjectAiAccountLocal(getDatabase(), projectId);

import { createWorktreeForBranch, createWorktreeForChat } from '../git/worktree';
import { createWorktreeWithMergedBases } from '../git/worktree-converge';
import { sanitizeProjectName } from '../git/worktree-naming';
import { validateWorktreeForReuse } from '../git/worktree-validation';
import { executeShellTask, isShellExecutionMode } from '../shell-executor';
import { sendSubChatModeChange } from '../socket/client';
import { persistModeThenNotify } from '../socket/streaming/plan-auto-approve';
import { getTaskPoller } from '../task-poller';
import {
  clearActiveFlowTaskForChat,
  registerPendingDispatchMode,
  setActiveFlowTaskForChat,
} from './dispatch-registry';

// The registry stays part of this module's public surface — its five consumers (socket executor,
// flows engine, tests) address the task-executor module, not the storage split.
export {
  clearActiveFlowTaskForChat,
  clearActiveFlowTaskForChatIfMatches,
  getActiveFlowTaskForChat,
  resolveFlowContinuationExecutionTask,
  setActiveFlowTaskForChat,
} from './dispatch-registry';

export type TaskExecutionAccountType = 'claude-code' | 'codex';

export function shouldForwardTaskModel(
  model: string | undefined,
  executionAccountType: TaskExecutionAccountType,
): boolean {
  if (!model) return false;
  // Flow/trigger configs store the UI PICKER id (e.g. `opus-4.8`, `codex-gpt-5.3-codex-high`), not the
  // CLI/Anthropic value. Validate in the picker namespace; picker->CLI conversion happens downstream
  // (renderer transport for claude; the executor's resolveCodexCliModel for codex).
  if (executionAccountType === 'codex') return model.startsWith('codex-');
  return CLAUDE_MODEL_IDS.includes(model);
}

/** Credential `type` → task execution account type (NULL/legacy/unknown → claude-code). */
export const toTaskAccountType = (credType: string): TaskExecutionAccountType =>
  credType === 'codex' ? 'codex' : 'claude-code';

/** User-facing provider name per account type (model-fallback messaging). */
const PROVIDER_LABEL: Record<TaskExecutionAccountType, string> = {
  'claude-code': 'Claude',
  codex: 'OpenAI',
};

async function resolveExecutionAccountTypeForTask(
  projectId: string | null,
): Promise<TaskExecutionAccountType> {
  if (!projectId) {
    return toTaskAccountType((await getDefaultClaudeCodeToken()).type);
  }

  try {
    const projectAccount = await getProjectAiAccount(projectId);
    if (projectAccount) {
      const cred = await getClaudeCodeTokenById(projectAccount.id);
      return toTaskAccountType(cred.type);
    }
  } catch {
    // Fall through to default account resolution.
  }

  return toTaskAccountType((await getDefaultClaudeCodeToken()).type);
}

type TaskChatReadyPayload = TaskChatReadyData;

const TASK_CHAT_NAME_MAX_LENGTH = 100;

export function buildInitialTaskChatName(taskDescription: string): string {
  const plainText = taskDescription
    // Strip markdown links: [label](url) -> label
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Strip common markdown formatting markers
    .replace(/[`*_~]/g, '')
    // Strip markdown heading/blockquote markers
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    // Strip leading markdown list bullets
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (plainText.length === 0) {
    return 'Task';
  }

  return plainText.slice(0, TASK_CHAT_NAME_MAX_LENGTH);
}

/**
 * Picks sub-chat for an existing parent chat (flow `continue_chat` or cross-machine) and
 * the startMode the turn actually opens in. Primary caller: `createChatForTask`.
 * Exported for focused tests with mocked cloud-client.
 *
 * `resume` is the continuation terminal-resume seed: its clamped startMode applies ONLY
 * when the pick lands on the exact sub-chat the mint-time gate validated — a sub-chat
 * minted in the mint→claim gap gets the CONFIGURED mode (same pin, same fallback, as the
 * prompt's `resolveClaimResume` gate; a stale live-mode clamp must not skip a plan gate).
 */
export async function resolveSubChatIdForExistingChat(params: {
  chatId: string;
  existingSubChatId: string | null;
  executionMode: string | null | undefined;
  startMode: ResolvedTaskStartMode;
  resume?: { pinnedSubChatId: string; startMode: ResolvedTaskStartMode };
}): Promise<{ subChatId: string; startMode: ResolvedTaskStartMode }> {
  const { chatId, existingSubChatId, executionMode, startMode, resume } = params;
  // Align the reused sub-chat's persisted mode (`sub-chat-mode-ownership`) to the turn's mode.
  const reuseWithTaskMode = async (
    subChatId: string,
  ): Promise<{ subChatId: string; startMode: ResolvedTaskStartMode }> => {
    const effectiveStartMode =
      resume && resume.pinnedSubChatId === subChatId ? resume.startMode : startMode;
    const mode = toChatMode(effectiveStartMode);
    await persistModeThenNotify(subChatId, mode, () =>
      sendSubChatModeChange({ chatId, subChatId, mode }),
    );
    return { subChatId, startMode: effectiveStartMode };
  };
  if (existingSubChatId) {
    return reuseWithTaskMode(existingSubChatId);
  }
  if (executionMode === 'continue_chat') {
    const existing = await getSubChatForChat(getDatabase(), chatId);
    if (existing) {
      log.info('[TaskExecutor] reusing the chat sub-chat for continue_chat', {
        subChatId: existing.id,
        chatId,
      });
      return reuseWithTaskMode(existing.id);
    }
  }
  const subChat = await createSubChat(getDatabase(), {
    chatId,
    name: 'Task Execution',
    mode: toChatMode(startMode),
    messages: '[]',
  });
  return { subChatId: subChat.id, startMode };
}

function parseTriggerContextOrNull(
  triggerContext: DbTask['triggerContext'],
): TriggerContext | null {
  return isValidTriggerContext(triggerContext) ? withTriggerContextDefaults(triggerContext) : null;
}

/**
 * Coerce trigger_context to a plain object for root-level fields (e.g. `baseBranches` from
 * flowTriggerContext spread in node-dispatch). Returns the full object — not only `_config`.
 */
function parseTriggerContextRootRecord(
  triggerContext: DbTask['triggerContext'],
): TaskResultRecord | undefined {
  const parsed = taskResultSchema.safeParse(triggerContext);
  return parsed.success ? parsed.data : undefined;
}

function extractTaskTriggerConfig(triggerContext: DbTask['triggerContext']) {
  return extractRawTriggerConfig(parseTriggerContextRootRecord(triggerContext));
}

function parseTriggerContext(task: DbTask): TriggerContext | null {
  return parseTriggerContextOrNull(task.triggerContext);
}

/**
 * `result.startMode` is the task's CURRENT mode; triggerContext._config keeps the ORIGINAL node
 * config. Result wins so a re-claim runs the task in the mode it actually holds — a resumed
 * question-park keeps its mode (a reply never flips it; decision `flow-agent-node-mode`).
 */
/** A persisted startMode value narrowed to the launchable modes ('wait' can't open a turn). */
function extractConfigStartMode(value: unknown): Exclude<TriggerStartMode, 'wait'> | null {
  return typeof value === 'string' &&
    value !== 'wait' &&
    TRIGGER_START_MODES.includes(value as TriggerStartMode)
    ? (value as Exclude<TriggerStartMode, 'wait'>)
    : null;
}

function extractResultStartMode(
  result: DbTask['result'],
): Exclude<TriggerStartMode, 'wait'> | null {
  const parsed = taskResultSchema.safeParse(result);
  return parsed.success ? extractConfigStartMode(parsed.data.startMode) : null;
}

export function resolveTaskExecutionOptions(task: DbTask): {
  startMode: Exclude<TriggerStartMode, 'wait'>;
  skipReview: boolean;
  configuredModel?: string;
} {
  const triggerContext = parseTriggerContext(task);
  // Fall back to raw _config extraction for non-webhook flow tasks (manual, schedule, post_task
  // triggers) whose trigger_context doesn't satisfy the full TriggerContext shape.
  const rawConfig = triggerContext?._config ?? extractTaskTriggerConfig(task.triggerContext);
  const metadata = resolveTaskExecutionMetadata(rawConfig, { throwOnWait: true });
  const skipReview = rawConfig != null ? metadata.skipReview : false;

  return {
    startMode: extractResultStartMode(task.result) ?? metadata.startMode,
    skipReview,
    ...(metadata.configuredModel ? { configuredModel: metadata.configuredModel } : {}),
  };
}

/**
 * Ensures trigger_worktree reuse requests always include a path.
 * Exported for unit tests.
 */
export function assertReuseWorktreeHasPath(
  reuseWorktree: boolean,
  worktreePath: string | null,
): void {
  if (reuseWorktree && !worktreePath) {
    const err = new Error('reuseWorktree requested but no worktreePath provided') as Error &
      DispatchErrorMeta;
    err.permanent = true;
    err.dispatchErrorCode = 'WORKTREE_UNAVAILABLE';
    err.dispatchErrorRemediation =
      'The task lost its worktree reference — restart the run from the beginning to re-provision it.';
    throw err;
  }
}

/**
 * Resolves the directory used for agent execution (project root, reused worktree, new worktree, or custom path).
 * Shared by continue_chat / existing-chatId and normal new-chat flows.
 */
async function resolveWorktreePathForTask(params: {
  projectPath: string;
  projectName: string | null | undefined;
  chatId: string;
  useWorktree: boolean;
  executionOverride: Record<string, unknown> | null;
  persistChatWorktreePath: (
    worktreePath: string,
    branch?: string,
    baseBranch?: string,
  ) => Promise<void>;
  reuseWorktreeErrorKind: 'flow' | 'trigger';
  warnWhenUseWorktreeWithoutReuseOverride?: boolean;
}): Promise<string> {
  const {
    projectPath,
    projectName,
    chatId,
    useWorktree,
    executionOverride,
    persistChatWorktreePath,
    reuseWorktreeErrorKind,
    warnWhenUseWorktreeWithoutReuseOverride,
  } = params;

  const reuseWorktree = executionOverride?.reuseWorktree === true;
  const overrideWorktreePath =
    typeof executionOverride?.worktreePath === 'string' ? executionOverride.worktreePath : null;
  const overrideBranch =
    typeof executionOverride?.branch === 'string' ? executionOverride.branch : undefined;
  const overrideBaseBranch =
    typeof executionOverride?.baseBranch === 'string' ? executionOverride.baseBranch : undefined;

  if (reuseWorktree) {
    assertReuseWorktreeHasPath(reuseWorktree, overrideWorktreePath);
    const path = overrideWorktreePath as string;
    const validation = await validateWorktreeForReuse(path);
    if (!validation.valid) {
      const suffix =
        reuseWorktreeErrorKind === 'flow'
          ? 'Worktree may be stale or from a different machine.'
          : `Use 'New task (isolated)' execution context, or resolve the worktree issue.`;
      const label = reuseWorktreeErrorKind === 'flow' ? 'flow worktree' : 'trigger worktree';
      const err = new Error(`Cannot reuse ${label}: ${validation.reason}. ${suffix}`) as Error &
        DispatchErrorMeta;
      err.permanent = validation.permanent;
      if (validation.permanent) {
        // Blocks the per-task Retry (assessTaskRetry) — re-dispatching into a gone worktree
        // fails identically; only a restart-from-beginning re-provisions it.
        err.dispatchErrorCode = 'WORKTREE_UNAVAILABLE';
        err.dispatchErrorRemediation =
          reuseWorktreeErrorKind === 'flow'
            ? 'The worktree for this run is no longer usable — restart the run from the beginning to re-provision it.'
            : `The trigger worktree is no longer usable — use 'New task (isolated)' or recreate the worktree.`;
      }
      throw err;
    }
    await persistChatWorktreePath(path, overrideBranch, overrideBaseBranch);
    return path;
  }

  if (useWorktree) {
    if (warnWhenUseWorktreeWithoutReuseOverride) {
      log.warn(
        '[TaskExecutor] continue_chat/cross-machine mode but no worktree override — creating fresh worktree (expected executionOverride from dispatchAgent)',
      );
    }
    try {
      const worktreeResult = await createWorktreeForChat(
        projectPath,
        sanitizeProjectName(projectName ?? 'project'),
        chatId,
      );
      if (worktreeResult.success && worktreeResult.worktreePath) {
        await persistChatWorktreePath(
          worktreeResult.worktreePath,
          worktreeResult.branch,
          worktreeResult.baseBranch,
        );
        return worktreeResult.worktreePath;
      }
      await persistChatWorktreePath(projectPath);
      return projectPath;
    } catch (err) {
      log.warn('[TaskExecutor] Worktree creation failed; persisting project path as fallback', {
        projectPath,
        chatId,
        error: err instanceof Error ? err.message : err,
      });
      await persistChatWorktreePath(projectPath);
      return projectPath;
    }
  }

  if (executionOverride?.customPath && typeof executionOverride.customPath === 'string') {
    await persistChatWorktreePath(executionOverride.customPath);
    return executionOverride.customPath;
  }

  await persistChatWorktreePath(projectPath);
  return projectPath;
}

export function resolveTaskStartInWorktree(task: DbTask): boolean {
  const triggerContext = parseTriggerContext(task);
  const rawConfig = triggerContext?._config ?? extractTaskTriggerConfig(task.triggerContext);
  return resolveTaskStartInWorktreeFromConfig(rawConfig, task.projectId);
}

/**
 * Build the prompt for a task
 *
 * NOTE: Claude Code has its own system prompt - we only add:
 * 1. Trigger context (if from external trigger) with UI marker
 * 2. Task description
 *
 * The project name is intentionally NOT prepended: Claude Code's own system prompt already carries
 * the working directory, and Frink's platform block / multi-project context establish the project —
 * a `**Project**: <name>` line in the message just duplicated that in every task turn.
 */
function buildTaskPrompt(task: DbTask): string {
  const parts: string[] = [];

  const triggerContext = parseTriggerContext(task);
  const rawConfig = extractTaskTriggerConfig(task.triggerContext);
  const showTriggerCardFromFlow = rawConfig?.showTriggerCard;

  // Trigger UI bubble only when flow agent opted in (showTriggerCard true) or flag absent (standalone webhook).
  // Flow tasks with showTriggerCard false omit the bubble — instructions do not reference {{trigger.*}}.
  if (triggerContext && showTriggerCardFromFlow !== false) {
    parts.push(buildTriggerBubbleMessage(buildTriggerSummary(triggerContext), triggerContext));
  }

  if (task.description) {
    parts.push(task.description);
  }

  return parts.join('\n\n');
}

/**
 * Continuation prompt for a retried failed attempt whose Claude session will be RESUMED
 * (sub_chats.session_id → SDK resume): the full task prompt would duplicate the context the
 * session already holds. Asks the agent to re-derive what remains rather than "continue where
 * you left off" — after session compaction the done/remaining split may be lost.
 */
function buildRetryContinuationPrompt(priorError: string | null): string {
  const stopLine = priorError
    ? `Your previous attempt stopped with an error: ${priorError}`
    : 'Your previous attempt stopped before finishing.';
  return `${stopLine}\n\nThe session has been resumed. Any tool call that never returned a result did NOT complete, and files it was writing may be half-applied. Re-read the original task requirements and your checklist/todo state, work out what remains, and continue from there. Finish with your task signal as usual.`;
}

/**
 * Create a chat linked to a task via cloud-client
 * Does NOT execute the task - that happens in the renderer
 *
 * Cross-machine support: If task.result already has chatId, use existing chat
 * (for chat-continuation tasks created from remote machines)
 */
async function createChatForTask(task: DbTask): Promise<{
  chatId: string;
  subChatId: string;
  prompt: string;
  projectPath: string | null;
  startMode: ResolvedTaskStartMode;
  skipReview: boolean;
  autoReviewTools?: boolean;
  codexFastMode?: boolean;
  model?: string;
  executionLeaseId: string;
  images: TaskChatImageAttachment[];
  /**
   * Renderer dedup-bypass flag (rides `task:chat-ready`): a user-requested retry OR a deliberate
   * flow re-dispatch — both legitimately re-send a prompt that already exists in the chat.
   */
  isRetry: boolean;
  /** True only for a user-requested tasks.retry claim (result.retryMode) — drives the unpark gate. */
  isUserRetryClaim: boolean;
}> {
  // Get project info (if task has a project)
  let projectPath: string | null = null;
  let projectName: string | null = null;
  let localProjectId: string | null = null;

  if (task.projectId) {
    const cloudProject = await getLocalProjectById(getDatabase(), task.projectId);
    if (cloudProject) {
      projectPath = cloudProject.path;
      projectName = cloudProject.name;
      const [localProject] = await getDatabase()
        .select()
        .from(projects)
        .where(eq(projects.path, cloudProject.path))
        .limit(1);
      localProjectId = localProject?.id ?? null;
    }

    // 2.5. Ensure project override account is authenticated on this machine (no silent fallback)
    // Project routing is keyed by LOCAL project id (not the cloud-side task.projectId),
    // so this only matches when localProjectId resolved successfully above.
    const projectAccount = localProjectId ? await getProjectAiAccount(localProjectId) : null;
    if (projectAccount) {
      const cred = await getClaudeCodeTokenById(projectAccount.id);
      // Codex resolves token-null (machine-local passthrough); its real auth gate is the
      // spawn-time detectCodexAccount() probe in handleRemoteExecute, which this Flow task
      // routes through after the chat is created. Mirror the chat path's acceptance here.
      if (!isResolvedCredential(cred)) {
        {
          // Action payload lets the renderer offer a "Connect account" CTA in the
          // notification (no manual hunt for Settings → Models).
          const err = new Error(
            `Account "${projectAccount.label ?? 'Unnamed account'}" is not authenticated on this machine. ` +
              `Please connect or authenticate it, then retry the task.`,
          );
          (err as Error & { action?: string; permanent?: boolean }).action = 'open-connect-account';
          (err as Error & { action?: string; permanent?: boolean }).permanent = true;
          throw err;
        }
      }
    }
  }

  let existingChatId: string | null = null;
  let existingSubChatId: string | null = null;
  let requestedModel: string | undefined;
  let taskModel: string | undefined;
  let activeModel: string | undefined;
  let modelFallbackReason: string | undefined;
  let retryMode: 'continue' | 'restart' | null = null;
  let retryPriorError: string | null = null;
  const parsedResult = taskClaimResultSchema.safeParse(task.result);
  if (parsedResult.success) {
    const result = parsedResult.data;
    if (result.chatId) {
      existingChatId = result.chatId;
      existingSubChatId = result.subChatId ?? null;
    }
    if (result.retryMode) {
      retryMode = result.retryMode;
      retryPriorError = result.retryPriorError ?? null;
    }
  }

  // Read execution overrides from flow trigger context (_config embedded by node-dispatch.ts)
  const rawFlowConfig = extractTaskTriggerConfig(task.triggerContext);
  const executionOverride = getFlowConfigField(rawFlowConfig, 'executionOverride', isRecord);
  const executionMode = getFlowConfigField(rawFlowConfig, 'executionMode', isString);
  const autoReviewTools = resolveFlowAutoReviewToolsForTask(task);
  const codexFastMode = resolveFlowCodexFastModeForTask(task);

  // continue_chat: reuse the originating chat instead of creating a new one
  if (executionMode === 'continue_chat' && !existingChatId) {
    const continueChatId = getFlowConfigField(rawFlowConfig, 'continueChatId', isString);
    if (continueChatId) {
      existingChatId = continueChatId;
    }
  }

  const executionOptions = resolveTaskExecutionOptions(task);
  const useWorktree = resolveTaskStartInWorktree(task);
  // Account-type resolution is keyed by LOCAL project id (project_ai_accounts is local).
  const executionAccountType = await resolveExecutionAccountTypeForTask(localProjectId);
  if (executionOptions.configuredModel) {
    requestedModel = executionOptions.configuredModel;
    taskModel = executionOptions.configuredModel;
  }
  if (taskModel) {
    if (!shouldForwardTaskModel(taskModel, executionAccountType)) {
      const providerLabel = PROVIDER_LABEL[executionAccountType];
      modelFallbackReason = `Configured model "${taskModel}" is not compatible with ${providerLabel} execution. Falling back to default ${providerLabel} model selection.`;
      // Codex forwards no model -> the executor's resolveCodexCliModel picks the default slug + effort.
      activeModel = 'account-default';
      taskModel = undefined;
    } else {
      activeModel = taskModel;
    }
  }

  let chatId: string;
  let subChatId: string;
  // The startMode the turn actually opens in — the continuation seed's clamped mode when the
  // claim lands on the pinned sub-chat, the configured mode otherwise (single decision inside
  // resolveSubChatIdForExistingChat; feeds the return value → dispatch registry + executor).
  let claimStartMode = executionOptions.startMode;
  const executionLeaseId = randomUUID();
  let executionProjectPath = projectPath;
  const persistChatWorktreePath = async (
    worktreePath: string,
    branch?: string,
    baseBranch?: string,
  ): Promise<void> => {
    try {
      await updateChat(getDatabase(), chatId, {
        worktreePath,
        ...(branch ? { branch } : {}),
        ...(baseBranch ? { baseBranch } : {}),
      });
    } catch (error) {
      // Keep execution flow even if chat metadata persistence fails.
      // biome-ignore lint/suspicious/noConsole: Non-fatal persistence issue should be visible for debugging
      console.warn('[TaskExecutor] Failed to persist chat worktree path', { chatId, error });
    }
  };

  if (existingChatId) {
    // Flow continue_chat path (start_task -> agent): dispatchAgent sets
    // executionMode='continue_chat' and passes the chatId dispatchStartTask created.
    chatId = existingChatId;

    const resumePinnedSubChatId = getFlowConfigField(rawFlowConfig, 'resumeSubChatId', isString);
    const resumeStartMode = extractConfigStartMode(
      getFlowConfigField(rawFlowConfig, 'resumeStartMode', isString),
    );
    const resolved = await resolveSubChatIdForExistingChat({
      chatId,
      existingSubChatId,
      executionMode,
      startMode: executionOptions.startMode,
      ...(resumePinnedSubChatId && resumeStartMode
        ? { resume: { pinnedSubChatId: resumePinnedSubChatId, startMode: resumeStartMode } }
        : {}),
    });
    subChatId = resolved.subChatId;
    claimStartMode = resolved.startMode;

    // Resolve worktree/project path — must run outside the existingSubChatId check so it
    // applies whether the sub-chat is new or reused.
    // validateWorktreeForReuse also acts as the safety net for cross-machine paths: if the
    // worktree path came from a remote machine and doesn't exist locally, validation will fail
    // with a descriptive error rather than silently executing in the wrong directory.
    if (projectPath && task.projectId) {
      executionProjectPath = await resolveWorktreePathForTask({
        projectPath,
        projectName,
        chatId,
        useWorktree,
        executionOverride,
        persistChatWorktreePath,
        reuseWorktreeErrorKind: 'flow',
        warnWhenUseWorktreeWithoutReuseOverride: true,
      });
    }
  } else {
    // Normal flow: Create new chat linked to task.
    // projectId uses localProjectId resolved above (cloud UUID → local path → local id).
    // Headless triggered flows where the project isn't registered locally yet produce a
    // general chat (projectId: null) — acceptable until 0.0.5 priority #1 (Localize projects).
    const chat = await createChat(getDatabase(), {
      projectId: localProjectId,
      taskId: task.id,
      name: buildInitialTaskChatName(task.description ?? ''),
      mode: toChatMode(executionOptions.startMode),
      worktreePath: useWorktree ? null : (projectPath ?? undefined),
    });
    chatId = chat.id;

    // Create empty sub-chat (messages will be added when prompt is sent)
    const subChat = await createSubChat(getDatabase(), {
      chatId,
      name: 'Task Execution',
      mode: toChatMode(executionOptions.startMode),
      messages: '[]',
    });
    subChatId = subChat.id;

    if (projectPath && task.projectId) {
      executionProjectPath = await resolveWorktreePathForTask({
        projectPath,
        projectName,
        chatId,
        useWorktree,
        executionOverride,
        persistChatWorktreePath,
        reuseWorktreeErrorKind: 'trigger',
      });
    }
  }

  // 5. Stamp chatId/subChatId (non-critical). Guarded so a Cancel landing mid-prep stays cancelled.
  try {
    const updatedTask = await updateTaskStatusLocal(getDatabase(), task.id, 'running', {
      result: {
        chatId,
        subChatId,
        executionLeaseId,
        // The CLAIM-time mode (continuation clamp applied on a pin match) — readers of the
        // persisted record (autoApprovePlan, a re-claim's extractResultStartMode) need the
        // mode the turn actually opens in, or a narrowed plan turn parks at plan_ready.
        startMode: claimStartMode,
        skipReview: executionOptions.skipReview,
        ...(requestedModel ? { requestedModel } : {}),
        ...(activeModel ? { activeModel } : {}),
        ...(modelFallbackReason ? { modelFallbackReason } : {}),
      },
      ...(task.executedBy ? { executedBy: task.executedBy } : {}),
      expectStatuses: ['running'],
    });
    if (!updatedTask) {
      log.info('[TaskExecutor] Task left running while being prepared; not dispatching', {
        taskId: task.id,
      });
    }
  } catch (error) {
    // Log but don't fail - chat was created successfully, proceed with execution
    // Failing here would orphan the chat on retry
    // biome-ignore lint/suspicious/noConsole: We don't want to fail the task if this fails
    console.error('[TaskExecutor] Failed to update task status with chatId:', error);
  }

  // 6. Build prompt and fetch attachment images
  const promptWarnings: string[] = [];
  const rawTc = parseTriggerContextRootRecord(task.triggerContext);
  const attachmentImages = await fetchAttachmentImages(rawTc?.attachments, promptWarnings);

  let prompt = buildTaskPrompt(task);
  // Session continuation (Carry on's continue-retry AND a continuation terminal-resume
  // dispatch): both gate on a resumable session existing, so the resumed session holds the
  // task context — send only the hidden continuation nudge, never a visible re-prompt. (If
  // the session goes stale between gate and claim, the executor's resume-failure fallback
  // restores context via history replay.)
  const claimResume = resolveClaimResume(retryMode, retryPriorError, rawFlowConfig, subChatId);
  if (claimResume.continueSession && existingChatId) {
    // Typed replies persisted by declined sends win over the synthetic nudge — the user's
    // own words (and pasted images) drive the resume. None trailing → the nudge. This is a
    // FRESH read at claim time: every reply a decline persisted up to here — the whole
    // queued-admission window included — rides the prompt. A send landing after this read
    // is not lost either: it sees this claim's freshly-minted DRIVING task, so it takes the
    // ordinary follow-up path and steers the live turn instead of needing this prompt.
    const subChatRow = await getSubChatById(getDatabase(), subChatId);
    const trailing = subChatRow ? extractTrailingUserReply(subChatRow.messages) : null;
    prompt = buildHiddenWakeMessage(
      trailing ? trailing.text : buildRetryContinuationPrompt(claimResume.priorError),
    );
    if (trailing && trailing.images.length > 0) attachmentImages.push(...trailing.images);
  }
  if (promptWarnings.length > 0) {
    prompt = `${prompt}\n\n${promptWarnings.join('\n')}`;
  }

  return {
    chatId,
    subChatId,
    prompt,
    projectPath: executionProjectPath,
    executionLeaseId,
    startMode: claimStartMode,
    skipReview: executionOptions.skipReview,
    images: attachmentImages,
    ...(autoReviewTools !== undefined ? { autoReviewTools } : {}),
    ...(codexFastMode !== undefined ? { codexFastMode } : {}),
    ...(taskModel ? { model: taskModel } : {}),
    ...deriveTaskClaimFlags(retryMode, rawFlowConfig),
  };
}

/**
 * Returns true when the task was created by the offline start_task fallback path
 * (Frink Cloud's updateStartTaskFallback sets executionMode: 'start_task').
 */
function isStartTaskFallbackMode(triggerContext: DbTask['triggerContext']): boolean {
  const raw = extractTaskTriggerConfig(triggerContext);
  return raw?.executionMode === 'start_task';
}

/**
 * Handle a start_task offline fallback task.
 *
 * When Socket.io dispatch is unavailable, node-dispatch.ts creates a DB task with
 * executionMode: 'start_task'. This function provisions the git worktree directly
 * (mirroring flow-step-executor.ts executeStartTask) and updates the flow chat row
 * so signal-bridge.ts can read worktree_path/branch/base_branch from the chats JOIN.
 *
 * Result is set to { configured: true } only — signal-bridge reads worktree info
 * from the chats table, not from task.result.
 */
async function executeStartTaskFallback(task: DbTask): Promise<void> {
  const raw = extractTaskTriggerConfig(task.triggerContext);

  const branch = typeof raw?.branch === 'string' ? raw.branch : undefined;
  const flowStartTaskChatId =
    typeof raw?.flowStartTaskChatId === 'string' ? raw.flowStartTaskChatId : null;

  // baseBranches/mergeStrategy live at trigger_context ROOT (spread from flowTriggerContext by
  // updateStartTaskFallback in node-dispatch.ts), not under ._config.
  const tc = parseTriggerContextRootRecord(task.triggerContext);
  const rawBaseList = tc?.baseBranches;
  const baseBranches =
    Array.isArray(rawBaseList) &&
    (rawBaseList as unknown[]).every(
      (b) => typeof b === 'string' && (b as string).trim().length > 0,
    )
      ? (rawBaseList as string[]).map((s) => s.trim())
      : undefined;

  log.info('[TaskExecutor] executeStartTaskFallback', {
    taskId: task.id,
    branch,
    baseBranches,
    flowStartTaskChatId,
  });

  let projectPath: string | undefined;
  let projectName: string | undefined;
  if (task.projectId) {
    const cloudProject = await getLocalProjectById(getDatabase(), task.projectId);
    if (cloudProject) {
      projectPath = cloudProject.path;
      projectName = cloudProject.name;
    }
  }

  if (!projectPath) {
    const errMsg = 'start_task fallback: no project path resolved';
    log.error(`[TaskExecutor] ${errMsg}`, { taskId: task.id });
    await updateTaskStatusLocal(getDatabase(), task.id, 'failed', { result: { error: errMsg } });
    return;
  }

  const sanitizedName = sanitizeProjectName(projectName ?? 'project');

  // Converging merge path: 2+ dependency branches
  if (baseBranches && baseBranches.length >= 2) {
    const mergeResult = await createWorktreeWithMergedBases(
      projectPath,
      sanitizedName,
      baseBranches as [string, string, ...string[]],
    );

    if (!mergeResult.success && 'conflict' in mergeResult) {
      log.info('[TaskExecutor] start_task fallback: merge conflict detected', {
        taskId: task.id,
        conflictingBranch: mergeResult.conflictingBranch,
        conflictedFiles: mergeResult.conflictedFiles,
      });
      // Update chat with what we have so far (worktree exists at this point)
      if (flowStartTaskChatId) {
        await updateChat(getDatabase(), flowStartTaskChatId, {
          worktreePath: mergeResult.worktreePath ?? null,
          branch: mergeResult.branch ?? null,
          baseBranch: mergeResult.baseBranch ?? null,
        });
      }
      // 'awaiting_input' is not a valid task status, so the flow-run pause signal rides in
      // result.agentSignal while the row itself stays 'needs_attention'.
      await updateTaskStatusLocal(getDatabase(), task.id, 'needs_attention', {
        result: {
          agentSignal: {
            state: 'awaiting_input',
            details: `Merge conflict in ${mergeResult.conflictingBranch}: ${mergeResult.conflictedFiles.join(', ')}`,
          },
          mergeConflict: true,
          conflictingBranch: mergeResult.conflictingBranch,
          conflictedFiles: mergeResult.conflictedFiles,
          mergedBranches: mergeResult.mergedBranches,
        },
      });
      return;
    }

    if (!mergeResult.success) {
      log.error('[TaskExecutor] start_task fallback: converging merge failed', {
        taskId: task.id,
        error: mergeResult.error,
      });
      await updateTaskStatusLocal(getDatabase(), task.id, 'failed', {
        result: { error: mergeResult.error },
      });
      return;
    }

    if (flowStartTaskChatId) {
      await updateChat(getDatabase(), flowStartTaskChatId, {
        worktreePath: mergeResult.worktreePath ?? null,
        branch: mergeResult.branch ?? null,
        baseBranch: mergeResult.baseBranch ?? null,
      });
    } else {
      log.warn(
        '[TaskExecutor] start_task fallback: no flowStartTaskChatId — worktree fields will not propagate to signal-bridge',
        { taskId: task.id },
      );
    }

    await updateTaskStatusLocal(getDatabase(), task.id, 'done', {
      result: {
        configured: true,
        exitCode: 0,
        mergedBranches: mergeResult.mergedBranches,
      },
    });

    log.info('[TaskExecutor] start_task fallback (converging merge): complete', {
      taskId: task.id,
      worktreePath: mergeResult.worktreePath,
      branch: mergeResult.branch,
      mergedBranches: mergeResult.mergedBranches,
    });
    return;
  }

  // Single-branch path (existing behaviour)
  const singleBranch = baseBranches && baseBranches.length === 1 ? baseBranches[0] : branch;

  const worktreeResult = await createWorktreeForBranch(projectPath, sanitizedName, singleBranch);

  if (!worktreeResult.success) {
    const errMsg = worktreeResult.error ?? 'Failed to create worktree';
    log.error('[TaskExecutor] start_task fallback: worktree creation failed', {
      taskId: task.id,
      error: errMsg,
    });
    await updateTaskStatusLocal(getDatabase(), task.id, 'failed', { result: { error: errMsg } });
    return;
  }

  // Update the chat so signal-bridge picks up worktreePath/branch/baseBranch via the chats JOIN
  if (flowStartTaskChatId) {
    await updateChat(getDatabase(), flowStartTaskChatId, {
      worktreePath: worktreeResult.worktreePath ?? null,
      branch: worktreeResult.branch ?? singleBranch ?? null,
      baseBranch: worktreeResult.baseBranch ?? null,
    });
  } else {
    log.warn(
      '[TaskExecutor] start_task fallback: no flowStartTaskChatId — worktree fields will not propagate to signal-bridge',
      { taskId: task.id },
    );
  }

  // Flow-linked anchor tasks stay 'running' despite this write; signal-bridge falls back to
  // readExitCode(result) for the node outcome when no agentSignal is present.
  await updateTaskStatusLocal(getDatabase(), task.id, 'done', {
    result: { configured: true, exitCode: 0 },
  });

  log.info('[TaskExecutor] start_task fallback: complete', {
    taskId: task.id,
    worktreePath: worktreeResult.worktreePath,
    branch: worktreeResult.branch ?? singleBranch,
  });
}

/**
 * Un-fail a retried flow task's node_run/flow_run so the watcher accepts the agent's next `done`
 * (a terminal run would discard it). Non-batch only — resumeFailedFlowInPlace refuses batch runs
 * whose stage-run wasn't pre-opened, deliberately-cancelled runs (no restart marker), fan-out
 * lanes. Returns whether the run is now accepting the agent's `done`: on `false` the caller must
 * NOT dispatch — the turn would stream into a terminal run and stall silently. Never throws.
 */
async function unparkRetriedFlowRun(taskId: string, flowRunId: string): Promise<boolean> {
  try {
    const { resumeFailedFlowInPlace } = await import('../flows/resume');
    const resumed = await resumeFailedFlowInPlace(flowRunId, taskId);
    if (!resumed) {
      log.warn('[TaskExecutor] resumeFailedFlowInPlace did not unpark the flow run', {
        taskId,
        flowRunId,
      });
    }
    return resumed;
  } catch (error) {
    log.warn('[TaskExecutor] resumeFailedFlowInPlace failed', {
      taskId,
      flowRunId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Handle a claimed task - create chat and notify renderer
 * Task stays 'running' - renderer will update status when done
 */
async function handleClaimedTask(task: DbTask): Promise<void> {
  /** Set when {@link setActiveFlowTaskForChat} runs; cleared on success so catch can remove stale overrides. */
  let flowContinuationChatRegistered: string | null = null;
  try {
    if (isShellExecutionMode(task.triggerContext)) {
      await executeShellTask(task);
      return;
    }

    if (isStartTaskFallbackMode(task.triggerContext)) {
      await executeStartTaskFallback(task);
      return;
    }

    // Create chat linked to task
    const {
      chatId,
      subChatId,
      prompt,
      projectPath,
      startMode,
      skipReview,
      autoReviewTools,
      codexFastMode,
      model,
      executionLeaseId,
      images,
      isRetry,
      isUserRetryClaim,
    } = await createChatForTask(task);
    // Cancelled while being prepared: there was no session to abort, so don't start one.
    if ((await getTaskById(getDatabase(), task.id))?.status !== 'running') return;

    // Unpark keys on the tasks.retry claim ONLY — a deliberate re-dispatch (isRetry may be true)
    // has already flipped its run back to `running` before dispatch, so unparking would refuse
    // and wrongly fail the freshly re-dispatched task.
    if (isUserRetryClaim && task.flowRunId) {
      const unparked = await unparkRetriedFlowRun(task.id, task.flowRunId);
      if (!unparked) {
        // The run refused to reopen (already advanced, deliberately cancelled, batch stage not
        // pre-opened…). Dispatching anyway would stream a turn whose `done` the watcher drops —
        // a silent stall. Fail the task loud instead; the user can retry once the cause clears.
        await updateTaskStatusLocal(getDatabase(), task.id, 'failed', {
          result: {
            ...parseResultRecord(task.result),
            error: 'Retry could not reopen the flow run — it may have advanced or been cancelled.',
          },
        });
        return;
      }
    }

    // For flow continuation tasks, the chat's task_id in the DB still points to the first task.
    // Register the correct task_id so the executor (handleRemoteExecute) can override the stale value.
    const claimedConfig = extractTaskTriggerConfig(task.triggerContext);
    if (getFlowConfigField(claimedConfig, 'executionMode', isString) === 'continue_chat') {
      setActiveFlowTaskForChat(chatId, task.id);
      flowContinuationChatRegistered = chatId;
      log.info('[TaskExecutor] Registered flow continuation task in active map', {
        chatId,
        taskId: task.id,
      });
    }

    // Bind this prompt's send-time mode to the task, immune to renderer mode-state races.
    registerPendingDispatchMode(subChatId, task.id, startMode);

    // Emit IPC event to renderer to open chat and auto-send
    const payload: TaskChatReadyPayload = {
      chatId,
      subChatId,
      taskId: task.id,
      prompt,
      projectId: task.projectId ?? null,
      projectPath,
      startMode,
      skipReview,
      // Flow tasks run headless (no focus-steal); non-flow work-queue tasks navigate as before.
      headless: Boolean(task.flowRunId),
      executionLeaseId,
      ...(autoReviewTools !== undefined ? { autoReviewTools } : {}),
      ...(codexFastMode !== undefined ? { codexFastMode } : {}),
      ...(model ? { model } : {}),
      ...(images && images.length > 0 ? { images } : {}),
      ...(isRetry ? { isRetry: true } : {}),
    };

    log.info('[TaskExecutor] dispatching task:chat-ready to renderer', {
      taskId: task.id,
      chatId,
      subChatId,
      projectPath,
      startMode,
    });

    // Send to all windows (in case app has multiple)
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('task:chat-ready', payload);
      }
    }

    flowContinuationChatRegistered = null;

    // Task stays in 'running' status - renderer will update when done
  } catch (error) {
    if (flowContinuationChatRegistered) {
      clearActiveFlowTaskForChat(flowContinuationChatRegistered);
    }
    await persistDispatchFailure(getDatabase(), task, error);
  }
}

/**
 * Initialize the task executor
 * Connects to TaskPoller events
 */
export function initTaskExecutor(): void {
  const poller = getTaskPoller();

  // Listen for claimed tasks
  poller.on('task:claimed', (task: DbTask) => {
    // Create chat and notify renderer asynchronously
    handleClaimedTask(task).catch((_error) => {
      // Silent fail - task will retry if needed
    });
  });
}

export {
  buildRetryContinuationPrompt,
  buildTaskPrompt,
  handleClaimedTask,
  isStartTaskFallbackMode,
};
