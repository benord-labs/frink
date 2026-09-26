export type McpToolResult = { content: Array<{ type: 'text'; text: string }>; isError: boolean };

export function toolResult(text: string, isError = false): McpToolResult {
  return {
    content: [{ type: 'text' as const, text }],
    isError,
  };
}
