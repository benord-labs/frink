import path from 'node:path';
import {
  FRINK_DYNAMIC_CHAT_MCP_KEY,
  parseMcpToolFullName,
} from '../../../../../shared/lib/mcp-tool-name';
import { PATH_TOOLS, SEARCH_TOOLS } from '../../../../../shared/types/permissions';
import {
  extractFilePathFromToolInput,
  remapPathForPermissionBoundary,
  resolveSearchPermissionPath,
} from '../../../permissions';
import type { ApprovalOutcome, CodexApprovalRequest } from '../codex-events';

type ValidateToolPermission = (
  toolName: string,
  toolInput: Record<string, unknown>,
  projectPath: string | undefined,
  chatId: string,
  subChatId: string,
  reason?: string,
  permissionPathOverride?: string,
  isFlowDrivenTurn?: boolean,
  deferAskToProvider?: boolean,
  executionSignal?: AbortSignal,
  trustedFrinkOwnedMcp?: boolean,
  mcpIdentity?: { server: string; tool: string },
) => Promise<ApprovalOutcome>;

type CodexHostPermissionOptions = {
  chatId: string;
  subChatId: string;
  projectPath: string;
  permissionProjectPath?: string;
  isFlowExecutionTurn: boolean;
  frinkMcpInjected: boolean;
  autoReview: boolean;
  executionSignal: AbortSignal;
  validateToolPermission: ValidateToolPermission;
};

function trustedFrinkMcpFor(
  request: CodexApprovalRequest,
  frinkMcpInjected: boolean,
): boolean | undefined {
  if (request.mcp) return frinkMcpInjected && request.mcp.server === FRINK_DYNAMIC_CHAT_MCP_KEY;
  return parseMcpToolFullName(request.toolName) ? false : undefined;
}

async function permissionPathFor(
  request: CodexApprovalRequest,
  projectPath: string,
  permissionRoot: string,
): Promise<string | undefined> {
  if (SEARCH_TOOLS.has(request.toolName)) {
    return resolveSearchPermissionPath(
      request.toolName,
      request.input,
      projectPath,
      permissionRoot,
    );
  }
  if (!PATH_TOOLS.has(request.toolName)) return undefined;
  const candidate = extractFilePathFromToolInput(request.toolName, request.input);
  if (!candidate || candidate.startsWith('bash:')) return undefined;
  const absolutePath = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(projectPath, candidate);
  return remapPathForPermissionBoundary(absolutePath, projectPath, permissionRoot);
}

export function createCodexHostPermissionCheck({
  chatId,
  subChatId,
  projectPath,
  permissionProjectPath,
  isFlowExecutionTurn,
  frinkMcpInjected,
  autoReview,
  executionSignal,
  validateToolPermission,
}: CodexHostPermissionOptions): (request: CodexApprovalRequest) => Promise<ApprovalOutcome> {
  return async (request) => {
    const permissionRoot = permissionProjectPath ?? projectPath;
    const result = await validateToolPermission(
      request.toolName,
      request.input,
      permissionRoot,
      chatId,
      subChatId,
      request.reason,
      await permissionPathFor(request, projectPath, permissionRoot),
      isFlowExecutionTurn,
      autoReview,
      executionSignal,
      trustedFrinkMcpFor(request, frinkMcpInjected),
      request.mcp,
    );
    if (result.allowed !== null) return result;
    return autoReview
      ? { allowed: null }
      : { allowed: false, message: 'Provider review was not available' };
  };
}
