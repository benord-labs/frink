/* eslint-disable max-lines, max-lines-per-function */
/**
 * In-process HTTP MCP server for dynamic chat tools.
 * Exposes searchProjects, fetchAllProjects, requestSwitchProject to the agent.
 * Bound to 127.0.0.1 only. No auth required (localhost).
 */

import fs from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';

import { BrowserWindow } from 'electron';
import log from 'electron-log';
import { z } from 'zod';
import { LAUNCH_FLAGS } from '../../../shared/launch-flags';
import type { ChatMode } from '../../../shared/types/chat-mode';
import { getDatabase } from '../db';
import {
  getChatById,
  moveChatToProjectLocal,
  parseWorktreeHistory,
  updateChat,
} from '../db/repos/chats';
import {
  getProjectById as getProjectByIdLocal,
  listRealProjects,
} from '../db/repos/projects';
import { gitCache } from '../git/cache';
import { resolveTargetWorktreeForMove } from '../git/resolve-target-worktree';
import { getCurrentBranch } from '../git/worktree';
import {
  hasPendingMoveChatApproval,
  requestMoveChatApproval,
} from '../socket/streaming/pending-permission/move-chat';
import * as taskSignal from '../trpc/routers/frink-task-signal';
import * as toolCatalog from './dynamic-chat-tool-catalog';
import {
  appendIdentityToEndpointUrl,
  channelOwner,
  type ExecutionIdentity,
  parseExecutionIdentity,
} from './execution-identity';
import {
  FLOWS_TOOLS,
  resetFlowsAddStageRunsCount,
  resetFlowsGetBatchCount,
  resetFlowsGetRunCount,
  resetFlowsListTemplatesCount,
  resetListPluginToolsCount,
  resetFlowsPatchCount,
  resetFlowsPatchCreateCount,
  resetFlowsRunCount,
  resetRegisterNodeCount,
} from './flows-tools';
import {
  dispatchFlowToolCall,
  type FlowConsentStore,
  type RequestFlowConsent,
  resetDefineStagesCount,
  resetStartBatchCount,
  type ValidateFlowWrite,
} from './flows-tools/gating';
import {
  consumeCodexFlowPreapproval,
  createFlowExecutionLiveness,
} from './flows-tools/permissions';
import { resolveInitializeProtocolVersion } from './protocol-version';
import { handleTaskSignalToolCall, type RecordedTaskSignal } from './task-signal-tool';
import { type McpToolResult, toolResult } from './tool-result';

/**
 * Lazy bridges from the flow-tool gates to the executor and the flow store.
 *
 * They live here, at the composition root, rather than beside the gates: the
 * gates must not import the executor (a cycle) or the database (a module they
 * have to load without). This file already carries that lazy executor
 * dependency, so adding a third module to the chain only widens the cycle.
 */
const validateFlowWriteViaExecutor: ValidateFlowWrite = async (...args) => {
  const { validateToolPermission } = await import('../socket/executor');
  return validateToolPermission(...args);
};

const requestFlowConsentViaExecutor: RequestFlowConsent = async (request) => {
  const { requestFlowInvocationConsent } = await import('../socket/executor');
  return requestFlowInvocationConsent(request);
};

const flowConsentStore: FlowConsentStore = {
  getFlow: async (id) => (await import('../flows/mcp-cloud-shim')).getFlow(id),
  updateFlow: async (id, patch) => (await import('../flows/mcp-cloud-shim')).updateFlow(id, patch),
  listFlowBatchStages: async (flowId, batchId) =>
    (await import('../flows/mcp-cloud-shim')).listFlowBatchStages(flowId, batchId),
};

// ! CIRCULAR DEP NOTE:
// Avoid static imports back into `../socket` (which re-exports executor wiring).
// When needed, load socket helpers lazily inside functions.

type ExecutionContext = {
  chatId: string;
  subChatId: string;
  projectPath?: string;
  mode: ChatMode;
  latestTaskSignal?: RecordedTaskSignal;
  navigationSessionId?: string;
  /** False when no live task expects a lifecycle signal: refuses `frink_task_signal` calls.
   * Defaults true (fail-open). */
  taskSignalEnabled: boolean;
  /** The task row an accepted `frink_task_signal` lands on (the executor's `signalTaskId`). Lets
   * the handler refuse a signal whose target can no longer consume it instead of answering ok. */
  signalTaskId?: string | null;
  /** A channel resolves only to a context of its token's runtime. */
  runtime?: 'claude' | 'codex';
  /** Per-send Auto consent; never inherited across sends. */
  autoReviewTools?: boolean;
  planAutoDenyFloor?: () => boolean;
  /** Flow-dispatched turn — threads flow-specific steering into permission-timeout messages. */
  isFlowDrivenTurn?: boolean;
  /** Controller for the exact turn that registered this context. */
  abortSignal?: AbortSignal;
};

