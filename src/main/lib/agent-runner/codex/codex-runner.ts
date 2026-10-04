/**
 * Codex app-server agent runner.
 *
 * Codex runs as a PERSISTENT app-server process speaking JSON-RPC, which lets Frink bind
 * codex's privileged tool requests to Frink's permission gate in every review mode.
 *
 * Flow per turn:
 *  1. get/spawn the app-server for this (cwd, credentialId) with MCP config baked in.
 *  2. thread/start an EPHEMERAL thread (or reuse the live one when resumeThreadId is set), with
 *     approvalPolicy on-request so the server ASKS the host on each action. Ephemeral threads are
 *     never written to ~/.codex, so Frink chats stay out of the user's own Codex app.
 *  3. register the host permission handler -> params.checkApproval.
 *  4. turn/start with the prompt; yield mapped UIMessageChunks from
 *     notifications until turn/completed.
 *  5. surface the thread id via message-metadata.sessionId for resume; wire
 *     abort -> turn/interrupt + dispose.
 *
 * The provider callback runs before every execution sink. `on-request` remains
 * available for stronger retries and Auto-review residuals.
 */

import log from 'electron-log';
import type {
  CodexReasoningEffort,
  CodexServiceTier,
} from '../../../../shared/lib/codex-cli-models';
import type { ChatMode } from '../../../../shared/types/chat-mode';
import { createThinkingEmitter, type ThinkingEmitter } from '../../claude/thinking-emitter';
import type { UIMessageChunk } from '../../claude/types';
import { recordCodexTurnStart } from '../../diagnostics/provider-topology';
import type { CodexAppServerClient, CodexThreadSubscription } from './app-server-client';
import { getCodexAppServer } from './app-server-registry';
import { ChunkQueue } from './chunk-queue';
import { type CodexApprovalCheck, registerApprovalHandlers } from './codex-approvals';
import { getCodexCliMissingMessage, resolveCodexBinary } from './codex-binary';
import { extractFileChangeItem, type FileChange, mapNotificationToChunks } from './codex-events';
import { type CodexCommandOutputs, recordCodexCommandOutput } from './command-output';
import { setCodexLiveTurn } from './codex-live-turn';
import { completeTurnChunks, makeChunkSink } from './codex-stream-chunks';
import { buildCodexMcpBinding } from './mcp';
import { buildCodexSkillRootsBinding } from './skill-roots';
import {
  type CodexTurnIdentity,
  clearCodexTurnState,
  createCodexAbortHandler,
  drainCodexTurnChunks,
} from './permissions';
import { buildSpawnArgs } from './spawn-args';
import {
  codexMessageContext,
  type MessageProvenance,
} from '../../../../shared/lib/message-markers/message-provenance';
import * as provenanceRule from './provenance-rule';

/**
 * Approval policy that makes the server ask the host on each privileged action.
 * Wire value is kebab-case (AskForApproval serde rename in v2/shared.rs).
 */
export const CODEX_APPROVAL_POLICY = 'on-request' as const;

/** Sandbox mode for codex turns. Wire value is kebab-case (SandboxMode in v2/shared.rs). */
export const CODEX_SANDBOX_MODE = 'workspace-write' as const;

/** Protocol reviewers. Auto review changes the reviewer, not the sandbox. */
export const CODEX_USER_REVIEWER = 'user' as const;
export const CODEX_AUTO_REVIEWER = 'auto_review' as const;

/** Streaming notification methods the runner subscribes to and maps to chunks. */
const STREAM_METHODS = [
  'item/agentMessage/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/plan/delta',
  'item/commandExecution/outputDelta',
  'item/started',
  'item/completed',
  'thread/tokenUsage/updated',
  'turn/started',
  'turn/completed',
  'error',
] as const;

