import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { app } from 'electron';
import log from 'electron-log';
import type { ChatMode } from '../../../../../shared/types/chat-mode';
import type { ExecutionSettings } from '../../../../../shared/types/execution';
import { parseClaudeModel } from '../../../../../shared/types/execution';
import { buildDebugModePrompt } from '../../../agent-runner/debug-mode';
import { buildClaudeEnv, clampEffortForBundledBinary } from '../../../claude';
import { buildClaudeCredentialLaunch } from '../../../claude/credential-fd-spawn';
import { buildClaudeSdkThinkingPartial } from '../../../claude/sdk-thinking-options';
import { stageClaudeConfigDir } from '../../../claude/session-config-dir';
import type { CredentialResult } from '../../../credentials';
import {
  registerDebugSession,
  startIngestServer,
  unregisterDebugSession,
} from '../../../debug-ingest/ingest-server';
import { getDebugLogPath } from '../../../debug-ingest/log-manager';
import { buildFrinkSystemPromptAppend } from '../../../frink-system-prompt';
import { withChannelQuery } from '../../../mcp/execution-identity';
import { resolveFrinkMcpServers } from '../../../mcp/runtime';
import { createClaudeMcpConfigTransport } from '../../../mcp/runtime/mcp-config-transport';
import { captureMainException } from '../../../sentry/init';
import { getAllAgentsForSdk } from '../../../trpc/routers/agent-utils';
import { type ClaudeSession, createSession } from '../../claude-session-registry';
import { resolvePermissionMode } from '../../streaming/plan-auto-approve';
import { deliverProviderConfig } from '../provider-delivery';
import { buildClaudeSessionCallbacks, type ClaudeSessionScope } from './session-callbacks';

/**
 * Stdio MCPs are connected in parallel batches by the bundled Claude CLI
 * (`resources/bin/darwin-arm64/claude`, env var
 * `MCP_SERVER_CONNECTION_BATCH_SIZE`, default 3). The CLI's init race has a
 * hard-coded 5000ms cap — anything not handshaken by then is reported as
 * `pending` in the `system/init` message and its tools never reach the
 * agent's tool list. With ~15+ stdio MCPs configured, late-batch entries
 * (codebase at position 29/29 was the original symptom) miss the cap.
 * Raising to 30 lets every reasonable stdio MCP set fit in a single
 * concurrent batch. See `docs/frink/todos/mcp-stdio-tools-stuck-pending.md`.
 */
const MCP_STDIO_BATCH_SIZE = '30';

/**
 * Sub-chats whose debug session has been registered with the ingest server in this process.
 * Keyed by `subChatId` (the natural identity); the actual debug session ID emitted to the
 * agent and the ingest server is `subChatId.slice(0, DEBUG_SESSION_ID_LENGTH)` — a short hex
 * prefix that's deterministic per sub-chat (so it survives crashes/restarts) but short enough
 * that the agent doesn't confuse it with the Claude SDK session ID or other long identifiers.
 * Cleared on app restart; registration is re-established on the next debug message.
 */
const activeDebugSessions = new Set<string>();

/** Length of the short hex prefix of `subChatId` used as the debug session ID. */
const DEBUG_SESSION_ID_LENGTH = 6;

/**
 * Derive the debug session ID from `subChatId`. Stable across crashes/restarts because
 * `subChatId` is the SQLite primary key. Kept short to avoid agent confusion with longer IDs.
 */
function debugSessionIdForSubChat(subChatId: string): string {
  return subChatId.slice(0, DEBUG_SESSION_ID_LENGTH);
}

/** Debug-exit cleanup: drop the sub-chat's ingest debug session, when one is registered. */
export function releaseClaudeDebugSession(subChatId: string): void {
  if (!activeDebugSessions.has(subChatId)) return;
  unregisterDebugSession(debugSessionIdForSubChat(subChatId));
  activeDebugSessions.delete(subChatId);
}

/** Test-only: forget registered debug sessions, as an app restart does. */
export function _resetClaudeDebugSessionsForTests(): void {
  activeDebugSessions.clear();
}

/**
 * Filter an mcpServers map down to only the URL-based servers that carry `_oauth`
 * tokens (type 'http' or 'sse'), producing the shape written to the isolated
 * `claude.json` so the Claude Code CLI finds pre-stored credentials and connects
 * as 'connected'. Preserves the original transport type. Exported for testing.
 */