type NavigationSnapshot = {
  projectId: string | null;
  projectName: string;
  projectPath: string;
  worktreePath: string | null;
  branch: string | null;
  chatId: string;
};

type NavigationHistoryItem = {
  projectId: string | null;
  projectName: string;
  worktreePath: string | null;
  chatId: string;
  switchedAt: string;
};

type NavigationVisit = {
  chatId: string;
  worktreePath: string | null;
};

type NavigationSession = {
  sessionId: string;
  origin: NavigationSnapshot;
  history: NavigationHistoryItem[];
  visitMap: Map<string, NavigationVisit>;
  createdAt: number;
  lastTouchedAt: number;
};

// Execution contexts are scoped by run ID to prevent cross-chat leakage when
// multiple chats execute concurrently.
const executionContexts = new Map<string, ExecutionContext>();
const subChatToExecutionId = new Map<string, string>();
const navigationSessions = new Map<string, NavigationSession>();
const subChatToNavigationSessionId = new Map<string, string>();
const NAVIGATION_SESSION_TTL_MS = 30 * 60 * 1000;

function sweepNavigationSessions(now = Date.now()): void {
  for (const [sessionId, session] of navigationSessions.entries()) {
    if (now - session.lastTouchedAt > NAVIGATION_SESSION_TTL_MS) {
      navigationSessions.delete(sessionId);
    }
  }
  for (const [subChatId, sessionId] of subChatToNavigationSessionId.entries()) {
    if (!navigationSessions.has(sessionId)) {
      subChatToNavigationSessionId.delete(subChatId);
    }
  }
}

function getExecutionContext(executionId?: string): ExecutionContext | null {
  if (!executionId) return null;
  return executionContexts.get(executionId) ?? null;
}

export function setCurrentExecutionChat(
  chatId: string,
  subChatId: string,
  projectPath?: string,
  mode: ChatMode = 'agent',
  executionId?: string,
  navigationSessionId?: string,
  taskSignalEnabled?: boolean,
  runtime?: ExecutionContext['runtime'],
  autoReviewTools?: boolean,
  isFlowDrivenTurn?: boolean,
  abortSignal?: AbortSignal,
  planAutoDenyFloor?: () => boolean,
  signalTaskId?: string | null,
): string {
  sweepNavigationSessions();
  const resolvedExecutionId = executionId ?? crypto.randomUUID();
  const previous = executionContexts.get(resolvedExecutionId);
  const resolvedNavigationSessionId =
    navigationSessionId ??
    previous?.navigationSessionId ??
    subChatToNavigationSessionId.get(subChatId) ??
    undefined;
  executionContexts.set(resolvedExecutionId, {
    chatId,
    subChatId,
    projectPath,
    mode,
    navigationSessionId: resolvedNavigationSessionId,
    // Inherit across re-calls on the same executionId (mid-turn resume re-registrations).
    taskSignalEnabled: taskSignalEnabled ?? previous?.taskSignalEnabled ?? true,
    signalTaskId: signalTaskId ?? previous?.signalTaskId ?? null,
    runtime: runtime ?? previous?.runtime,
    // Consent inherits only across SAME-executionId re-registrations (mid-turn env/resume
    // re-calls) — a new execution id starts from the value its registering turn passes.
    autoReviewTools: autoReviewTools ?? previous?.autoReviewTools ?? false,
    planAutoDenyFloor: planAutoDenyFloor ?? previous?.planAutoDenyFloor,
    isFlowDrivenTurn: isFlowDrivenTurn ?? previous?.isFlowDrivenTurn ?? false,
    abortSignal: abortSignal ?? previous?.abortSignal,
  });
  // Claude binds its channel at attach (bindChannelExecution), once a held burst has ended.
  if ((runtime ?? previous?.runtime) !== 'claude')
    subChatToExecutionId.set(subChatId, resolvedExecutionId);
  if (resolvedNavigationSessionId) {
    subChatToNavigationSessionId.set(subChatId, resolvedNavigationSessionId);
    const session = navigationSessions.get(resolvedNavigationSessionId);
    if (session) {
      session.lastTouchedAt = Date.now();
    }
  }
  return resolvedExecutionId;
}

