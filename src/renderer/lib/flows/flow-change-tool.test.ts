import { describe, expect, it } from 'vitest';
import { isGenericFlowPatchTool, isRootFlowPatchToolPart } from './flow-change-tool';

describe('isGenericFlowPatchTool', () => {
  it('keeps lookalike MCP namespaces on the generic card path', () => {
    expect(
      isGenericFlowPatchTool('tool-mcp__evil__frink_flows_patch', 'tool-frink_flows_patch'),
    ).toBe(true);
  });

  it('does not downgrade trusted or unrelated tools', () => {
    expect(isGenericFlowPatchTool('tool-frink_flows_patch', 'tool-frink_flows_patch')).toBe(false);
    expect(isGenericFlowPatchTool('tool-mcp__evil__list_flows', 'tool-list_flows')).toBe(false);
  });
});

describe('isRootFlowPatchToolPart', () => {
  it('accepts native and MCP-qualified root patches', () => {
    expect(isRootFlowPatchToolPart({ type: 'tool-frink_flows_patch', toolCallId: 'root' })).toBe(
      true,
    );
    expect(
      isRootFlowPatchToolPart({
        type: 'tool-mcp__frink_dynamic_chat__frink_flows_patch',
        toolCallId: 'root',
      }),
    ).toBe(true);
    expect(
      isRootFlowPatchToolPart({
        type: 'tool-frink_dynamic_chat-frink_flows_patch',
        toolCallId: 'root',
      }),
    ).toBe(true);
  });

  it('does not grant authoritative rendering to a lookalike MCP namespace', () => {
    expect(
      isRootFlowPatchToolPart({
        type: 'tool-mcp__evil__frink_flows_patch',
        toolCallId: 'root',
      }),
    ).toBe(false);
  });

  it('keeps nested patches inside their owning subagent card', () => {
    expect(
      isRootFlowPatchToolPart({
        type: 'tool-frink_flows_patch',
        toolCallId: 'parent:child',
      }),
    ).toBe(false);
  });
});
