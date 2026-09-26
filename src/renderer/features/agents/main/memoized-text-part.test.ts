// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoizedTextPart, splitReproduceBlocks } from './memoized-text-part';

/** Mutable stand-in for the search context so tests can drive the highlight effect. */
const searchState: {
  query: string;
  highlights: Array<{ isCurrent: boolean; indexInPart: number }>;
} = vi.hoisted(() => ({ query: '', highlights: [] }));

vi.mock('../search', () => ({
  useSearchHighlight: () => searchState.highlights,
  useSearchQuery: () => searchState.query,
}));

beforeEach(() => {
  searchState.query = '';
  searchState.highlights = [];
});

/**
 * Each test name states one clause of the contract; the ruling behind them all
 * is the decision `debug-reproduce-block-rendering`.
 */
describe('splitReproduceBlocks', () => {
  // ── Active card at end ─────────────────────────────────────────────────────

  it('renders a card for a closed <reproduce> block at the end of the message', () => {
    const input = 'Here is the plan:\n<reproduce>\n1. Do this\n</reproduce>';
    const segments = splitReproduceBlocks(input);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ type: 'text', content: 'Here is the plan:\n' });
    expect(segments[1]).toEqual({ type: 'reproduce', content: '1. Do this' });
  });

  it('renders a card for an unclosed <reproduce> at the end of the message (streaming)', () => {
    const input = 'Steps:\n\n<reproduce>\n1. Open app\n2. Click button';
    const segments = splitReproduceBlocks(input);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ type: 'text', content: 'Steps:\n\n' });
    expect(segments[1]).toEqual({ type: 'reproduce', content: '1. Open app\n2. Click button' });
  });

  it('does not turn a half-arrived closing tag into a step while streaming', () => {
    // `</reproduce>` lands one character at a time; a partial prefix is tag
    // machinery, not an instruction the user should ever read.
    const segments = splitReproduceBlocks('Intro\n<reproduce>\n1. A\n2. B\n</reprodu');

    expect(segments[segments.length - 1]).toEqual({ type: 'reproduce', content: '1. A\n2. B' });
  });

  it('renders no card and emits a single text segment when the message contains no <reproduce> tags', () => {
    const input = 'Just a normal message with no special tags.';
    const segments = splitReproduceBlocks(input);

    expect(segments).toEqual([{ type: 'text', content: input }]);
  });

  // ── Position independence: the card survives trailing prose ───────────────

  it('keeps a mid-message <reproduce> block as a trailing card when text follows it', () => {
    const input =
      'Here are some hypotheses.\n\n<reproduce>\n1. Open the app\n2. Click debug\n</reproduce>\n\nLet me know.';
    const segments = splitReproduceBlocks(input);

    expect(segments).toHaveLength(2);
    expect(segments[0].type).toBe('text');
    expect(segments[0].content).not.toContain('<reproduce>');
    expect(segments[0].content).toContain('Here are some hypotheses.');
    expect(segments[0].content).toContain('Let me know.');
    expect(segments[1]).toEqual({
      type: 'reproduce',
      content: '1. Open the app\n2. Click debug',
    });
  });

  it('keeps prose written both before and after the block, with the card last', () => {
    const input = 'X\nY\nZ\n<reproduce>\n1. Do the thing\n</reproduce>\nA\nB\nC';
    const segments = splitReproduceBlocks(input);

    expect(segments).toHaveLength(2);
    expect(segments[0].content).toBe('X\nY\nZ\n\nA\nB\nC');
    expect(segments[1]).toEqual({ type: 'reproduce', content: '1. Do the thing' });
  });

  it('renders the real block as the card when a fenced example follows it', () => {
    const input =
      'Now reproduce:\n<reproduce>\n1. Real step\n</reproduce>\n\n```\n<reproduce>\nexample step\n</reproduce>\n```';
    const segments = splitReproduceBlocks(input);

    expect(segments[segments.length - 1]).toEqual({ type: 'reproduce', content: '1. Real step' });
    for (const seg of segments) {
      expect(seg.content).not.toContain('example step');
    }
  });

  it('renders only the LAST <reproduce> as a card when multiple are present, stripping the earlier ones', () => {
    const input =
      'First:\n<reproduce>\n1. Step A\n</reproduce>\nSecond:\n<reproduce>\n1. Step B\n</reproduce>';
    const segments = splitReproduceBlocks(input);

    expect(segments).toHaveLength(2);
    expect(segments[0].type).toBe('text');
    expect(segments[0].content).not.toContain('Step A');
    expect(segments[0].content).toContain('First:');
    expect(segments[0].content).toContain('Second:');
    expect(segments[1]).toEqual({ type: 'reproduce', content: '1. Step B' });
  });

  it('keeps an earlier real block as the card when a later block is empty', () => {
    // An agent that opens a second block and thinks better of it must not erase
    // the steps it already wrote — the empty block is not a retraction.
    const input = 'Steps:\n<reproduce>\n1. Real step\n</reproduce>\nOops:\n<reproduce></reproduce>';
    const segments = splitReproduceBlocks(input);

    expect(segments).toHaveLength(2);
    expect(segments[0].content).not.toContain('<reproduce>');
    expect(segments[1]).toEqual({ type: 'reproduce', content: '1. Real step' });
  });

  it('strips an empty <reproduce></reproduce> block from view', () => {
    const input = 'Before\n<reproduce></reproduce>\nAfter';
    const segments = splitReproduceBlocks(input);

    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe('text');
    expect(segments[0].content).not.toContain('<reproduce>');
  });

  it('strips a whitespace-only <reproduce> block from view', () => {
    const input = 'Before\n<reproduce>\n   \n\n</reproduce>\nAfter';
    const segments = splitReproduceBlocks(input);

    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe('text');
    expect(segments[0].content).not.toContain('<reproduce>');
  });

  // ── Code-region interaction ────────────────────────────────────────────────

  it('strips a closed <reproduce> example sitting inside a fenced code block', () => {
    // Bug from the user's screenshot: the agent showed the format inside ``` and
    // the literal step text leaked through to the rendered code block. Even
    // though it was visually inside a code fence, the user shouldn't see step
    // content masquerading as instructions when there's no active card.
    const input =
      'Example format:\n\n```\n<reproduce>\n1. Restart the app\n2. Open a new chat\n</reproduce>\n```\n\nSee above.';
    const segments = splitReproduceBlocks(input);

    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe('text');
    expect(segments[0].content).not.toContain('<reproduce>');
    expect(segments[0].content).not.toContain('1. Restart the app');
    expect(segments[0].content).toContain('Example format:');
    expect(segments[0].content).toContain('See above.');
  });

  it('closes a CRLF fenced block so a following real <reproduce> still becomes a card', () => {
    // An unclosable CRLF fence runs to end-of-text and swallows the real block.
    const input =
      'Example:\r\n\r\n```\r\ncode\r\n```\r\n\r\nNow:\r\n<reproduce>\r\n1. Real step\r\n</reproduce>';
    const segments = splitReproduceBlocks(input);

    expect(segments[segments.length - 1]).toEqual({ type: 'reproduce', content: '1. Real step' });
  });

  it('preserves an orphan </reproduce> with no opener instead of gobbling the message', () => {
    // A tool call can split one logical block across two text parts; the part
    // holding only the closing tag must still render its prose.
    const input = 'Continuing steps\n2. B\n</reproduce>\nDone.';
    const segments = splitReproduceBlocks(input);

    expect(segments).toEqual([{ type: 'text', content: input }]);
  });

  it('does not gobble the rest of the message when an unclosed <reproduce> sits inside an inline code span', () => {
    // The exact screenshot pattern: agent explaining "...inside a `<reproduce>`
    // block at the end…". The unclosed tag must NOT match (would eat to EOS),
    // and the literal text must be preserved verbatim for the markdown renderer.
    const input = 'Use `<reproduce>` and finish with a numbered list.';
    const segments = splitReproduceBlocks(input);

    expect(segments).toEqual([{ type: 'text', content: input }]);
  });

  it('preserves an inline-code mention while still rendering a real <reproduce> at the end as a card', () => {
    const input =
      'Note that `<reproduce>` is mandatory. Now reproduce:\n<reproduce>\n1. Click X\n2. Observe Y\n</reproduce>';
    const segments = splitReproduceBlocks(input);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({
      type: 'text',
      content: 'Note that `<reproduce>` is mandatory. Now reproduce:\n',
    });
    expect(segments[1]).toEqual({ type: 'reproduce', content: '1. Click X\n2. Observe Y' });
  });

  it('strips a fenced example AND renders the trailing real <reproduce> as a card', () => {
    const input =
      'Example format:\n\n```\n<reproduce>\nexample step\n</reproduce>\n```\n\nNow reproduce:\n<reproduce>\n1. Real step\n</reproduce>';
    const segments = splitReproduceBlocks(input);

    // Last segment should be the active card with the REAL content.
    const last = segments[segments.length - 1];
    expect(last).toEqual({ type: 'reproduce', content: '1. Real step' });

    // No segment should leak the example content.
    for (const seg of segments) {
      expect(seg.content).not.toContain('example step');
    }
  });

  // ── Raw render mode still strips reproduce content ─────────────────────────
  // Critical guard: the raw (markdown-off) path renders the STRIPPED text
  // segments via TextSegmentBody (seg.content), NOT the verbatim message text —
  // so an earlier <reproduce> example is dropped exactly as in markdown mode.
  it('strips an earlier <reproduce> example in raw mode when an active card is present', () => {
    const input =
      'Intro line.\n<reproduce>\nexample secret\n</reproduce>\nNow reproduce:\n<reproduce>\n1. Real step\n</reproduce>';
    render(
      createElement(MemoizedTextPart, {
        text: input,
        messageId: 'r1',
        partIndex: 0,
        isFinalText: false,
        visibleStepsCount: 0,
        renderMarkdown: false,
      }),
    );

    expect(screen.queryByText(/example secret/)).not.toBeInTheDocument();
    expect(screen.getByText(/Now reproduce/)).toBeInTheDocument();
  });

  it('strips a fenced <reproduce> example in raw mode when it is the only block', () => {
    const input =
      'Example format:\n\n```\n<reproduce>\n1. Restart the app\n</reproduce>\n```\n\nSee above.';
    render(
      createElement(MemoizedTextPart, {
        text: input,
        messageId: 'r2',
        partIndex: 0,
        isFinalText: false,
        visibleStepsCount: 0,
        renderMarkdown: false,
      }),
    );

    expect(screen.queryByText(/Restart the app/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Reproduction Steps/)).not.toBeInTheDocument();
    expect(screen.getByText(/Example format:/)).toBeInTheDocument();
  });

  it('renders nothing for a message that is only an empty <reproduce> block', () => {
    const { container } = render(
      createElement(MemoizedTextPart, {
        text: '<reproduce></reproduce>',
        messageId: 'r3',
        partIndex: 0,
        isFinalText: false,
        visibleStepsCount: 0,
        renderMarkdown: false,
      }),
    );

    expect(container.textContent).toBe('');
  });

  // ── Streaming stability ───────────────────────────────────────────────────

  it('keeps the card mounted when the agent writes prose after the closing tag', () => {
    const props = {
      messageId: 's1',
      partIndex: 0,
      isFinalText: false,
      visibleStepsCount: 0,
      renderMarkdown: false,
    };
    const closed = 'Intro.\n<reproduce>\n1. Open app\n</reproduce>';
    const { rerender } = render(createElement(MemoizedTextPart, { ...props, text: closed }));

    const before = screen.getByText('Open app');
    rerender(createElement(MemoizedTextPart, { ...props, text: `${closed}\nLet me know.` }));

    expect(screen.getByText('Open app')).toBe(before);
    expect(screen.getByText(/Let me know/)).toBeInTheDocument();
  });

  it('keeps the card mounted when a text segment appears ahead of it', () => {
    const props = {
      messageId: 's2',
      partIndex: 0,
      isFinalText: false,
      visibleStepsCount: 0,
      renderMarkdown: false,
    };
    const only = '<reproduce>\n1. Open app\n</reproduce>';
    const { rerender } = render(createElement(MemoizedTextPart, { ...props, text: only }));

    const before = screen.getByText('Open app');
    rerender(createElement(MemoizedTextPart, { ...props, text: `${only}\nOk.` }));

    expect(screen.getByText('Open app')).toBe(before);
  });
});

