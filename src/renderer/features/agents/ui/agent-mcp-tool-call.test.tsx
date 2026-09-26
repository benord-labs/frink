// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

const { highlightCodeMock } = vi.hoisted(() => ({
  highlightCodeMock: vi.fn(),
}));

vi.mock('../../../lib/themes/shiki-theme-loader', () => ({
  highlightCode: (code: string, lang: string, theme: string) =>
    highlightCodeMock(code, lang, theme),
}));

vi.mock('../../../lib/hooks/use-code-theme', () => ({
  useCodeTheme: () => 'mock-theme',
}));

vi.mock('../../../components/ui/text-shimmer', () => ({
  TextShimmer: (props: { children: ReactNode; className?: string }) => (
    <span data-testid="text-shimmer">{props.children}</span>
  ),
}));

import type { MessagePart } from '../stores/message-store';
import {
  AgentMcpToolCall,
  formatMcpArgs,
  formatOutputForDisplay,
  formatOutputPreview,
  getResultCount,
  unwrapMcpOutput,
} from './agent-mcp-tool-call';
import type { McpToolInfo } from './agent-tool-registry';

const mcpInfo: McpToolInfo = {
  serverName: 'codebase',
  toolName: 'search_code',
  displayName: 'Search Code',
  category: 'search',
};

function makePart(overrides: Partial<MessagePart> = {}): MessagePart {
  return {
    type: 'tool-mcp__codebase__search_code',
    state: 'output-available',
    toolCallId: 'call-1',
    input: { query: 'hello world' },
    output: { results: [{ path: 'a.ts' }, { path: 'b.ts' }] } as unknown as Record<string, unknown>,
    ...overrides,
  };
}

describe('unwrapMcpOutput', () => {
  it('joins an array of text content blocks and parses JSON', () => {
    const out = unwrapMcpOutput([
      { type: 'text', text: '{"hello":' },
      { type: 'text', text: '"world"}' },
    ]);
    expect(out).toEqual({ hello: 'world' });
  });

  it('returns the joined string when array text is not valid JSON', () => {
    const out = unwrapMcpOutput([{ type: 'text', text: 'plain' }]);
    expect(out).toBe('plain');
  });

  it('unwraps a single text content block', () => {
    expect(unwrapMcpOutput({ type: 'text', text: '{"a":1}' })).toEqual({ a: 1 });
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

  it('returns undefined unchanged', () => {
    expect(unwrapMcpOutput(undefined)).toBeUndefined();
  });
});

describe('getResultCount', () => {
  it('returns plural count for a top-level array', () => {
    expect(getResultCount([1, 2, 3])).toBe('3 results');
  });

  it('returns singular count for a one-element array', () => {
    expect(getResultCount([1])).toBe('1 result');
  });

  it('picks the longest nested array on an object', () => {
    expect(getResultCount({ results: [1, 2], other: [1] })).toBe('2 results');
  });

  it('returns null when no array can be found', () => {
    expect(getResultCount({ a: 1 })).toBeNull();
    expect(getResultCount(null)).toBeNull();
  });
});

describe('formatMcpArgs', () => {
  it('returns empty string for missing/empty input', () => {
    expect(formatMcpArgs(undefined)).toBe('');
    expect(formatMcpArgs({})).toBe('');
  });

  it('caps at two arg pairs', () => {
    const out = formatMcpArgs({ a: 1, b: 2, c: 3, d: 4 });
    expect(out.split('  ')).toHaveLength(2);
  });

  it('keeps insertion order without applying a priority list', () => {
    const out = formatMcpArgs({ random: 'x', query: 'find me' });
    expect(out.startsWith('random: x')).toBe(true);
  });

  it('truncates values longer than 80 characters', () => {
    const out = formatMcpArgs({ query: 'a'.repeat(100) });
    expect(out).toContain('...');
    expect(out.length).toBeLessThan(95);
  });

  it('keeps values up to 80 characters intact', () => {
    const eighty = 'a'.repeat(80);
    expect(formatMcpArgs({ query: eighty })).toBe(`query: ${eighty}`);
  });
});

describe('formatOutputForDisplay', () => {
  it('pretty-prints an object as JSON', () => {
    expect(formatOutputForDisplay({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('does not truncate long output (container handles scroll)', () => {
    const big = { value: 'x'.repeat(5000) };
    const out = formatOutputForDisplay(big);
    expect(out.endsWith('...')).toBe(false);
    expect(out.length).toBeGreaterThan(4000);
  });

  it('returns a placeholder for circular references instead of throwing', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    expect(() => formatOutputForDisplay(circular)).not.toThrow();
    expect(formatOutputForDisplay(circular)).toBe('[unserialisable output]');
  });
});

describe('formatOutputPreview', () => {
  it('collapses whitespace into a single-line preview', () => {
    expect(formatOutputPreview('\n\n  hello world\nsecond line')).toBe('hello world second line');
  });

  it('truncates lines longer than the configured max length', () => {
    const out = formatOutputPreview('x'.repeat(200), 60);
    expect(out.length).toBe(60);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns empty string for empty output', () => {
    expect(formatOutputPreview(undefined)).toBe('');
    expect(formatOutputPreview('')).toBe('');
  });
});

describe('AgentMcpToolCall', () => {
  it('renders the MCP display name as the title for completed tools', () => {
    highlightCodeMock.mockResolvedValue('<pre>highlighted</pre>');
    render(<AgentMcpToolCall part={makePart()} mcpInfo={mcpInfo} chatStatus="ready" />);
    expect(screen.getByText('Search Code')).toBeInTheDocument();
  });

  it('renders the same display-name title while streaming (shimmer signals state)', () => {
    highlightCodeMock.mockResolvedValue('<pre>highlighted</pre>');
    render(
      <AgentMcpToolCall
        part={makePart({ state: 'input-streaming', output: undefined })}
        mcpInfo={mcpInfo}
        chatStatus="streaming"
      />,
    );
    expect(screen.getByText('Search Code')).toBeInTheDocument();
  });

  it('shows an inline output preview when collapsed and hides it once expanded', () => {
    highlightCodeMock.mockResolvedValue('<pre>highlighted</pre>');
    render(
      <AgentMcpToolCall
        part={makePart({
          output: { summary: 'preview snippet for collapsed view' } as unknown as Record<
            string,
            unknown
          >,
        })}
        mcpInfo={mcpInfo}
        chatStatus="ready"
      />,
    );
    expect(screen.getByText(/preview snippet for collapsed view/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText(/^\{$/)).toBeNull();
  });

  it('renders the expand toggle as a real button with aria-expanded', () => {
    highlightCodeMock.mockResolvedValue('<pre>highlighted</pre>');
    render(<AgentMcpToolCall part={makePart()} mcpInfo={mcpInfo} chatStatus="ready" />);
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('does not render a live <script> when JSON output contains script markup', async () => {
    highlightCodeMock.mockImplementation((code: string) => {
      const escaped = code.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return Promise.resolve(`<pre>${escaped}</pre>`);
    });
    const part = makePart({
      output: { value: '<script>alert(1)</script>' } as unknown as Record<string, unknown>,
    });
    const { container } = render(
      <AgentMcpToolCall part={part} mcpInfo={mcpInfo} chatStatus="ready" />,
    );
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => {
      expect(container.querySelector('script')).toBeNull();
    });
    expect(container.innerHTML).toContain('&lt;script&gt;');
  });
});