export function buildOAuthServersForConfig(
  mcpServers: Record<string, unknown>,
): Record<string, object> {
  const result: Record<string, object> = {};
  for (const [name, rawConfig] of Object.entries(mcpServers)) {
    const c = rawConfig as Record<string, unknown>;
    if ((c.type === 'http' || c.type === 'sse') && c._oauth && c.url) {
      const headersBlock =
        c.headers !== undefined &&
        c.headers !== null &&
        typeof c.headers === 'object' &&
        !Array.isArray(c.headers)
          ? { headers: c.headers as Record<string, unknown> }
          : {};
      result[name] = {
        url: c.url,
        type: c.type,
        ...headersBlock,
        _oauth: c._oauth,
      };
    }
  }
  return result;
}

/** Everything that decides what a Claude CLI is spawned with. The session scope's fields come
 * through unchanged; the spec adds the agents it loads. */
interface ClaudeSessionSpecInputs extends Omit<ClaudeSessionScope, 'agents'> {
  projectId: string;
  mode: ChatMode;
  settings: ExecutionSettings | undefined;
  storedCredential: Pick<CredentialResult, 'token' | 'isApiKey' | 'login'>;
  nativeAutoReview: boolean;
  planAutoReview: boolean;
  persistedSessionId: string | undefined;
  claudeBinaryPath: string;
  dynamicChatMcpUrl: string | null;
  multiProjectPrefix: string;
  sessionFlowBriefing: string;
  signalTaskId: string | null;
  isFlowExecutionTurn: boolean;
  flowPlanAutoApprove: boolean;
}

type ClaudeSessionSpec = Awaited<ReturnType<typeof buildClaudeSessionSpec>>;

/** A Claude CLI's spawn options, MCP servers and callback scope. Side effects are MCP resolution
 * and, in debug mode, the ingest server + debug session; prepareClaudeSpawn writes spawn files. */
