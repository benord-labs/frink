import { setTimeout as sleep } from 'node:timers/promises';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import log from 'electron-log';
import type { ChatMode } from '../../../../../shared/types/chat-mode';
import type { ExecutionSettings } from '../../../../../shared/types/execution';
import { getBundledClaudeBinaryPath } from '../../../claude';
import { isValidSubChatIdForSessionPaths } from '../../../claude/session-plan-paths';
import { claudeErrorText } from '../../../claude/stream-classifiers';
import { getClaudeCodeTokenById, isResolvedCredential } from '../../../credentials';
import { getDatabase } from '../../../db';
import { getChatWithProjectAccount } from '../../../db/repos/chats';
import { getProjectById } from '../../../db/repos/projects';
import { getSubChatById } from '../../../db/repos/sub-chats';
import { getLatestFlowTaskForSubChat } from '../../../db/repos/tasks';
import {
  prewarmBlocker,
  queuePrewarm,
  retainSession,
  runPrewarm,
  takeQueuedPrewarm,
} from '../../claude-session-registry';
import { hasWakeHold } from '../../claude-wake-hold';
import { executionAbortSources } from '../../executor';
import { getActiveExecution } from '../../streaming/execution-registry';
import { validateToolPermission } from '../../streaming/pending-permission/validate-tool-permission';
import { isAutoReviewSupported, resolveAutoReviewModes } from '../../streaming/plan-auto-approve';
import { resolveChatWorkspace } from '../chat-workspace';
import { computeClaudeSessionKey } from './session-key';
import { buildClaudeSessionSpec, prepareClaudeSpawn, spawnClaudeSession } from './session-spec';

type PrewarmRequest = {
  chatId: string;
  subChatId: string;
  /** The send's pending mode intent; absent, the sub-chat row's mode, as a send resolves it. */
  mode?: ChatMode;
  settings?: ExecutionSettings;
};

/** How long the app's one pre-warm waits for its CLI's MCP servers to connect. */
const PREWARM_START_TIMEOUT_MS = 60_000;
/** How often the pre-warm in flight asks its CLI whether an MCP server is still connecting. */
const MCP_STATUS_POLL_MS = 250;

/**
 * Spawn the opened chat's Claude CLI before its send and keep it idle, so turn 1 skips the CLI
 * and MCP startup: the send claims it when it asks for the same spawn. Ordinary Claude chats only;
 * resolves to the logged outcome.
 */
export async function prewarmClaudeSession(request: PrewarmRequest): Promise<string> {
  const { subChatId } = request;
  const blocked =
    (!isValidSubChatIdForSessionPaths(subChatId) && 'invalid-id') ||
    (request.mode === 'debug' && 'debug') ||
    (getActiveExecution(subChatId) && 'active-execution') ||
    (hasWakeHold(subChatId) && 'held') ||
    prewarmBlocker(subChatId);
  if (blocked === 'in-flight') queuePrewarm(subChatId, () => prewarmClaudeSession(request));
  const outcome = blocked
    ? `skipped:${blocked}`
    : await runPrewarm(subChatId, (spawned) => spawnPrewarm(request, spawned));
  log.info(`[Claude Session] prewarm sub=${subChatId} outcome=${outcome}`);
  if (!blocked) await takeQueuedPrewarm()?.();
  return outcome;
}

/** Spawn and retain the chat's CLI with the spec its send would build, resolving once its MCP
 * servers have connected: browsing chats starts one CLI's MCP servers at a time. */
async function spawnPrewarm(request: PrewarmRequest, spawned: () => void): Promise<string> {
  const inputsReadAt = new Date().toISOString();
  try {
    const spec = await buildPrewarmSpec(request);
    if (typeof spec === 'string') return `skipped:${spec}`;
    await prepareClaudeSpawn(spec);
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const keyParts = computeClaudeSessionKey(spec.options, spec.mcpServers, spec.login);
    await spec.mcpConfig?.stage();
    let started: Promise<unknown> = Promise.resolve();
    let connected: Promise<void> = Promise.resolve();
    try {
      const session = spawnClaudeSession(spec, spec.options, keyParts, query, inputsReadAt);
      started = session.query.initializationResult().catch(() => {});
      connected = mcpServersSettled(session.query);
      retainSession(session, { prewarm: true });
    } finally {
      // The CLI has read its MCP config once it answers `initialize`: no frame comes before a send.
      void started.finally(() => spec.mcpConfig?.clear());
    }
    spawned();
    await connected;
    return 'spawned';
  } catch (err) {
    log.warn(`[Claude Session] prewarm sub=${request.subChatId} failed:`, claudeErrorText(err));
    return 'failed';
  }
}

/** Resolves once none of the CLI's MCP servers is still connecting, the CLI is closed, or the
 * start bound runs out. */
async function mcpServersSettled(query: Query): Promise<void> {
  const timedOut = sleep(PREWARM_START_TIMEOUT_MS, [], { ref: false });
  for (;;) {
    const servers = await Promise.race([query.mcpServerStatus(), timedOut]).catch(() => []);
    if (!servers.some(({ status }) => status === 'pending')) return;
    await sleep(MCP_STATUS_POLL_MS, undefined, { ref: false });
  }
}

/** The spec the chat's next send would spawn with, or why the chat is not pre-warmed. */
async function buildPrewarmSpec({ chatId, subChatId, mode: intent, settings }: PrewarmRequest) {
  const db = getDatabase();
  const [owner, subChat] = await Promise.all([
    getChatWithProjectAccount(db, chatId),
    getSubChatById(db, subChatId),
  ]);
  const chat = owner?.chat;
  if (!chat || subChat?.chatId !== chatId || chat.archivedAt) return 'closed';
  // A chat whose login was removed waits for the user's retry, never a default login.
  if (!owner.account) return 'login-removed';
  const credential = await getClaudeCodeTokenById(owner.account.id);
  if (!isResolvedCredential(credential) || credential.type === 'codex') return 'not-claude';
  if (chat.taskId || (await getLatestFlowTaskForSubChat(db, subChatId))) return 'task-linked';
  const mode = intent ?? (subChat.mode as ChatMode);
  if (mode === 'debug') return 'debug';
  const project = chat.projectId ? await getProjectById(db, chat.projectId) : null;
  if (chat.projectId && !project) return 'closed';
  const workspace = await resolveChatWorkspace(project, chat, mode);
  const autoReview = isAutoReviewSupported(settings, credential.type);
  const { nativeAutoReview, planAutoReview } = resolveAutoReviewModes(autoReview, 'claude', mode);
  return buildClaudeSessionSpec({
    chatId,
    subChatId,
    project,
    projectId: chat.projectId ?? '',
    projectPath: workspace.projectPath,
    permissionProjectPath: workspace.permissionProjectPath,
    mode,
    settings,
    storedCredential: credential,
    nativeAutoReview,
    planAutoReview,
    persistedSessionId: subChat.sessionId || undefined,
    claudeBinaryPath: getBundledClaudeBinaryPath(),
    dynamicChatMcpUrl: workspace.dynamicChatMcpUrl,
    multiProjectPrefix: workspace.multiProjectPrefix,
    sessionFlowBriefing: '',
    signalTaskId: null,
    isFlowExecutionTurn: false,
    flowPlanAutoApprove: false,
    validateToolPermission,
    abortSources: executionAbortSources,
  });
}