const resumableThreadsByClient = new WeakMap<CodexAppServerClient, Set<string>>();
export type CodexRunnerParams = {
  messageProvenance?: MessageProvenance;
  prompt: string;
  /** Prompt used only when a missing resumed thread is recoverably replaced by a fresh thread. */
  freshThreadFallbackPrompt?: string;
  cwd: string;
  /** Stable credential id -- part of the app-server registry key. */
  credentialId: string;
  /** Scopes app-server reuse to one caller (the sub-chat). Required whenever `configArgs` carry
   * caller-specific identity -- a shared server would serve another chat's baked-in MCP URL. */
  sessionKey?: string;
  env: Record<string, string>;
  abortController: AbortController;
  mode?: ChatMode;
  model?: string;
  /** Reasoning effort for this turn; sent as the `effort` field on turn/start ONLY (turn-scoped). */
  effort?: CodexReasoningEffort;
  /**
   * "Fast" service tier. `'priority'` requests it; `null` (or omitted) explicitly clears it —
   * see the thread-stickiness note in {@link startTurn}. Resolved by `resolveCodexCliModel`.
   */
  serviceTier?: CodexServiceTier;
  /** Live codex thread id to continue (only honoured while this app-server process holds it). */
  resumeThreadId?: string;
  /** Per-project MCP + config args passed to the spawned app-server (loaded once at startup). */
  configArgs?: string[];
  /** Frink's project-filtered canonical MCP definitions. */
  canonicalMcpServers?: Record<string, unknown>;
  /** Install the native Stop guard for a live Frink task. */
  taskSignalEnabled?: boolean;
  /** MCP-specific stdio environment, excluding the inherited process environment. */
  canonicalMcpEnvByServer?: Record<string, Record<string, string>>;
  /** Request-scoped Codex config prepared after native MCP inspection. */
  threadConfig?: Record<string, unknown>;
  /** Non-secret digest that supersedes a warm app-server when effective MCP state changes. */
  configRevision?: string;
  /** The downstream Frink permission gate is waiting on this turn's user. */
  hasOpenPermission?: () => boolean;
  /** Delegate eligible approval requests to Codex's provider-owned AI reviewer. */
  autoReview?: boolean;
  /** Frink's permission gate; see {@link CodexApprovalCheck}. */
  checkApproval: CodexApprovalCheck;
};

type ThreadStartResponse = { thread?: { id?: string } };
type TurnStartResponse = { turn?: { id?: string } };

/**
 * Notification trace (off by default): the one channel that shows whether codex
 * actually emits reasoning deltas for a given model/effort/account. Logs the
 * method + item.type so a single reproduce answers "is reasoning even streamed?".
 */
function traceNotification(method: string, raw: unknown): void {
  if (!process.env.DEBUG_CODEX_APP_SERVER) return;
  const itemType = (raw as { item?: { type?: unknown } }).item?.type;
  log.info(`[Codex notif] ${method}${itemType ? ` item.type=${itemType}` : ''}`);
}

/** Wire the streaming notifications into the queue on the turn's thread subscription. */
function registerStreamHandlers(
  sub: CodexThreadSubscription,
  queue: ChunkQueue,
  onChunk: (chunk: UIMessageChunk) => void,
  fileChangeCache: Map<string, FileChange[]>,
  commandOutputs: CodexCommandOutputs,
  onCompaction: () => void,
): void {
  for (const method of STREAM_METHODS) {
    sub.onNotification(method, (raw) => {
      traceNotification(method, raw);
      if (method === 'item/completed' && provenanceRule.compaction.safeParse(raw).success)
        onCompaction();
      // Before the chunks, so the command's card already has output to read when it mounts.
      recordCodexCommandOutput(commandOutputs, method, raw);
      // Cache the per-file paths off the fileChange item so the matching approval
      // request (which carries only itemId + grantRoot) can gate on real paths.
      if (method === 'item/started') {
        const fileChange = extractFileChangeItem(raw);
        if (fileChange) fileChangeCache.set(fileChange.itemId, fileChange.changes);
      }
      const willRetry = method === 'error' && (raw as { willRetry?: boolean }).willRetry === true;
      // A transient (willRetry) error is auto-retried server-side: don't surface
      // a scary error chunk and don't end Frink's stream early.
      if (!willRetry) for (const chunk of mapNotificationToChunks(method, raw)) onChunk(chunk);
      if (method === 'turn/completed' || (method === 'error' && !willRetry)) queue.finish();
    });
  }
}

