type FlowToolPartIdentity = {
  type: string;
  toolCallId?: string;
};

export function isFlowPatchToolType(type: string): boolean {
  return (
    type === 'tool-frink_flows_patch' ||
    type === 'tool-mcp__frink_dynamic_chat__frink_flows_patch' ||
    type === 'tool-frink_dynamic_chat-frink_flows_patch'
  );
}

export function isGenericFlowPatchTool(type: string, resolvedType: string): boolean {
  return resolvedType === 'tool-frink_flows_patch' && !isFlowPatchToolType(type);
}

export function isRootFlowPatchToolPart(part: FlowToolPartIdentity): boolean {
  return !part.toolCallId?.includes(':') && isFlowPatchToolType(part.type);
}
