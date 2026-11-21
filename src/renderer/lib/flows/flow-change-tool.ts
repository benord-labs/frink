import { FRINK_MCP_HISTORY_KEYS, frinkToolPartName } from '../../../shared/lib/mcp-tool-name';

type FlowToolPartIdentity = {
  type: string;
  toolCallId?: string;
};

/** Saved chats also carry the server's earlier keys, and an older `tool-<key>-<tool>` form. */
const FLOW_PATCH_TOOL_TYPES: ReadonlySet<string> = new Set([
  'tool-frink_flows_patch',
  `tool-${frinkToolPartName('frink_flows_patch')}`,
  ...[...FRINK_MCP_HISTORY_KEYS].flatMap((key) => [
    `tool-mcp__${key}__frink_flows_patch`,
    `tool-${key}-frink_flows_patch`,
  ]),
]);

export function isFlowPatchToolType(type: string): boolean {
  return FLOW_PATCH_TOOL_TYPES.has(type);
}

export function isGenericFlowPatchTool(type: string, resolvedType: string): boolean {
  return resolvedType === 'tool-frink_flows_patch' && !isFlowPatchToolType(type);
}

export function isRootFlowPatchToolPart(part: FlowToolPartIdentity): boolean {
  return !part.toolCallId?.includes(':') && isFlowPatchToolType(part.type);
}
