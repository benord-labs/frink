import log from 'electron-log';
import { FRINK_DYNAMIC_CHAT_MCP_KEY } from '../../../../shared/lib/mcp-tool-name';
import type { CodexThreadSubscription } from './app-server-client';
import {
  type ApprovalOutcome,
  COMMAND_APPROVAL_METHOD,
  type CodexApprovalRequest,
  FILE_CHANGE_APPROVAL_METHOD,
  type FileChange,
  mapApprovalRequests,
} from './codex-events';
import {
  codexHostPermissionDeduper,
  FRINK_HOST_TOOL_PERMISSION_METHOD,
  mapFrinkHostPermissionRequests,
  parseFrinkHostToolPermissionRequest,
} from './codex-host-permissions';

/**
 * Frink's permission gate, wrapping validateToolPermission. Called inside each approval onRequest
 * handler; an allowed outcome maps to accept, else decline.
 */
export type CodexApprovalCheck = (request: CodexApprovalRequest) => Promise<ApprovalOutcome>;

const REGISTER_NODE_TOOL_NAME = 'frink_register_node';

function isRegisterNodeTransportRequest(
  request: ReturnType<typeof parseFrinkHostToolPermissionRequest>,
): boolean {
  return (
    request?.kind === 'mcp' &&
    request.mcp?.server === FRINK_DYNAMIC_CHAT_MCP_KEY &&
    request.mcp.tool === REGISTER_NODE_TOOL_NAME &&
    request.toolName === `mcp__${FRINK_DYNAMIC_CHAT_MCP_KEY}__${REGISTER_NODE_TOOL_NAME}`
  );
}

/**
 * Launch-gate instrumentation: did the per-file cache deliver REAL paths? Three states
 * drive the keep-vs-delete verdict — no cached item (the approval beat item/started), a cached but
 * path-less item (`[]` → falls back to grantRoot, so the machinery added nothing), or a real hit
 * with N>0 paths. (`[]` is truthy, so a naive `changes ?` check would mislabel the empty case.)
 */
function fileChangeCacheVerdict(changes: FileChange[] | undefined): string {
  if (changes == null) return 'MISS (no cached item)';
  if (changes.length === 0) return 'MISS (cached, 0 paths → grantRoot)';
  return `HIT (${changes.length} path${changes.length === 1 ? '' : 's'})`;
}

/** Log the fileChange cache verdict (no-op for non-fileChange approval methods). */
function logFileChangeCache(
  method: string,
  changes: FileChange[] | undefined,
  itemId: string,
): void {
  if (method !== FILE_CHANGE_APPROVAL_METHOD) return;
  log.info(
    `[Codex app-server] fileChange approval cache ${fileChangeCacheVerdict(changes)} itemId=${itemId || '(none)'}`,
  );
}

/** The path or command an approval request gates, for the decline log line. */
function approvalTarget(request: CodexApprovalRequest): string {
  return String(request.input.file_path ?? request.input.command ?? '');
}

/**
 * Gate every resolved request through the host permission check. codex answers ONE decision per
 * request, so a multi-file patch is all-or-nothing: the first denied path declines the whole patch.
 */
async function gateApprovalRequests(
  requests: CodexApprovalRequest[],
  checkApproval: CodexApprovalCheck,
): Promise<{ decision: 'accept' | 'decline' }> {
  for (const request of requests) {
    const outcome = await checkApproval(request);
    if (outcome.allowed !== true) {
      log.warn(`[Codex app-server] approval declined for ${approvalTarget(request)}`);
      return { decision: 'decline' };
    }
  }
  return { decision: 'accept' };
}

async function gateHostPermissionRequests(
  requests: CodexApprovalRequest[],
  checkApproval: CodexApprovalCheck,
): Promise<'allow' | 'defer' | 'deny'> {
  let decision: 'allow' | 'defer' = 'allow';
  for (const request of requests) {
    const outcome = await checkApproval(request);
    if (outcome.allowed === false) return 'deny';
    if (outcome.allowed === null) decision = 'defer';
  }
  return decision;
}

/** Register both approval handlers on the turn's thread subscription. */
export function registerApprovalHandlers(
  sub: CodexThreadSubscription,
  checkApproval: CodexApprovalCheck,
  fileChangeCache: Map<string, FileChange[]>,
): void {
  const handle = (method: string) => async (rawParams: unknown) => {
    try {
      const itemId = String((rawParams as { itemId?: unknown }).itemId ?? '');
      const changes =
        method === FILE_CHANGE_APPROVAL_METHOD ? fileChangeCache.get(itemId) : undefined;
      logFileChangeCache(method, changes, itemId);
      return await gateApprovalRequests(
        mapApprovalRequests(method, rawParams, changes),
        checkApproval,
      );
    } catch (err) {
      log.error('[Codex app-server] approval check failed; declining', err);
      return { decision: 'decline' as const };
    }
  };
  sub.onRequest(COMMAND_APPROVAL_METHOD, handle(COMMAND_APPROVAL_METHOD));
  sub.onRequest(FILE_CHANGE_APPROVAL_METHOD, handle(FILE_CHANGE_APPROVAL_METHOD));
  sub.onRequest(FRINK_HOST_TOOL_PERMISSION_METHOD, async (rawParams) => {
    const request = parseFrinkHostToolPermissionRequest(rawParams);
    if (!request) return { decision: 'deny' as const, reason: 'Malformed host permission request' };
    // Registration's semantic v2 decision happens after main captures the package snapshot.
    // This provider callback only lets that exact canonical call reach dynamic Flow dispatch.
    if (isRegisterNodeTransportRequest(request)) return { decision: 'allow' as const };
    try {
      const decision = await gateHostPermissionRequests(
        mapFrinkHostPermissionRequests(request),
        checkApproval,
      );
      if (decision !== 'allow') return { decision };
      codexHostPermissionDeduper.remember(request);
      return { decision: 'allow' as const };
    } catch (err) {
      log.error('[Codex app-server] host permission check failed; denying', err);
      return { decision: 'deny' as const, reason: 'Frink permission check failed' };
    }
  });
}