export async function buildClaudeSessionSpec(inputs: ClaudeSessionSpecInputs) {
  const { subChatId, projectPath, mode, settings, storedCredential, signalTaskId } = inputs;
  const { nativeAutoReview, planAutoReview, dynamicChatMcpUrl, persistedSessionId } = inputs;
  const baseEnv = buildClaudeEnv({
    enableTasks: settings?.enableTasks ?? true,
  });
  const {
    ANTHROPIC_API_KEY: _shellApiKey,
    CLAUDE_CODE_OAUTH_TOKEN: _shellOauth,
    ...envWithoutAuth
  } = baseEnv;

  // Isolated config dir prevents the CLI from reading ~/.claude.json MCPs.
  // Frink passes MCPs explicitly via options.mcpServers from ~/.frink/mcp/config.json.
  const isolatedConfigDir = path.join(app.getPath('userData'), 'claude-sessions', subChatId);

  // The stored credential rides a pipe, not the env the CLI's Bash and MCP servers inherit.
  // Why: docs/decisions/child-process-env-secrets.md
  const credentialLaunch = buildClaudeCredentialLaunch(storedCredential);

  const claudeEnv: Record<string, string> = {
    ...envWithoutAuth,
    ...credentialLaunch.envPatch,
    CLAUDE_CONFIG_DIR: isolatedConfigDir,
    // Canonical keychain item + shared ~/.claude refresh lock; CLAUDE_CONFIG_DIR stays
    // isolated. EMPTY STRING is load-bearing, and buildClaudeEnv would delete it from
    // `customEnv` — keep it here. Why: docs/decisions/claude-credential-ownership-at-spawn.md
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
    MCP_SERVER_CONNECTION_BATCH_SIZE: MCP_STDIO_BATCH_SIZE,
    // Auto-intent gate signal — for a non-plan auto turn and a plan-auto turn (before its flip).
    ...(nativeAutoReview || planAutoReview ? { CLAUDE_CODE_ENABLE_AUTO_MODE: '1' } : {}),
  };

  // This execute's CLI channel: live only once its CLI spawns (an adopted session keeps its own).
  const claudeChannel = crypto.randomUUID();
  const claudeDynamicChatMcpUrl =
    dynamicChatMcpUrl && withChannelQuery(dynamicChatMcpUrl, claudeChannel, Boolean(signalTaskId));
  const { servers: mcpServers } = await resolveFrinkMcpServers({
    projectId: inputs.projectId,
    projectPath,
    dynamicChatMcpUrl: claudeDynamicChatMcpUrl,
  });

  // Task signal (frink_task_signal) flows through the dynamic-chat MCP. Only enforce Stop-hook
  // retries, lifecycle prompt, and signal persistence when that server is mounted and we have a task id.
  const taskSignalIntegrationReady = Boolean(signalTaskId && claudeDynamicChatMcpUrl);

  // Log MCP server count (not full config to avoid leaking API keys)
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    log.info(
      `[Socket Executor] Passing ${Object.keys(mcpServers).length} MCP server(s) to SDK: ${Object.keys(mcpServers).join(', ')}`,
    );
  }

  // Load ALL agents for SDK registration (Claude can proactively use via Task tool)
  const allAgents = await getAllAgentsForSdk(projectPath);
  if (Object.keys(allAgents).length > 0) {
    log.info(
      `[Socket Executor] Passing ${Object.keys(allAgents).length} agent(s) to SDK: ${Object.keys(allAgents).join(', ')}`,
    );
  }

  const sessionScope: ClaudeSessionScope = {
    chatId: inputs.chatId,
    subChatId,
    project: inputs.project,
    projectPath,
    permissionProjectPath: inputs.permissionProjectPath,
    agents: allAgents,
    validateToolPermission: inputs.validateToolPermission,
    abortSources: inputs.abortSources,
  };

  const frinkSystemPromptAppend = await buildSessionPromptAppend(
    inputs,
    taskSignalIntegrationReady,
  );

  // The SDK inlines options.mcpServers in argv; project the same startup config through a protected
  // file path while retaining first-turn loading and dynamic-config precedence.
  const claudeMcpConfig = createClaudeMcpConfigTransport(mcpServers, isolatedConfigDir, (error) => {
    log.warn('[Socket Executor] Failed to remove staged Claude MCP config:', error);
    captureMainException(error, { surface: 'claude-mcp-config-cleanup' });
  });

  const shouldResumeClaudeSession = Boolean(persistedSessionId);
  const sdkOptions = {
    cwd: projectPath,
    permissionMode: resolvePermissionMode(mode, nativeAutoReview),
    env: claudeEnv,
    pathToClaudeCodeExecutable: inputs.claudeBinaryPath,
    ...(credentialLaunch.spawnClaudeCodeProcess
      ? { spawnClaudeCodeProcess: credentialLaunch.spawnClaudeCodeProcess }
      : {}),
    // Explicit resume is authoritative; SDK declares cwd-wide `continue` mutually exclusive.
    ...(shouldResumeClaudeSession ? { resume: persistedSessionId } : {}),
    // Agent SDK stderr can contain remote MCP credentials. Consume it without retaining or
    // emitting it; the executor classifies errors from the transient thrown message instead.
    stderr: () => {},
    includePartialMessages: true,
    // Frink system prompt: platform identity, Flows primer, AGENTS.md, multi-project block.
    // Placed in systemPrompt.append so it is prompt-cached and not repeated each user turn.
    systemPrompt: {
      type: 'preset' as const,
      preset: 'claude_code' as const,
      append: `\n\n${frinkSystemPromptAppend}`,
    },
    // Load skills and hooks from project (.claude/) and user (~/.claude/) directories
    // This enables Claude to use skills via the Skill tool and hooks for lifecycle events
    settingSources: ['project' as const, 'user' as const],
    // Agents from ~/.claude/agents/ and .claude/agents/ (Claude can use proactively)
    ...(Object.keys(allAgents).length > 0 && { agents: allAgents }),
    ...(claudeMcpConfig && { extraArgs: claudeMcpConfig.extraArgs }),
    // Model selection from settings (short alias or full Anthropic model ID —
    // API does not accept "auto"). Version-pinned IDs
    // like `claude-opus-4-7` are required so 4.6 vs 4.7 resolve correctly.
    ...(() => {
      const parsed = parseClaudeModel(settings?.model);
      return parsed ? { model: parsed } : {};
    })(),
    // Extended thinking: Opus 4.7 / 4.8 require adaptive (API); other models use fixed budget → CLI flags.
    ...buildClaudeSdkThinkingPartial(settings),
    // `xhigh` only reaches the CLI ≥ 2.1.173; clamp to `high` on older (or unidentifiable) bundled
    // binaries so the effort flag never crashes the executor at arg-parse (`--effort xhigh` invalid).
    ...(() => {
      const effort = clampEffortForBundledBinary(settings?.effort);
      if (settings?.effort === 'xhigh' && effort === 'high') {
        log.warn(
          '[Socket Executor] Bundled Claude CLI may not support `--effort xhigh` (version < 2.1.173 or unreadable); clamped to high. Run `bun run claude:download` to refresh it.',
        );
      }
      if (!effort) return {};
      // Ultra = xhigh + the CLI's session `ultracode` orchestration; a clamped binary drops it with
      // xhigh. Flow turns never run it: unattended runs have no usage disclosure surface yet.
      const ultra = settings?.ultra && effort === 'xhigh' && !inputs.isFlowExecutionTurn;
      return {
        effort: effort as import('@anthropic-ai/claude-agent-sdk').Options['effort'],
        ...(ultra && { settings: { ultracode: true } }),
      };
    })(),
    // SDK betas (e.g. 1M context window: 'context-1m-2025-08-07')
    ...(settings?.betas?.length && {
      betas: settings.betas as import('@anthropic-ai/claude-agent-sdk').SdkBeta[],
    }),
  };
  // Log the resolved SDK configuration before calling Claude
  const resolvedModel = (sdkOptions as Record<string, unknown>).model ?? 'sonnet';
  const thinkingOpt = (sdkOptions as Record<string, unknown>).thinking;
  const resolvedThinking =
    thinkingOpt !== undefined
      ? JSON.stringify(thinkingOpt)
      : String((sdkOptions as Record<string, unknown>).maxThinkingTokens ?? 'off');
  const resolvedBetas = ((sdkOptions as Record<string, unknown>).betas as string[]) ?? [];
  log.info(
    `[Socket Executor] SDK call: model=${resolvedModel}, thinking=${resolvedThinking}, effort=${settings?.effort ?? 'default'}, betas=[${resolvedBetas.join(',')}], resume=${shouldResumeClaudeSession}, mode=${mode}, permissionMode=${resolvePermissionMode(mode, nativeAutoReview)}`,
  );
  return {
    options: sdkOptions,
    mcpServers,
    login: storedCredential.login,
    scope: sessionScope,
    channel: claudeChannel,
    configDir: isolatedConfigDir,
    mcpConfig: claudeMcpConfig,
    taskSignalReady: taskSignalIntegrationReady,
  };
}

