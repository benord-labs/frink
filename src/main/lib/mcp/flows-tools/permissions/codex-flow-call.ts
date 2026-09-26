import {
  FRINK_DYNAMIC_CHAT_MCP_KEY,
  FRINK_MUTATING_FLOW_TOOLS,
} from '../../../../../shared/lib/mcp-tool-name';
import { codexHostPermissionDeduper } from '../../../agent-runner/codex/codex-host-permissions';

type CodexCallMeta = { threadId?: unknown; turnId?: unknown; callId?: unknown } | undefined;

export function consumeCodexFlowPreapproval(
  runtime: string | undefined,
  name: string,
  args: Record<string, unknown>,
  meta: CodexCallMeta,
): boolean {
  if (
    runtime !== 'codex' ||
    !FRINK_MUTATING_FLOW_TOOLS.has(name) ||
    typeof meta?.threadId !== 'string' ||
    typeof meta.turnId !== 'string' ||
    typeof meta.callId !== 'string'
  ) {
    return false;
  }
  return codexHostPermissionDeduper.consumeMcp(
    meta.threadId,
    meta.turnId,
    meta.callId,
    FRINK_DYNAMIC_CHAT_MCP_KEY,
    name,
    args,
  );
}

type LiveExecutionContext = { subChatId: string; abortSignal?: AbortSignal };

export function createFlowExecutionLiveness<T extends LiveExecutionContext>(options: {
  executionId?: string;
  context?: T | null;
  channelAddressed?: boolean;
  getExecutionContext: (executionId: string | undefined) => T | null | undefined;
  getChannelExecutionId: (subChatId: string) => string | undefined;
}): (() => boolean) | undefined {
  const { executionId, context, channelAddressed } = options;
  if (!executionId || !context) return undefined;
  return () =>
    options.getExecutionContext(executionId) === context &&
    context.abortSignal?.aborted !== true &&
    (!channelAddressed || options.getChannelExecutionId(context.subChatId) === executionId);
}
