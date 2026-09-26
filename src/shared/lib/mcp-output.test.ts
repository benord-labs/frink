import { describe, expect, it } from 'vitest';
import { unwrapMcpOutput } from './mcp-output';

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