/**
 * Wire connection-level close/error into the queue. These stay on the CLIENT (not the
 * thread subscription): vscode-jsonrpc Events are multi-listener, so every concurrent
 * turn on a shared client sees the same crash. Returns their disposers.
 */
function registerCloseHandlers(
  client: CodexAppServerClient,
  queue: ChunkQueue,
): Array<{ dispose: () => void }> {
  return [
    // A crash sends no turn/completed → surface it + end the turn so the generator can't
    // hang holding a runtime slot (the registry evicts the dead client on the same close).
    client.onClose(() => {
      queue.push({ type: 'error', errorText: 'Codex app-server connection closed unexpectedly.' });
      queue.finish();
    }),
    // A transport write/handler error may NOT close the connection (broken stdin pipe) — end anyway.
    client.onError((err) => {
      const detail = Array.isArray(err) && err[0] instanceof Error ? `: ${err[0].message}` : '';
      queue.push({ type: 'error', errorText: `Codex app-server transport error${detail}.` });
      queue.finish();
    }),
  ];
}

/** Start a fresh thread with the host-ask policy. Returns its id. */
async function startFreshThread(
  client: CodexAppServerClient,
  params: CodexRunnerParams,
): Promise<string> {
  const { cwd, model } = params;
  const developerInstructions = await provenanceRule.developerInstructions(client, params);
  const started = await client.sendRequest<ThreadStartResponse>('thread/start', {
    cwd,
    ...(model && { model }),
    // Keep Frink's threads in memory only: a durable thread writes a rollout + state row into
    // ~/.codex, which the user's own Codex app lists as one of their chats.
    ephemeral: true,
    ...(developerInstructions && { developerInstructions }),
    approvalPolicy: CODEX_APPROVAL_POLICY,
    sandbox: CODEX_SANDBOX_MODE,
    approvalsReviewer: params.autoReview ? CODEX_AUTO_REVIEWER : CODEX_USER_REVIEWER,
    ...(params.threadConfig && { config: params.threadConfig }),
  });
  const threadId = started.thread?.id;
  if (!threadId) throw new Error('Codex did not return a thread id');
  if (developerInstructions) provenanceRule.markDurable(client, threadId);
  return threadId;
}

/** Start the turn with the prompt; returns its turn id. */
async function startTurn(
  client: CodexAppServerClient,
  params: CodexRunnerParams,
  threadId: string,
  prompt: string,
): Promise<string> {
  const { model, effort, serviceTier } = params;
  const rule = provenanceRule.beginTurn(client, threadId, Boolean(params.messageProvenance));
  const turn = await client.sendRequest<TurnStartResponse>('turn/start', {
    threadId,
    input: [{ type: 'text', text: prompt }],
    ...(params.messageProvenance && {
      additionalContext: codexMessageContext(params.messageProvenance, rule.carriesRule),
    }),
    ...(model && { model }),
    // effort + serviceTier live on TurnStartParams, not on thread/start|resume (v2 protocol).
    ...(effort && { effort }),
    // Explicit on every turn, NEVER conditionally spread: the app-server persists the tier on the
    // thread (ThreadSettings.serviceTier) and documents this field as applying to "this turn and
    // subsequent turns", so omitting it means "leave unchanged" — which would keep charging the
    // priority multiplier after the user switches Fast off. `?? null` makes a caller that omits
    // the field mean OFF rather than "inherit whatever the thread already had".
    serviceTier: serviceTier ?? null,
    approvalPolicy: CODEX_APPROVAL_POLICY,
    // Explicit on every turn: app-server threads persist, so omitting this can
    // leak the previous turn's reviewer after Auto Mode is toggled.
    approvalsReviewer: params.autoReview ? CODEX_AUTO_REVIEWER : CODEX_USER_REVIEWER,
  });
  recordCodexTurnStart();
  const turnId = turn.turn?.id;
  if (!turnId) throw new Error('Codex did not return a turn id');
  // Settled only once the turn really started, so a failed start retries the rule.
  rule.settle();
  return turnId;
}

export function isRecoverableCodexThreadResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes('thread')) return false;
  return ['not found', 'missing thread', 'no such thread', 'unknown thread', 'does not exist'].some(
    (snippet) => message.includes(snippet),
  );
}

