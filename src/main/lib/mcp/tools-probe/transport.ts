/**
 * Shared MCP client plumbing for the probe (`index.ts`) and one-shot tool-call
 * (`call.ts`) paths: transport factories for the two server shapes (HTTP,
 * stdio), typed failure classification, and one connect-operate-close
 * lifecycle under per-step timeout budgets.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { captureMainMessage } from '../../sentry/init';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { getClaudeShellEnvironment } from '../../claude/env';

/**
 * Budgets are per-purpose and SDK-owned (`docs/decisions/mcp-probe-budget.md`). A stdio
 * `connect` owns the child spawn plus `initialize`, where a cold start is spent; HTTP
 * spawns nothing, so its connect keeps the operation-sized window.
 */
export const MCP_STDIO_CONNECT_TIMEOUT_MS = 30_000;
export const MCP_HTTP_CONNECT_TIMEOUT_MS = 10_000;

/** An operation runs against an already-warm child, so it keeps the smaller window. */
export const MCP_OPERATION_TIMEOUT_MS = 10_000;

/** `callTool`: bounded by the trigger-operation lease, not the probe's cold-start cost. */
export const MCP_CALL_TIMEOUT_MS = 10_000;

/**
 * Covers the only step no `RequestOptions` can: `StdioClientTransport.start()`. Must stay
 * strictly above the SDK budget or it wins the race and the SDK never reaches `cancel()`.
 */
const MCP_OUTER_GUARD_GRACE_MS = 5_000;

export function outerGuardMs(sdkBudgetMs: number): number {
  return sdkBudgetMs + MCP_OUTER_GUARD_GRACE_MS;
}

const MCP_FETCH_TIMEOUT_MESSAGE = 'MCP fetch timeout';

/** Which step produced a failure; tagged so the budgets can be tuned from real data. */
type McpStep = 'connect' | 'operation';

/**
 * Race a promise against the outer guard. Clears the timer on resolution/rejection so the
 * handle never leaks into the event loop.
 */
async function withOuterGuard<T>(promise: Promise<T>, guardMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(MCP_FETCH_TIMEOUT_MESSAGE)), guardMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Typed failure of an MCP connection/operation. A failure is never collapsed
 * into an empty success — "server unreachable" must stay distinguishable from
 * "server has zero tools" (a downstream consumer acting on an empty list, e.g.
 * a node despawner, would otherwise treat every outage as removal).
 * - `timeout`: a budget elapsed (the SDK's own request timer, or the outer spawn guard)
 * - `spawn_failed`: the stdio child process never started (stdio transport only —
 *   an HTTP error is never classified as a spawn failure, whatever its message)
 * - `transport`: everything else (connect refused, protocol or tool error)
 */
type McpFailureReason = 'timeout' | 'spawn_failed' | 'transport';

export type McpFailure = { ok: false; reason: McpFailureReason; message: string };

/** Identity and budget for one connect-operate-close lifecycle. */
export type McpClientContext = {
  kind: 'http' | 'stdio';
  /** Config key, for failure triage. NEVER a credential-bearing value: argv and headers carry keys. */
  serverName?: string;
  /** SDK budget for the operation step; `connect`'s budget follows `kind`. */
  operationTimeoutMs: number;
};

const SPAWN_ERROR_CODES = new Set(['ENOENT', 'EACCES', 'EPERM']);

/** Two shapes mean a budget elapsed: the SDK's own `McpError` -32001, and the outer guard's sentinel. */
function isRequestTimeout(error: unknown): boolean {
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) return true;
  return error instanceof Error && error.message === MCP_FETCH_TIMEOUT_MESSAGE;
}

/** One capture per (server, transport, reason) per session: bounds volume without hiding a class. */
const capturedFailures = new Set<string>();

function captureMcpFailure(
  reason: McpFailureReason,
  message: string,
  context: McpClientContext,
  step: McpStep,
  elapsedMs: number,
): void {
  const server = context.serverName ?? 'unknown';
  const key = `${server}:${context.kind}:${reason}`;
  if (capturedFailures.has(key)) return;
  capturedFailures.add(key);
  captureMainMessage(
    `MCP ${context.kind} transport failure (${reason}): ${message}`,
    'warning',
    {
      surface: 'mcp-transport',
      transport: context.kind,
      reason,
      server,
      step,
      elapsed_ms: String(elapsedMs),
    },
    // Vendor error text varies per server, so group on the class, not the message.
    ['mcp-transport', context.kind, reason],
  );
}