/**
 * Highlighting runs over the RENDERED DOM after paint; the search index is
 * built from raw text. These cover the DOM half only.
 */
describe('MemoizedTextPart search highlighting', () => {
  const props = {
    messageId: 'h1',
    partIndex: 0,
    isFinalText: false,
    visibleStepsCount: 0,
    renderMarkdown: false,
  };
  const text = 'Open the app, then open the panel, then open the log.';

  const marks = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('.search-highlight'));

  it('wraps every occurrence of the query in a highlight mark', () => {
    searchState.query = 'open';
    const { container } = render(createElement(MemoizedTextPart, { ...props, text }));

    const found = marks(container);
    expect(found).toHaveLength(3);
    // Case-insensitive match, but the ORIGINAL casing is preserved in the mark.
    expect(found[0].textContent).toBe('Open');
    expect(found[1].textContent).toBe('open');
    expect(container.textContent).toBe(text);
  });

  it('emphasises only the highlight flagged as current', () => {
    searchState.query = 'open';
    searchState.highlights = [{ isCurrent: true, indexInPart: 1 }];
    const { container } = render(createElement(MemoizedTextPart, { ...props, text }));

    const current = marks(container).map((el) => el.classList.contains('search-highlight-current'));
    expect(current).toEqual([false, true, false]);
  });

  it('removes existing marks when the query is cleared', () => {
    searchState.query = 'open';
    const { container, rerender } = render(createElement(MemoizedTextPart, { ...props, text }));
    expect(marks(container)).toHaveLength(3);

    searchState.query = '';
    rerender(createElement(MemoizedTextPart, { ...props, text: `${text} ` }));

    expect(marks(container)).toHaveLength(0);
    expect(container.textContent).toContain('Open the app');
  });

  it('skips highlighting while the part is still streaming', () => {
    searchState.query = 'open';
    const { container } = render(
      createElement(MemoizedTextPart, { ...props, text, isStreaming: true }),
    );

    expect(marks(container)).toHaveLength(0);
  });

  it('leaves the DOM untouched when the query matches nothing', () => {
    searchState.query = 'nonexistent';
    const { container } = render(createElement(MemoizedTextPart, { ...props, text }));

    expect(marks(container)).toHaveLength(0);
    expect(container.textContent).toBe(text);
  });
});
