import path from 'node:path';
import { app } from 'electron';
import log from 'electron-log';
import type { PermissionPresentation } from '../../../../../shared/types/permissions';
import {
  getClaudeSessionPlansDir,
  isValidSubChatIdForSessionPaths,
} from '../../../claude/session-plan-paths';
import { getDatabase } from '../../../db';
import { getProjectByPath } from '../../../db/repos/projects';
import {
  type FlowConsentDecision,
  type FlowConsentRequest,
  readFlowConsentDecision,
} from '../../../mcp/flows-tools/gating/flow-invocation-consent';
import { getOperationFromToolName } from '../../../permissions';
import { isValidPermissionPresentation } from '../../../permissions/presentation-schema';
import { permissionTimeoutMessage } from '../../../permissions/prompt-timeout';
import { buildPermissionDecisionInput } from '../../../permissions/v2';
import { checkPermission } from '../../../permissions/v2/check';
import { formatDenyReason } from '../../../permissions/v2/deny-reason-format';
import { persistApprovedRule } from '../../../permissions/v2/persist-approved-rule';
import {
  onPermissionResponse,
  type PermissionRequestPayload,
  sendPermissionDismiss,
  sendPermissionRequest,
} from '../../client';
import { getActiveExecution } from '../execution-registry';
import { createPendingPermissionRequestBroker, generatePermissionRequestId } from './request';

const permissionRequests = createPendingPermissionRequestBroker({
  getExecutionSignal: (subChatId) => getActiveExecution(subChatId)?.controller.signal,
  onResponse: onPermissionResponse,
  sendDismiss: sendPermissionDismiss,
  sendRequest: sendPermissionRequest,
});
export const drainPendingPermissions = permissionRequests.drain;
export const hasPendingPermissionRequest = permissionRequests.hasPending;

/**
 * Ask the user whether an agent may run a specific flow.
 *
 * Rides the existing permission transport rather than adding a second approval
 * system: same pending map, same socket event, same timeout and dismissal. It
 * runs strictly AFTER the v2 tool decision, so it can only narrow — a deny rule
 * has already blocked the call before this is reached.
 */
export async function requestFlowInvocationConsent(
  request: FlowConsentRequest,
): Promise<FlowConsentDecision> {
  const response = await permissionRequests.request(
    {
      chatId: request.chatId,
      subChatId: request.subChatId,
      requestId: generatePermissionRequestId(),
      type: 'flow_consent',
      path: request.flowId,
      operation: 'flow_consent',
      reason: `Run flow: ${request.flowName}`,
      flowConsent: {
        flowId: request.flowId,
        flowName: request.flowName,
        summary: request.summary,
        allowOnce: request.allowOnce,
      },
    },
    // `null` detaches deliberately; `undefined` would fall back to the live
    // execution and let an ordinary next turn dismiss the card.
    request.abortSignal ?? null,
  );
  return readFlowConsentDecision(response);
}

/**
 * Validate tool permission via the v2 dispatcher for provider hooks, MCP calls,
 * and Codex host-permission requests.
 */