/** Point a sub-chat's channel at the Claude turn that now owns its session. */
export function bindChannelExecution(subChatId: string, executionId: string | undefined): void {
  if (executionId) subChatToExecutionId.set(subChatId, executionId);
}

/** `frink_task_signal` is off for this execution (a refused dead target) — the Stop hook stops chasing. */
export function isTaskSignalDisarmed(executionId?: string): boolean {
  return getExecutionContext(executionId)?.taskSignalEnabled === false;
}

export function getLatestTaskSignal(executionId?: string): ExecutionContext['latestTaskSignal'] {
  return getExecutionContext(executionId)?.latestTaskSignal;
}

/**
 * Record a signal the agent expressed WITHOUT calling `frink_task_signal` — today only the
 * `AskUserQuestion` translate, which parks a Flow run from the tool's own payload. This slot is what
 * the Stop hook and the post-stream finalize both read, so a park that skips it is invisible to
 * both: the hook chases the agent for a signal it already sent, and the task never leaves `running`.
 * Returns false when no context is registered (nothing task-linked to signal about). Stamps `at` the
 * same way the tool handler does, so both writers land an identically shaped slot.
 */
export function setLatestTaskSignal(
  signal: Omit<NonNullable<ExecutionContext['latestTaskSignal']>, 'at'> & { at?: string },
  executionId?: string,
): boolean {
  const ctx = getExecutionContext(executionId);
  if (!ctx) return false;
  ctx.latestTaskSignal = { ...signal, at: signal.at ?? new Date().toISOString() };
  return true;
}

export function clearCurrentExecutionChat(executionId?: string): void {
  if (executionId) {
    const context = executionContexts.get(executionId);
    executionContexts.delete(executionId);
    resetFlowsAddStageRunsCount(executionId);
    resetDefineStagesCount(executionId);
    resetStartBatchCount(executionId);
    resetFlowsRunCount(executionId);
    resetFlowsPatchCount(executionId);
    resetFlowsPatchCreateCount(executionId);
    resetFlowsGetRunCount(executionId);
    resetFlowsGetBatchCount(executionId);
    resetFlowsListTemplatesCount(executionId);
    resetListPluginToolsCount(executionId);
    resetRegisterNodeCount(executionId);
    if (context) {
      const mappedExecutionId = subChatToExecutionId.get(context.subChatId);
      if (mappedExecutionId === executionId) {
        subChatToExecutionId.delete(context.subChatId);
      }
    }
  } else {
    executionContexts.clear();
    subChatToExecutionId.clear();
    resetFlowsAddStageRunsCount();
    resetDefineStagesCount();
    resetStartBatchCount();
    resetFlowsRunCount();
    resetFlowsPatchCount();
    resetFlowsPatchCreateCount();
    resetFlowsGetRunCount();
    resetFlowsGetBatchCount();
    resetFlowsListTemplatesCount();
    resetListPluginToolsCount();
    resetRegisterNodeCount();
  }
  sweepNavigationSessions();
}

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** SSE: send one event to establish the stream; the connection stays open for the MCP client. */
function sendSseStream(
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
  identity: ExecutionIdentity,
): void {
  const endpointUrl = appendIdentityToEndpointUrl(baseUrl, identity);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`event: endpoint\ndata: ${JSON.stringify({ url: endpointUrl })}\n\n`);
  req.on('close', () => {
    if (!res.writableEnded) res.end();
  });
}

async function handleToolsList(toolset?: string) {
  // From the URL's toolset: a session lists its tools at spawn, before a turn binds its channel.
  // The same list in every mode (plan mode refuses flow tools per call); LAUNCH_FLAGS.flows is the kill switch.
  const flowsTools = LAUNCH_FLAGS.flows ? FLOWS_TOOLS : [];
  return { tools: [...toolCatalog.getRuntimeBaseTools(toolset !== 'nosignal'), ...flowsTools] };
}

/** Zod schemas for MCP tools/call argument validation (per API security SKILL). */
const searchProjectsArgsSchema = z.object({ query: z.string() });
const requestSwitchProjectArgsSchema = z.object({
  project_id: z.string().min(1),
  worktree_path: z.string().min(1).optional(),
});
const navigationContextArgsSchema = z.object({});

function buildProjectName(projectId: string | null, fallback = 'Unknown Project'): string {
  return projectId ? fallback : 'General Chats';
}

