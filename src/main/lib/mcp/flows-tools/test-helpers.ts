import { expect } from 'vitest';

export type McpToolResultLike = {
  isError?: boolean;
  content: Array<{ type?: string; text?: string }>;
};

type PartialMcpToolResultLike = Omit<McpToolResultLike, 'content'> & {
  content?: McpToolResultLike['content'];
};

export function expectMcpResultText(
  result: PartialMcpToolResultLike | null | undefined,
  expectedError?: boolean,
): string {
  expect(result).not.toBeNull();
  expect(result).toBeDefined();
  if (result == null) throw new Error('expected MCP tool result');
  if (expectedError !== undefined) expect(result.isError).toBe(expectedError);
  const text = result.content?.[0]?.text;
  expect(text).toBeDefined();
  if (text === undefined) throw new Error('expected text in first content block');
  return text;
}

export const getFirstContentText = (result: PartialMcpToolResultLike | null | undefined): string =>
  expectMcpResultText(result);

export const expectMcpText = (result: PartialMcpToolResultLike | null | undefined): string =>
  expectMcpResultText(result, false);

export const expectMcpErrorText = (result: PartialMcpToolResultLike | null | undefined): string =>
  expectMcpResultText(result, true);