// Reason: moved verbatim from executor.ts, where this complexity is grandfathered.
// fallow-ignore-next-line complexity
export async function validateToolPermission(
  toolName: string,
  toolInput: Record<string, unknown>,
  projectPath: string | undefined,
  chatId: string,
  subChatId: string,
  reason?: string,
  permissionPathOverride?: string,
  isFlowDrivenTurn?: boolean,
  deferAskToProvider = false,
  executionSignal?: AbortSignal,
  trustedFrinkOwnedMcp?: boolean,
  mcpIdentity?: { server: string; tool: string },
  presentation?: PermissionPresentation,
): Promise<{ allowed: true } | { allowed: false; message: string } | { allowed: null }> {
  if (!isValidPermissionPresentation(toolName, presentation)) {
    log.error('[executor] Rejected invalid permission presentation', { toolName });
    return { allowed: false, message: 'Invalid permission presentation — tool blocked' };
  }

  if (!projectPath) return { allowed: true };

  // From here every tool call is decided by the permission rules, which prompt when
  // no rule matches and deny outright when the rule store cannot be read.

  // permissionPathOverride is a FILE-level remap (worktree → canonical project
  // FILE path), not a project-root override. PATH tools feed it into the decision
  // input (rule matching against the canonical root); Bash/MCP keep it display-only.
  //
  // This read runs before checkPermission's own rule-store guard, so it carries the
  // same posture: a DB we cannot read denies instead of throwing past the gate.
  let project: Awaited<ReturnType<typeof getProjectByPath>>;
  try {
    project = await getProjectByPath(getDatabase(), projectPath);
  } catch (err) {
    log.error('[executor] Could not read project for permission check — denying', err);
    return { allowed: false, message: formatDenyReason({ kind: 'db:unavailable' }) };
  }

  // Session-dir auto-allow root: THIS chat's CLAUDE_CONFIG_DIR. `check-edit`
  // short-circuits Reads under its allow-listed subtrees (pasted/ + tool-result
  // spills) without prompting. Guarded by the same validator as planDirRoot.
  const sessionDirRoot = isValidSubChatIdForSessionPaths(subChatId)
    ? path.join(app.getPath('userData'), 'claude-sessions', subChatId)
    : undefined;

  // Plan-mode auto-allow: the SDK keeps plans under $CLAUDE_CONFIG_DIR/plans,
  // classified `outside` the project — pass the dir so check-edit short-circuits
  // plan reads/writes instead of prompting each one.
  const planDirRoot = isValidSubChatIdForSessionPaths(subChatId)
    ? getClaudeSessionPlansDir(subChatId)
    : undefined;

  const decisionInput = buildPermissionDecisionInput(toolName, toolInput, permissionPathOverride);
  const result = await checkPermission({
    tool: toolName,
    input: decisionInput,
    projectId: project?.id ?? '',
    projectPath,
    sessionDirRoot,
    planDirRoot,
    trustedFrinkOwnedMcp,
    mcpIdentity,
  });
  if (result.decision === 'allow') return { allowed: true };
  if (result.decision === 'deny') {
    return { allowed: false, message: formatDenyReason(result.reason) };
  }

  // Provider Auto Mode reviews the remaining `ask` bucket, uniformly across every tool
  // class — vendor plugin MCP servers included (auto-mode-tool-approval 2026-09-03 Target).
  if (deferAskToProvider) return { allowed: null };

  // ask → prompt the renderer in-process, persist + (for bash) sync cursor on approval.
  const isBash = toolName === 'Bash';
  const isMcp = toolName.startsWith('mcp__');
  const fallbackPath = isBash
    ? String((toolInput as { command?: string }).command ?? '')
    : String((toolInput as { file_path?: string }).file_path ?? '');
  // Apply worktree FILE-path override here only — for prompt rendering + rule.
  const remappedPath = permissionPathOverride ?? fallbackPath;
  const requestId = generatePermissionRequestId();
  const payload: PermissionRequestPayload = {
    chatId,
    subChatId,
    requestId,
    type: isMcp ? 'mcp_tool' : isBash ? 'bash' : 'file',
    path: remappedPath,
    operation: isMcp
      ? 'mcp_tool'
      : isBash
        ? 'bash'
        : (getOperationFromToolName(toolName) ?? 'read'),
    reason: reason ?? `Tool: ${toolName}`,
    prompt: presentation ? { ...result.prompt, presentation } : result.prompt,
    // projectPath enables the "Allow for project" button in FourButtonView
    // (`hasProject = !!request.projectPath`). Omitted when no project row
    // matches (general chat / virtual folder, where projectPath is the home
    // dir): persistApprovedRule cannot write a project rule there, so the
    // button must render disabled and steer the user to "On this machine".
    ...(project ? { projectPath } : {}),
    ...(project?.name ? { projectName: project.name } : {}),
    // MCP payloads include the tool name so the renderer can render the full identifier.
    ...(isMcp ? { toolName } : {}),
  };

  const promptResult = await permissionRequests.request(payload, executionSignal);

  // Timeout ≠ deny: the user may never have seen the prompt (rule writes gate on duration==='always').
  if (promptResult.timedOut) {
    log.info('[executor] Permission request timed out', { remappedPath, toolName, requestId });
    return { allowed: false, message: permissionTimeoutMessage(remappedPath, isFlowDrivenTurn) };
  }
  if (!promptResult.approved) {
    return { allowed: false, message: 'User denied permission' };
  }

  // The user approved this call; a failed rule write only means the next call prompts
  // again, so it must not turn the approval into a deny or a rejected promise.
  try {
    await persistApprovedRule({
      db: getDatabase(),
      projectPath,
      project: project ?? null,
      promptResult,
      isBash,
      logTag: '[executor]',
    });
  } catch (err) {
    log.warn('[executor] Could not persist approved rule', err);
  }

  return { allowed: true };
}