/** Project fields the chat agent sees from searchProjects / fetchAllProjects. */
type ProjectHit = { id: string; name: string; path: string; description: string | null };

const WHITESPACE_REGEX = /\s+/;

/**
 * Filter local projects by a free-form query: every whitespace-delimited word must appear
 * (case-insensitive) in the project's name, description, or path. Empty query → all rows.
 * Single-user local DB has few projects, so an in-memory filter is cheaper than a SQL pass.
 */
function filterProjectsByQuery(
  rows: Array<{ id: string; name: string; path: string; description: string | null }>,
  query: string,
  limit: number,
): ProjectHit[] {
  const words = query.toLowerCase().split(WHITESPACE_REGEX).filter(Boolean);
  const matched = rows.filter((p) => {
    if (words.length === 0) return true;
    const haystack = `${p.name} ${p.description ?? ''} ${p.path}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
  return matched
    .slice(0, limit)
    .map((p) => ({ id: p.id, name: p.name, path: p.path, description: p.description ?? null }));
}

function createNavigationSession(origin: NavigationSnapshot): NavigationSession {
  return {
    sessionId: crypto.randomUUID(),
    origin,
    history: [],
    visitMap: new Map<string, NavigationVisit>(),
    createdAt: Date.now(),
    lastTouchedAt: Date.now(),
  };
}

function resolveWorkspacePath(projectPath: string, worktreePath: string | null): string {
  if (worktreePath && fs.existsSync(worktreePath)) {
    return worktreePath;
  }
  return projectPath;
}

/**
 * Internal helper for in-process callers (e.g. socket executor) to invoke Frink MCP tools
 * through the same validation/dispatch path as external MCP clients.
 */
export async function callDynamicChatToolByName(
  name: string,
  args?: Record<string, unknown>,
  executionId?: string,
  channelAddressed?: boolean,
): Promise<McpToolResult> {
  return handleToolsCall({ name, arguments: args ?? {} }, executionId, channelAddressed);
}

async function handleToolsCall(
  params: unknown,
  executionId?: string,
  channelAddressed?: boolean,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError: boolean }> {
  const {
    name,
    arguments: args,
    _meta: meta,
  } = (params || {}) as {
    name: string;
    arguments?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
  const a = args ?? {};

  const ctx = getExecutionContext(executionId);

  if (name === toolCatalog.CODEX_TASK_STOP_GUARD_TOOL_NAME) {
    if (!channelAddressed || !ctx || ctx.runtime !== 'codex') {
      return toolResult('Codex task Stop guard requires a live channel-scoped execution.', true);
    }
    const result = taskSignal.buildCodexTaskStopGuardResult(
      a,
      Boolean(ctx.taskSignalEnabled && !ctx.abortSignal?.aborted && !ctx.latestTaskSignal),
    );
    return toolResult(result.text, result.isError);
  }

  if (name === 'searchProjects') {
    const parsed = searchProjectsArgsSchema.safeParse(a);
    if (!parsed.success) {
      return toolResult(`Invalid arguments: ${parsed.error.message}`, true);
    }
    const query = parsed.data.query;
    const rows = await listRealProjects(getDatabase());
    const list = filterProjectsByQuery(rows, query, 10);
    return toolResult(JSON.stringify({ projects: list }, null, 2));
  }

  if (name === 'fetchAllProjects') {
    const rows = await listRealProjects(getDatabase());
    const list = rows.map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path,
      description: p.description ?? null,
    }));
    return toolResult(JSON.stringify({ projects: list }, null, 2));
  }

  if (name === 'frink_navigation_context') {
    const parsed = navigationContextArgsSchema.safeParse(a);
    if (!parsed.success) {
      return toolResult(`Invalid arguments: ${parsed.error.message}`, true);
    }
    if (!ctx) {
      return toolResult('No active chat context.', true);
    }
    const db = getDatabase();
    const currentChat = await getChatById(db, ctx.chatId);
    if (!currentChat) {
      return toolResult('Current chat not found.', true);
    }
    // Resolve project metadata from the local store. Projects are local-first post-0.0.5; a
    // chat's projectId is a local cuid2, so a stale/unknown id (e.g. an old worktree_history
    // entry) just falls back to a placeholder name.
    const resolveProjectMeta = async (
      projectId: string | null,
    ): Promise<{ name: string; path: string | null }> => {
      if (!projectId) return { name: buildProjectName(null), path: null };
      const local = await getProjectByIdLocal(db, projectId);
      if (local) return { name: local.name, path: local.path };
      return { name: buildProjectName(projectId), path: null };
    };

    // Touch the in-memory navigation session for handoff bookkeeping (the agent's project
    // continuation flow consults it). Not surfaced to the agent: session-scoped origin +
    // move-trail are redundant with the persistent per-chat `history` below.
    const sessionId = ctx.navigationSessionId;
    const session = sessionId ? (navigationSessions.get(sessionId) ?? null) : null;
    if (session) {
      session.lastTouchedAt = Date.now();
    }
    // Derive the live git branch from disk — the chats row's `branch` is null for
    // non-worktree chats (set only on real worktrees in create.ts), but the agent needs
    // a meaningful answer even for chats sitting at a project root. Defensive against
    // missing dirs / non-git paths; logs the failure so a systemic break (git not on PATH,
    // worktree dirs unreadable) doesn't silently degrade every entry to `branch: null`.
    const deriveBranch = async (worktreePath: string | null): Promise<string | null> => {
      if (!worktreePath) return null;
      try {
        return await getCurrentBranch(worktreePath);
      } catch (error) {
        log.warn('[frink_navigation_context] getCurrentBranch failed', { worktreePath, error });
        return null;
      }
    };

    // Persistent per-chat history (DB-backed `worktree_history` column) — survives across
    // app restarts. Read-time enriched with the LIVE project name + branch (storage stays
    // `projectId → worktreePath` so renames propagate). Moving the chat back to one of
    // these projectIds auto-restores the worktree. Parallel lookups (typically <10 entries).
    const rawHistory = parseWorktreeHistory(currentChat.worktreeHistory);
    const [currentMeta, currentBranch, history] = await Promise.all([
      resolveProjectMeta(currentChat.projectId),
      deriveBranch(currentChat.worktreePath),
      Promise.all(
        Object.entries(rawHistory).map(async ([projectId, worktreePath]) => {
          const [meta, branch] = await Promise.all([
            resolveProjectMeta(projectId),
            deriveBranch(worktreePath),
          ]);
          return { projectId, projectName: meta.name, worktreePath, branch };
        }),
      ),
    ]);

    const current = {
      projectId: currentChat.projectId,
      projectName: currentMeta.name,
      projectPath: ctx.projectPath ?? currentMeta.path ?? '',
      worktreePath: currentChat.worktreePath,
      // Prefer the live git HEAD branch; fall back to the stored value (older rows or
      // detached/missing worktrees).
      branch: currentBranch ?? currentChat.branch,
      chatId: currentChat.id,
    };

    // Origin = where the chat started. Persistent-history entries are written when LEAVING
    // a project, so the FIRST entry is the chat's birth project. If the chat has never
    // moved, the chat is still at its origin → mirror `current` (with the same shape as a
    // history entry so the agent can act on it uniformly).
    const origin =
      history[0] ??
      (currentChat.projectId
        ? {
            projectId: currentChat.projectId,
            projectName: currentMeta.name,
            worktreePath: currentChat.worktreePath ?? '',
            branch: current.branch,
          }
        : null);

    return toolResult(JSON.stringify({ current, origin, history }, null, 2));
  }

  if (name === 'requestSwitchProject') {
    const parsed = requestSwitchProjectArgsSchema.safeParse(a);
    if (!parsed.success) {
      return toolResult(`Invalid arguments: ${parsed.error.message}`, true);
    }
    const targetProjectId = parsed.data.project_id;
    let preferredWorktreePath = parsed.data.worktree_path?.trim() || undefined;
    if (preferredWorktreePath) preferredWorktreePath = path.normalize(preferredWorktreePath);

    if (!ctx)
      return toolResult(
        'No active chat context (switch only available during an active run).',
        true,
      );

    if (hasPendingMoveChatApproval(ctx.subChatId))
      return toolResult(
        'A switch request is already pending for this chat. Wait for user approval or denial.',
        true,
      );

    const db = getDatabase();
    const project = await getProjectByIdLocal(db, targetProjectId);
    if (!project) return toolResult(`Project not found: ${targetProjectId}`, true);

    const sourceChat = await getChatById(db, ctx.chatId);
    if (!sourceChat) return toolResult('Current chat not found.', true);

    const sourceProject = sourceChat.projectId
      ? await getProjectByIdLocal(db, sourceChat.projectId)
      : null;
    const existingSession =
      ctx.navigationSessionId != null
        ? (navigationSessions.get(ctx.navigationSessionId) ?? null)
        : null;
    const isSameProject = sourceChat.projectId === targetProjectId;
    const history = parseWorktreeHistory(sourceChat.worktreeHistory);

    // For cross-project moves, the resolver auto-restores a previous worktree from history
    // (per-chat persistent memory) when the agent doesn't specify `worktree_path`. The user
    // sees the actual destination in the approval dialog. Same-project worktree switches
    // are explicit (not history-driven), so they bypass the resolver.
    const resolvedTarget = isSameProject
      ? null
      : await resolveTargetWorktreeForMove({
          targetProjectId,
          targetProjectPath: project.path,
          explicitWorktreePath: preferredWorktreePath ?? null,
          history,
        });

    const requestedWorktreePath = isSameProject
      ? (preferredWorktreePath ?? null)
      : (resolvedTarget?.worktreePath ?? null);
    const resolvedWorkspacePath = isSameProject
      ? resolveWorkspacePath(project.path, requestedWorktreePath)
      : (resolvedTarget?.worktreePath ?? project.path);

    const normalizedCurrentWorktreePath = sourceChat.worktreePath
      ? path.normalize(sourceChat.worktreePath)
      : null;
    const normalizedRequestedWorktreePath = requestedWorktreePath
      ? path.normalize(requestedWorktreePath)
      : null;
    const isSameWorktree = normalizedCurrentWorktreePath === normalizedRequestedWorktreePath;
    if (isSameProject && isSameWorktree) {
      return toolResult(
        JSON.stringify(
          {
            approved: true,
            outcome: 'already_in_chat',
            message: 'You are already in this chat.',
            chatId: ctx.chatId,
            subChatId: ctx.subChatId,
            requestedWorktreePath,
          },
          null,
          2,
        ),
      );
    }

    const requestId = crypto.randomUUID();
    const payload = {
      requestId,
      chatId: ctx.chatId,
      subChatId: ctx.subChatId,
      projectId: targetProjectId,
      projectName: project.name,
      targetChatId: ctx.chatId,
      targetSubChatId: ctx.subChatId,
      targetBranch: sourceChat.branch,
      requestedWorktreePath,
      projectPath: resolvedWorkspacePath,
    };

    const approved = await requestMoveChatApproval(payload);

    if (!approved) {
      return toolResult(
        JSON.stringify(
          {
            approved: false,
            outcome: 'denied',
            requiresNewTurn: false,
            message: 'User denied the switch.',
            chatId: ctx.chatId,
            subChatId: ctx.subChatId,
            requestedWorktreePath,
          },
          null,
          2,
        ),
        true,
      );
    }
    // Local-first: both same-project worktree switches and cross-project moves write to
    // local SQLite. A cross-project move collapses the chat to `resolvedWorkspacePath` (the
    // requested worktree if it exists on disk, else the destination project root), matching
    // the DnD move path and the non-worktree invariant `worktreePath === project.path`.
    let moved: { branch: string | null; worktreePath: string | null } | null = null;
    try {
      if (isSameProject) {
        const updated = await updateChat(getDatabase(), ctx.chatId, {
          worktreePath: requestedWorktreePath,
        });
        moved = updated ? { branch: updated.branch, worktreePath: updated.worktreePath } : null;
      } else {
        // `resolvedTarget` is computed for every cross-project case above; this is an
        // invariant rather than a runtime expectation. The throw narrows the type and is
        // caught by the surrounding try/catch (sets `moved = null` for the failure path).
        if (!resolvedTarget) {
          throw new Error('[requestSwitchProject] resolvedTarget missing on cross-project move');
        }
        const target = resolvedTarget;
        const { updated, previousWorktreePath } = await moveChatToProjectLocal(
          getDatabase(),
          ctx.chatId,
          {
            projectId: targetProjectId,
            worktreePath: target.worktreePath,
            branch: target.branch,
            baseBranch: target.baseBranch,
            stalePrunedProjectId: target.stalePrunedProjectId,
          },
        );
        // Invalidate BOTH the old and new worktree paths — auto-restore re-attaches to a
        // previous worktree whose gitCache may be stale from the prior visit.
        if (previousWorktreePath && previousWorktreePath !== target.worktreePath) {
          gitCache.invalidateStatus(previousWorktreePath);
          gitCache.invalidateParsedDiff(previousWorktreePath);
        }
        if (target.worktreePath) {
          gitCache.invalidateStatus(target.worktreePath);
          gitCache.invalidateParsedDiff(target.worktreePath);
        }
        moved = updated ? { branch: updated.branch, worktreePath: updated.worktreePath } : null;
      }
    } catch {
      moved = null;
    }
    if (!moved) {
      return toolResult(
        JSON.stringify(
          {
            approved: false,
            userApproved: true,
            outcome: 'move_failed',
            requiresNewTurn: false,
            message: 'User approved move, but chat move failed.',
            chatId: ctx.chatId,
            subChatId: ctx.subChatId,
            requestedWorktreePath,
          },
          null,
          2,
        ),
        true,
      );
    }
    const effectiveWorktreePath = moved.worktreePath ?? null;
    const effectiveWorkspacePath = resolveWorkspacePath(project.path, effectiveWorktreePath);

    const origin: NavigationSnapshot = {
      projectId: sourceChat.projectId,
      projectName: sourceProject?.name ?? buildProjectName(sourceChat.projectId),
      projectPath: ctx.projectPath ?? sourceProject?.path ?? '',
      worktreePath: sourceChat.worktreePath,
      branch: sourceChat.branch,
      chatId: sourceChat.id,
    };
    const session = existingSession ?? createNavigationSession(origin);
    session.lastTouchedAt = Date.now();
    session.visitMap.set(sourceChat.projectId ?? '__general__', {
      chatId: sourceChat.id,
      worktreePath: sourceChat.worktreePath,
    });
    session.visitMap.set(targetProjectId, {
      chatId: sourceChat.id,
      worktreePath: effectiveWorktreePath,
    });
    session.history.push({
      projectId: targetProjectId,
      projectName: project.name,
      worktreePath: effectiveWorktreePath,
      chatId: sourceChat.id,
      switchedAt: new Date().toISOString(),
    });
    navigationSessions.set(session.sessionId, session);
    subChatToNavigationSessionId.set(ctx.subChatId, session.sessionId);

    const currentContext = getExecutionContext(executionId);
    if (
      currentContext &&
      currentContext.chatId === ctx.chatId &&
      currentContext.subChatId === ctx.subChatId
    ) {
      currentContext.projectPath = effectiveWorkspacePath;
      currentContext.navigationSessionId = session.sessionId;
    }

    try {
      const { clearCodexSession, handleRemoteStop } = await import('../socket/executor');
      clearCodexSession(ctx.chatId);
      // Stop the old execution so the next turn re-initializes with the new project's CWD.
      // The renderer will auto-resume with a continuation prompt after navigation completes.
      setImmediate(() => {
        try {
          handleRemoteStop({ chatId: ctx.chatId, subChatId: ctx.subChatId });
        } catch {
          // Best-effort; move itself succeeded even if stop signal fails.
        }
      });
    } catch {
      // Best-effort.
    }

    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('agent:move-chat-approved', {
          chatId: ctx.chatId,
          subChatId: ctx.subChatId,
          projectId: targetProjectId,
          projectName: project.name,
          projectPath: effectiveWorkspacePath,
          requestedWorktreePath: effectiveWorktreePath,
          navigationSessionId: session.sessionId,
        });
      }
    }

    return toolResult(
      JSON.stringify(
        {
          approved: true,
          outcome: 'moved',
          requiresNewTurn: true,
          message: `User approved. Chat moved to "${project.name}" (${effectiveWorkspacePath}). Execution handoff scheduled; next turn will run in the new project context.`,
          project: { id: targetProjectId, name: project.name, path: effectiveWorkspacePath },
          targetChatId: ctx.chatId,
          targetSubChatId: ctx.subChatId,
          targetBranch: moved.branch,
          requestedWorktreePath: effectiveWorktreePath,
        },
        null,
        2,
      ),
    );
  }

  if (name === 'frink_task_signal') {
    if (!executionId || !ctx) {
      return toolResult('frink_task_signal requires an active execution context.', true);
    }
    return handleTaskSignalToolCall(ctx, a);
  }

  const flowResult = dispatchFlowToolCall({
    name,
    args: a,
    executionId,
    channelAddressed,
    ctx,
    projectPath: ctx?.projectPath,
    mode: ctx?.mode,
    flowsEnabled: LAUNCH_FLAGS.flows,
    validateWrite: validateFlowWriteViaExecutor,
    providerPreapproved: consumeCodexFlowPreapproval(ctx?.runtime, name, a, meta),
    isExecutionCurrent: createFlowExecutionLiveness({
      executionId,
      context: ctx,
      channelAddressed,
      getExecutionContext,
      getChannelExecutionId: (subChatId) => subChatToExecutionId.get(subChatId),
    }),
    // Only offered when there is a live chat to raise the card in; without it
    // the handler's terminal agent_invocable check refuses instead.
    requestFlowConsent: ctx ? requestFlowConsentViaExecutor : undefined,
    flowStore: flowConsentStore,
  });
  if (flowResult) return flowResult;

  return toolResult(`Unknown tool: ${name}`, true);
}

async function processMethod(
  method: string,
  params: unknown,
  executionId?: string,
  identity: ExecutionIdentity = {},
): Promise<unknown> {
  switch (method) {
    case 'initialize': {
      // Echo the client's requested protocol version so the handshake always succeeds.
      // Fall back to a known-safe version when protocolVersion is omitted.
      const clientVersion = resolveInitializeProtocolVersion(params);
      return {
        protocolVersion: clientVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'frink-dynamic-chat', version: '1.0.0' },
      };
    }
    case 'initialized':
      return undefined;
    case 'tools/list':
      return handleToolsList(identity.toolset);
    case 'tools/call':
      return handleToolsCall(params, executionId, Boolean(identity.channel));
    case 'ping':
      return {};
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

function handleRequest(
  req: JsonRpcRequest,
  executionId?: string,
  identity?: ExecutionIdentity,
): Promise<JsonRpcResponse> {
  return processMethod(req.method, req.params, executionId, identity).then(
    (result) => ({
      jsonrpc: '2.0' as const,
      id: req.id,
      result: result === undefined ? null : result,
    }),
    (err) => ({
      jsonrpc: '2.0' as const,
      id: req.id,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : String(err),
      },
    }),
  );
}

/** The run a channel is bound to RIGHT NOW, if it is of the token's runtime. Between turns this is
 * nothing, so a warm client cannot write into a turn that already ended. */
function resolveExecutionId(identity: ExecutionIdentity): string | undefined {
  const owner = channelOwner(identity.channel);
  const executionId = owner ? subChatToExecutionId.get(owner.subChatId) : undefined;
  return getExecutionContext(executionId)?.runtime === owner?.runtime ? executionId : undefined;
}

let dynamicChatServer: { url: string; server: Server } | null = null;

/**
 * Get or start the dynamic chat MCP HTTP server. Single instance, bound to 127.0.0.1.
 * Returns the base URL for SDK registration.
 */
export async function getOrStartDynamicChatMcpUrl(): Promise<string | null> {
  if (dynamicChatServer) return dynamicChatServer.url;
  try {
    dynamicChatServer = await startDynamicChatMcpServer();
    return dynamicChatServer.url;
  } catch {
    return null;
  }
}

/**
 * Start the dynamic chat MCP HTTP server on 127.0.0.1.
 * Returns the base URL (e.g. http://127.0.0.1:PORT) for SDK registration.
 */
function startDynamicChatMcpServer(): Promise<{ url: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const pathname = req.url?.split('?')[0] ?? '';
      const isSsePath = pathname === '/' || pathname === '/sse';

      if (req.method === 'GET' && isSsePath) {
        const baseUrl = dynamicChatServer?.url;
        if (baseUrl) {
          sendSseStream(req, res, baseUrl, parseExecutionIdentity(req.url));
        } else {
          sendJson(res, 503, { error: 'Server not ready' });
        }
        return;
      }

      if (req.method !== 'POST' || req.url === undefined || req.url === '') {
        sendJson(res, 405, { error: 'Method Not Allowed' });
        return;
      }

      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        let reqJson: JsonRpcRequest;
        try {
          reqJson = JSON.parse(body) as JsonRpcRequest;
        } catch {
          sendJson(res, 400, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          });
          return;
        }

        if (reqJson.jsonrpc !== '2.0' || reqJson.id === undefined || !reqJson.method) {
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id: reqJson.id ?? null,
            error: { code: -32600, message: 'Invalid Request' },
          });
          return;
        }

        const identity = parseExecutionIdentity(req.url);
        const executionId = resolveExecutionId(identity);
        handleRequest(reqJson, executionId, identity).then((response) => {
          sendJson(res, 200, response);
        });
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object' && addr.port) {
        const url = `http://127.0.0.1:${addr.port}`;
        resolve({ url, server });
      } else {
        reject(new Error('Dynamic chat MCP server: could not get port'));
      }
    });

    server.on('error', reject);
  });
}
