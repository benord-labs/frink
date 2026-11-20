import { frinkToolPartName } from '../../../../shared/lib/mcp-tool-name';

const FRINK_TASK_SIGNAL_TOOL = 'frink_task_signal';

/** True for Frink's own `frink_task_signal`, bare or as the Claude Agent SDK prefixes it
 * (`mcp__frink__frink_task_signal`); never a same-named tool from another MCP server. */
export function isFrinkTaskSignalToolName(toolName: string): boolean {
  return (
    toolName === FRINK_TASK_SIGNAL_TOOL || toolName === frinkToolPartName(FRINK_TASK_SIGNAL_TOOL)
  );
}

/** `canUseTool` denial when `frink_task_signal` is not available for this SDK session (claude router). */
export const FRINK_TASK_SIGNAL_INTEGRATION_INACTIVE_MESSAGE =
  "Task lifecycle signaling is not available in this session (Frink's MCP server is not active).";