/** The session's `systemPrompt.append`: the Frink platform block, then the flow briefing, with
 * the debug-mode prompt in front when the chat is in debug mode. */
async function buildSessionPromptAppend(
  inputs: ClaudeSessionSpecInputs,
  taskSignalIntegrationReady: boolean,
): Promise<string> {
  const { subChatId, projectPath, mode, sessionFlowBriefing } = inputs;
  // Build Frink system prompt append (platform block + AGENTS.md + multi-project when ≥2 projects).
  // This goes into systemPrompt.append so it is prompt-cached and not repeated in every user turn.
  let frinkSystemPromptAppend = await buildFrinkSystemPromptAppend({
    cwd: projectPath,
    multiProjectPrefix: inputs.multiProjectPrefix || undefined,
    isTaskExecution: taskSignalIntegrationReady,
    isPlanMode: mode === 'plan',
    // Same flag the AskUserQuestion translate keys on, so the guidance describes what the tool
    // actually does here exactly when it behaves that way — including a restarted flow run.
    isFlowDriven: inputs.isFlowExecutionTurn,
    planAutoApprove: inputs.flowPlanAutoApprove,
  });

  // Flow Briefing → Claude session system prompt: injected once here (prompt-cached), NOT repeated
  // in each user turn — the CLAUDE.md-like behaviour the flow briefing is meant to have. Rendered
  // byte-stable per run (constant context at dispatch) so it does not bust the cache across nodes.
  // Codex gets it via a first-turn prompt prepend instead. Empty for non-flow chats.
  if (sessionFlowBriefing) {
    frinkSystemPromptAppend = `${frinkSystemPromptAppend}\n\n## Flow Briefing\n\n${sessionFlowBriefing}`;
  }

  // Debug mode (SDK path): start ingest server, register session, append debug prompt to system prompt.
  // Session ID is derived from `subChatId` (first 6 chars) so the log file
  // (`<projectPath>/.frink/debug/<sessionId>.ndjson`) is stable across crashes/restarts —
  // re-entering debug mode in the same sub-chat keeps appending to the same file and the agent
  // retains prior context. The 6-char form keeps the ID visually distinct from the Claude SDK
  // session ID and other long identifiers in the prompt.
  if (mode === 'debug' && projectPath) {
    const debugSessionId = debugSessionIdForSubChat(subChatId);
    const port = await startIngestServer();
    const isAlreadyRegistered = activeDebugSessions.has(subChatId);
    if (!isAlreadyRegistered) {
      registerDebugSession(debugSessionId, projectPath);
      activeDebugSessions.add(subChatId);
    }
    const debugPrompt = buildDebugModePrompt({
      sessionId: debugSessionId,
      logFilePath: getDebugLogPath(projectPath, debugSessionId),
      ingestEndpoint: `http://127.0.0.1:${port}/ingest/${debugSessionId}`,
    });
    frinkSystemPromptAppend = `${debugPrompt}\n\n${frinkSystemPromptAppend}`;
    log.info(
      `[Socket Executor] SDK debug mode: ingest server on port ${port}, session ${debugSessionId}${isAlreadyRegistered ? ' (reused)' : ' (registered)'}`,
    );
  }
  return frinkSystemPromptAppend;
}

