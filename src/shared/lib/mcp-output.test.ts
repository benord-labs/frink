import { describe, expect, it } from 'vitest';
import { isSpilledToolResultText, unwrapMcpOutput } from './mcp-output';

describe('unwrapMcpOutput', () => {
  it('parses joined text from an array of content blocks', () => {
    const out = unwrapMcpOutput([
      { type: 'text', text: '{"hello":' },
      { type: 'text', text: '"world"}' },
    ]);
    expect(out).toEqual({ hello: 'world' });
  });

  it('returns joined string when text is not valid JSON', () => {
    expect(unwrapMcpOutput([{ type: 'text', text: 'plain' }])).toBe('plain');
  });

  it('unwraps a single text content block', () => {
    expect(unwrapMcpOutput({ type: 'text', text: '{"a":1}' })).toEqual({ a: 1 });
  });

  it('unwraps an indexed-object form (post JSON round-trip)', () => {
    const out = unwrapMcpOutput({ '0': { type: 'text', text: '{"flowId":"f1"}' } });
    expect(out).toEqual({ flowId: 'f1' });
  });

  it('unwraps the standard CallToolResult envelope used by Codex', () => {
    expect(
      unwrapMcpOutput({
        content: [{ type: 'text', text: '{"status":"success","flowId":"flow-1"}' }],
        _meta: {},
      }),
    ).toEqual({ status: 'success', flowId: 'flow-1' });
  });

  it('prefers structured CallToolResult content when present', () => {
    expect(
      unwrapMcpOutput({
        structuredContent: { status: 'success', flowId: 'flow-structured' },
        content: [{ type: 'text', text: '{"status":"failure"}' }],
      }),
    ).toEqual({ status: 'success', flowId: 'flow-structured' });
  });

  it('falls back from empty structured content to text content', () => {
    expect(
      unwrapMcpOutput({
        structuredContent: {},
        content: [{ type: 'text', text: '{"status":"success"}' }],
      }),
    ).toEqual({ status: 'success' });
  });

  it('preserves empty text and ignores blocks beyond the provider limit', () => {
    expect(unwrapMcpOutput([{ type: 'text', text: '' }])).toBe('');

    const blocks = Array.from({ length: 64 }, () => ({ type: 'text', text: 'x' }));
    blocks.push({ type: 'text', text: 'ignored' });
    expect(unwrapMcpOutput(blocks)).toBe('x'.repeat(64));
  });

  it('bounds joined content text before parsing provider output', () => {
    const maximumText = 'x'.repeat(1_000_000);

    expect(
      unwrapMcpOutput([
        { type: 'text', text: maximumText },
        { type: 'text', text: 'ignored' },
      ]),
    ).toBe(maximumText);
  });

  it('parses a raw JSON string', () => {
    expect(unwrapMcpOutput('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns a raw non-JSON string unchanged', () => {
    expect(unwrapMcpOutput('not json')).toBe('not json');
  });

  it('passes through an already-parsed object', () => {
    expect(unwrapMcpOutput({ already: 'object' })).toEqual({ already: 'object' });
  });

  it('returns undefined and null unchanged', () => {
    expect(unwrapMcpOutput(undefined)).toBeUndefined();
    expect(unwrapMcpOutput(null)).toBeNull();
  });

  it('returns the array unchanged when no text content blocks are present', () => {
    const arr = [{ foo: 'bar' }];
    expect(unwrapMcpOutput(arr)).toBe(arr);
  });
});

// Literal harness text from claude-agent-sdk 0.3.278. Re-check both when the SDK is upgraded.
const TOKEN_CAP_SPILL =
  'Error: result (87,548 characters) exceeds maximum allowed tokens. Output has been saved to /Users/me/claude-sessions/abc/projects/-p/tool-results/mcp-frink-frink_flows_patch-1.txt. Format: JSON with schema: {status: string}';
const PERSISTED_OUTPUT_SPILL =
  '<persisted-output>\nOutput too large (112.4KB). Full output saved to: /Users/me/claude-sessions/abc/tool-results/toolu_1.txt\n\nPreview (first 2KB):\n{"status":"success"';

describe('isSpilledToolResultText', () => {
  it.each([
    ['token-cap spill', TOKEN_CAP_SPILL],
    ['token-cap spill with a Windows path', TOKEN_CAP_SPILL.replace('/Users/me', 'C:\\Users\\me')],
    [
      'token-cap spill with a Windows UNC path',
      TOKEN_CAP_SPILL.replace(/\/Users\/me\S*/, '\\\\server\\share\\tool-results\\result.txt.'),
    ],
    [
      'persisted-output spill with a Windows UNC path',
      'Output too large (112.4KB). Full output saved to: \\\\server\\share\\toolu_1.txt\n\nPreview (first 2KB):\n{',
    ],
    [
      'token-cap spill with spaces in a UNC share and folder',
      TOKEN_CAP_SPILL.replace(
        /\/Users\/me\S*/,
        '\\\\server\\Shared Folder\\tool results\\result.txt.',
      ),
    ],
    [
      'token-cap spill with a line count',
      TOKEN_CAP_SPILL.replace('characters', 'characters across 2,104 lines'),
    ],
    ['persisted-output spill', PERSISTED_OUTPUT_SPILL],
    ['unwrapped persisted-output spill', PERSISTED_OUTPUT_SPILL.replace('<persisted-output>', '')],
    ['spill after leading whitespace', `\n  ${TOKEN_CAP_SPILL}`],
    // The CLI formats the count with toLocaleString, so the host locale decides the separator.
    ['spill counted in a German locale', TOKEN_CAP_SPILL.replace('87,548', '87.548')],
    ['spill counted in a French locale', TOKEN_CAP_SPILL.replace('87,548', '87\u202f548')],
    [
      'spill saved under a macOS path with spaces',
      TOKEN_CAP_SPILL.replace('/Users/me', '/Users/me/Library/Application Support/Frink'),
    ],
  ])('recognises a %s', (_label, text) => {
    expect(isSpilledToolResultText(text)).toBe(true);
  });

  it.each([
    ['a transport error', 'Connection closed after tool execution'],
    ['a version conflict', 'Failed to save patched flow version (conflict): Version conflict.'],
    ['a receipt', JSON.stringify({ status: 'success', flowId: 'flow-1' })],
    ['a size complaint that saved nothing', 'Error: result exceeds maximum allowed tokens.'],
    ['an empty string', ''],
    [
      'a token-cap note followed by prose instead of the format clause',
      'Error: result (1 characters) exceeds maximum allowed tokens. Output has been saved to /x but saving failed.',
    ],
    [
      'a persisted-output note with no preview after the path',
      'Output too large (1KB). Full output saved to: /x but saving failed.',
    ],
    [
      'a persisted-output note naming only a UNC host',
      'Output too large (1KB). Full output saved to: \\\\server',
    ],
    [
      'a persisted-output note naming only a UNC share',
      'Output too large (1KB). Full output saved to: \\\\server\\share',
    ],
    [
      'a token-cap note whose path is only a backslash pair',
      TOKEN_CAP_SPILL.replace(/\/Users\/me\S*/, '\\\\ .'),
    ],
    // The CLI's other oversize note: nothing was written to disk and the body was cut short.
    [
      'an oversize note whose output could not be saved',
      'Output too large (112.4KB). It could not be saved, so only the first 2KB are shown; the rest was dropped.',
    ],
    [
      'a token-cap note that names no file',
      TOKEN_CAP_SPILL.replace(/saved to .*/s, 'saved to disk.'),
    ],
    [
      'a persisted-output note that names no file',
      'Output too large (2KB). Full output saved to: the session folder',
    ],
    [
      'a token-cap note that names no saved file',
      'Error: result (9 characters) exceeds maximum allowed tokens. Output has been saved to ',
    ],
    [
      'a persisted-output note that names no saved file',
      'Output too large (2KB). Full output saved to:',
    ],
    [
      'a persisted-output note followed only by whitespace',
      'Output too large (2KB). Full output saved to: \n',
    ],
    ['prose that quotes the token-cap note', `Documentation: ${TOKEN_CAP_SPILL}`],
    [
      'prose that quotes the persisted-output note',
      `The log said: Output too large (2KB). Full output saved to: /tmp/x`,
    ],
    ['a result that only mentions the sentence', `Saved. ${TOKEN_CAP_SPILL.slice(7)}`],
  ])('does not treat %s as a spill', (_label, text) => {
    expect(isSpilledToolResultText(text)).toBe(false);
  });
});
