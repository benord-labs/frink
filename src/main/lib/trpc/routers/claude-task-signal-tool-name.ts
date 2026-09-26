/**
 * True when the SDK tool name refers to the Frink dynamic-chat MCP `frink_task_signal` tool.
 * The Claude Agent SDK prefixes MCP tools, e.g. `mcp__frink_dynamic_chat__frink_task_signal`.
 * We only match the bare tool name or that canonical server prefix — not any `*__frink_task_signal`
 * from another MCP server.
 */
const FRINK_TASK_SIGNAL_SUFFIX = '__frink_task_signal';
const MCP_FRINK_DYNAMIC_CHAT_PREFIX = 'mcp__frink_dynamic_chat__';

export function isFrinkTaskSignalToolName(toolName: string): boolean {
  if (toolName === 'frink_task_signal') return true;
  return (
    toolName.startsWith(MCP_FRINK_DYNAMIC_CHAT_PREFIX) &&
    toolName.endsWith(FRINK_TASK_SIGNAL_SUFFIX)
  );
}

/** `canUseTool` denial when `frink_task_signal` is not available for this SDK session (claude router). */
export const FRINK_TASK_SIGNAL_INTEGRATION_INACTIVE_MESSAGE =
  'Task lifecycle signaling is not available in this session (dynamic chat MCP not active).';