/**
 * A live thread is still loaded in this app-server, so it takes turn/start directly: ephemeral
 * threads have no rollout, and thread/resume on one fails ("no rollout found"). If the live thread
 * has vanished, start a fresh one seeded with the fallback prompt.
 */
async function openTurn(
  client: CodexAppServerClient,
  params: CodexRunnerParams,
  queue: ChunkQueue,
  openTextIds: Set<string>,
  thinking: ThinkingEmitter,
  fileChangeCache: Map<string, FileChange[]>,
  commandOutputs: CodexCommandOutputs,
): Promise<{
  threadId: string;
  turnId: string;
  sub: CodexThreadSubscription;
  hasOpenApproval: () => boolean;
}> {
  // Scoped to this ONE turn, so it cannot outlive it or be seen by the next turn on the same
  // sub-chat. A count, not a flag: a command and a file-change approval can be open at once, and
  // the first answer must not unpark the turn while the other still waits on a human.
  let openApprovals = 0;
  const register = (s: CodexThreadSubscription, threadId: string) => {
    // Wrapped so the steer gate can see a turn parked on a human decision: codex approvals never
    // reach Claude's pendingToolApprovals, so without this the gate would have nothing to read.
    const gatedCheckApproval: CodexApprovalCheck = async (request) => {
      openApprovals += 1;
      try {
        return await params.checkApproval(request);
      } finally {
        openApprovals -= 1;
      }
    };
    registerApprovalHandlers(s, gatedCheckApproval, fileChangeCache);
    registerStreamHandlers(
      s,
      queue,
      makeChunkSink(queue, openTextIds, thinking),
      fileChangeCache,
      commandOutputs,
      () => provenanceRule.forgetOnCompaction(client, threadId),
    );
  };
  const openOn = async (threadId: string, prompt: string) => {
    const sub = client.forThread(threadId);
    register(sub, threadId);
    sub.expectTurnStart();
    try {
      const turnId = await startTurn(client, params, threadId, prompt);
      // Bind the turn so a same-thread concurrent turn (one conversation in two panes)
      // can't cross-deliver: the router now filters this subscription to this turn id.
      sub.bindTurn(turnId);
      return { threadId, turnId, sub };
    } catch (error) {
      sub.dispose();
      throw error;
    }
  };
  const hasOpenApproval = () => openApprovals > 0 || params.hasOpenPermission?.() === true;
  if (params.resumeThreadId) {
    try {
      return { ...(await openOn(params.resumeThreadId, params.prompt)), hasOpenApproval };
    } catch (error) {
      if (
        params.abortController.signal.aborted ||
        params.freshThreadFallbackPrompt === undefined ||
        !isRecoverableCodexThreadResumeError(error)
      ) {
        throw error;
      }
      log.warn(`[Codex app-server] live thread ${params.resumeThreadId} is gone; starting fresh`);
    }
  }
  const prompt = params.resumeThreadId ? params.freshThreadFallbackPrompt : undefined;
  const threadId = await startFreshThread(client, params);
  return { ...(await openOn(threadId, prompt ?? params.prompt)), hasOpenApproval };
}