/** Spawn-only work: provider delivery, then the disk state only a spawned CLI reads (the staged
 * config dir and the MCP OAuth tokens in it). */
export async function prepareClaudeSpawn(spec: ClaudeSessionSpec): Promise<void> {
  const { configDir: isolatedConfigDir, mcpServers } = spec;
  await deliverProviderConfig(spec.scope.project, spec.scope.projectPath, 'claude-code');
  // Isolation also hides the rest of ~/.claude, so stageClaudeConfigDir puts the
  // user's skills, agents and CLAUDE.md memory back inside the session dir.
  // Pre-create session plans/ so path checks (realpath) succeed before first Write.
  fs.mkdirSync(path.join(isolatedConfigDir, 'plans'), { recursive: true });
  stageClaudeConfigDir(isolatedConfigDir, spec.scope.subChatId);

  // Write OAuth tokens for HTTP MCPs into the isolated CLAUDE_CONFIG_DIR so the CLI
  // finds stored tokens and treats the server as already-authenticated.
  // Without this, the CLI's isolated dir is empty → no saved tokens → server status
  // becomes 'needs-auth' and only authenticate/complete_authentication meta-tools appear,
  // even though our Bearer header is valid.
  if (mcpServers) {
    const oauthServersForConfig = buildOAuthServersForConfig(mcpServers);
    if (Object.keys(oauthServersForConfig).length > 0) {
      const claudeConfigPath = path.join(isolatedConfigDir, 'claude.json');
      let existingConfig: Record<string, unknown> = {};
      try {
        existingConfig = JSON.parse(await fs.promises.readFile(claudeConfigPath, 'utf8'));
      } catch {
        // File doesn't exist yet — start fresh
      }
      await fs.promises.writeFile(
        claudeConfigPath,
        JSON.stringify({ ...existingConfig, mcpServers: oauthServersForConfig }),
        { mode: 0o600 },
      );
      // mode on writeFile only applies when the file is created; chmod enforces 0o600 on every write.
      await fs.promises.chmod(claudeConfigPath, 0o600);
      log.info(
        `[Socket Executor] Wrote OAuth tokens for ${Object.keys(oauthServersForConfig).join(', ')} to isolated claude.json`,
      );
    }
  }
}

/** Spawn the chat's CLI, its callbacks bound to the session they run on and never a successor.
 * `inputsReadAt` (ISO) is no later than the read of the credential and MCP servers in `options`. */
export function spawnClaudeSession(
  spec: ClaudeSessionSpec,
  options: ClaudeSessionSpec['options'],
  keyParts: Record<string, string>,
  query: typeof sdkQuery,
  inputsReadAt: string,
): ClaudeSession {
  const spawned: { current: ClaudeSession | null } = { current: null };
  const { stopHook, ...callbacks } = buildClaudeSessionCallbacks(spec.scope, spawned);
  return createSession(
    spec.scope.subChatId,
    (stream) => query({ prompt: stream, options: { ...options, ...callbacks } }),
    {
      keyParts,
      stopHook,
      channel: spec.channel,
      sdkSessionId: options.resume,
      inputsReadAt: Date.parse(inputsReadAt),
      ref: spawned,
    },
  );
}