/** Test seam: the dedup set is process-wide and would otherwise leak between cases. */
export function _resetMcpFailureCaptureForTests(): void {
  capturedFailures.clear();
}

function classifyMcpFailure(
  error: unknown,
  context: McpClientContext,
  step: McpStep,
  elapsedMs: number,
): McpFailure {
  const message = error instanceof Error ? error.message : String(error);
  const failure = ((): McpFailure => {
    if (isRequestTimeout(error)) return { ok: false, reason: 'timeout', message };
    if (context.kind === 'stdio') {
      const code = (error as { code?: unknown } | null)?.code;
      if (
        (typeof code === 'string' && SPAWN_ERROR_CODES.has(code)) ||
        message.startsWith('spawn ')
      ) {
        return { ok: false, reason: 'spawn_failed', message };
      }
    }
    return { ok: false, reason: 'transport', message };
  })();
  // Every typed failure is monitored here, at the single mint point — callers
  // branch on the union without owning capture.
  captureMcpFailure(failure.reason, message, context, step, elapsedMs);
  return failure;
}

/**
 * Connect, run ONE operation, tear down in a finally — a stdio child is spawned per
 * invocation and reaped on close. Only `context.kind === 'stdio'` can be `spawn_failed`.
 */
export async function withMcpClient<T>(
  context: McpClientContext,
  createTransport: () => Transport,
  operation: (client: Client, options: RequestOptions) => Promise<T>,
): Promise<{ ok: true; value: T } | McpFailure> {
  let transport: Transport | null = null;
  let step: McpStep = 'connect';
  let stepStartedAt = Date.now();
  try {
    const client = new Client({ name: 'frink', version: '1.0.0' });
    transport = createTransport();
    const connectTimeoutMs =
      context.kind === 'stdio' ? MCP_STDIO_CONNECT_TIMEOUT_MS : MCP_HTTP_CONNECT_TIMEOUT_MS;
    await withOuterGuard(
      client.connect(transport, { timeout: connectTimeoutMs }),
      outerGuardMs(connectTimeoutMs),
    );
    step = 'operation';
    stepStartedAt = Date.now();
    const value = await withOuterGuard(
      operation(client, { timeout: context.operationTimeoutMs }),
      outerGuardMs(context.operationTimeoutMs),
    );
    return { ok: true, value };
  } catch (error) {
    return classifyMcpFailure(error, context, step, Date.now() - stepStartedAt);
  } finally {
    try {
      if (transport) {
        await transport.close();
      }
    } catch {
      // Ignore close errors
    }
  }
}

/**
 * @param serverUrl The MCP server URL
 * @param headers Optional request headers (e.g. API key / Bearer token)
 */
export function createHttpTransport(
  serverUrl: string,
  headers?: Record<string, string>,
): StreamableHTTPClientTransport {
  const requestInit: RequestInit = {};
  if (headers && Object.keys(headers).length > 0) {
    requestInit.headers = { ...headers };
  }
  return new StreamableHTTPClientTransport(new URL(serverUrl), { requestInit });
}

/** Spawn spec for a stdio MCP server. */
export type McpStdioServerSpec = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

/**
 * Sensitive env vars to filter out when spawning MCP subprocesses
 */
const BLOCKED_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENAI_API_KEY',
];

/**
 * Spawn transport for a stdio MCP server, on the user's shell environment so
 * PATH is correct (homebrew, nvm, etc.). This is critical for production where
 * Electron apps launched from Finder have a minimal PATH that excludes
 * user-installed tools. Sensitive env vars are filtered out.
 */
export function createStdioTransport(config: McpStdioServerSpec): StdioClientTransport {
  const shellEnv = getClaudeShellEnvironment();
  const safeEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(shellEnv)) {
    if (!BLOCKED_ENV_VARS.includes(key)) {
      safeEnv[key] = value;
    }
  }
  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...safeEnv, ...config.env },
  });
}