/** Dispose every handler subscription, swallowing individual dispose errors. */
function disposeAll(disposers: Array<{ dispose: () => void }>): void {
  for (const d of disposers) {
    try {
      d.dispose();
    } catch {
      // ignore
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run a single codex turn against a persistent app-server and stream UI chunks. */
export async function* runCodexAgent(
  params: CodexRunnerParams,
): AsyncGenerator<UIMessageChunk, void, undefined> {
  const { cwd, credentialId, abortController } = params;

  const binary = resolveCodexBinary();
  if (!binary) {
    yield { type: 'error', errorText: getCodexCliMissingMessage() };
    yield { type: 'finish' };
    return;
  }

  yield { type: 'start' };

  const skillRoots = buildCodexSkillRootsBinding();
  let runtimeParams: CodexRunnerParams;
  try {
    const binding = buildCodexMcpBinding({
      canonicalServers: params.canonicalMcpServers ?? {},
      envByServer: params.canonicalMcpEnvByServer,
      taskSignalEnabled: params.taskSignalEnabled,
    });
    runtimeParams = {
      ...params,
      threadConfig: binding.threadConfig,
      configRevision: `${binding.revision}:${skillRoots.revision}`,
    };
  } catch (err) {
    yield { type: 'error', errorText: errorText(err) };
    yield { type: 'finish' };
    return;
  }

  let client: CodexAppServerClient;
  try {
    client = await getCodexAppServer(
      cwd,
      credentialId,
      {
        binary,
        args: buildSpawnArgs(runtimeParams.configArgs),
        cwd,
        env: runtimeParams.env,
        clientInfo: { name: 'frink', version: '0.0.8' },
        extraSkillRoots: skillRoots.extraSkillRoots,
      },
      runtimeParams.sessionKey,
      runtimeParams.configRevision,
    );
  } catch (err) {
    yield { type: 'error', errorText: errorText(err) };
    yield { type: 'finish' };
    return;
  }

  const knownThreads = resumableThreadsByClient.get(client);
  if (runtimeParams.resumeThreadId && !knownThreads?.has(runtimeParams.resumeThreadId)) {
    runtimeParams = {
      ...runtimeParams,
      prompt: runtimeParams.freshThreadFallbackPrompt ?? runtimeParams.prompt,
      resumeThreadId: undefined,
    };
  }

  const queue = new ChunkQueue();
  const openTextIds = new Set<string>();
  // Per-turn thinking accumulator: codex reasoning streams into the same live
  // "Thinking" tool card as Claude (shared emitter) instead of being dropped.
  const thinking = createThinkingEmitter();
  // Per-turn (generator-local) cache of fileChange paths for approval gating; fresh
  // per invocation, so a resumed thread never reads stale paths from a prior turn.
  const fileChangeCache = new Map<string, FileChange[]>();
  // Per-turn too: published on the live turn below, so it goes when the turn does.
  const commandOutputs: CodexCommandOutputs = new Map();
  // Connection-level close/error are multi-listener: register up front so a crash
  // ends THIS turn even if the thread subscription isn't wired yet.
  const closeDisposers = registerCloseHandlers(client, queue);

  const identity: CodexTurnIdentity = {};
  let persistedSessionId: string | undefined;
  let sub: CodexThreadSubscription | undefined;
  const onAbort = createCodexAbortHandler(runtimeParams, client, queue, identity);
  abortController.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const opened = await openTurn(
      client,
      runtimeParams,
      queue,
      openTextIds,
      thinking,
      fileChangeCache,
      commandOutputs,
    );
    identity.threadId = opened.threadId;
    identity.turnId = opened.turnId;
    persistedSessionId = opened.threadId;
    const clientThreads = knownThreads ?? new Set<string>();
    clientThreads.add(opened.threadId);
    if (!knownThreads) resumableThreadsByClient.set(client, clientThreads);
    sub = opened.sub;

    // Publish the ids so a steer arriving from outside this generator can find the live turn.
    // sessionKey IS the sub-chat id (executor.ts passes `sessionKey: subChatId`).
    setCodexLiveTurn(runtimeParams.sessionKey, {
      client,
      threadId: opened.threadId,
      turnId: opened.turnId,
      pushChunk: (chunk) => queue.push(chunk),
      hasOpenApproval: opened.hasOpenApproval,
      hasFlowProvenance: Boolean(runtimeParams.messageProvenance),
      commandOutputs,
    });

    // Surface the thread id as the resumable session id.
    yield { type: 'message-metadata', messageMetadata: { sessionId: persistedSessionId } };
    yield* drainCodexTurnChunks(queue, abortController.signal);
  } catch (err) {
    if (!abortController.signal.aborted) {
      yield { type: 'error', errorText: errorText(err) };
    }
  } finally {
    abortController.signal.removeEventListener('abort', onAbort);
    yield* completeTurnChunks(thinking, openTextIds);
    clearCodexTurnState(runtimeParams.sessionKey, identity);
    sub?.dispose(); // drop only THIS turn's handlers; other turns on the shared client stay live
    disposeAll(closeDisposers);
    yield {
      type: 'finish',
      messageMetadata: persistedSessionId ? { sessionId: persistedSessionId } : undefined,
    };
  }
}
