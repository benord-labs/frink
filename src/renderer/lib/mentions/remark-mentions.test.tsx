// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Streamdown } from 'streamdown';
import { describe, expect, it } from 'vitest';
import {
  ChatMarkdownRenderer,
  getStreamdownComponents,
  MemoizedMarkdown,
  REMARK_PLUGINS,
} from '../../components/chat-markdown-renderer';
import { MentionChipContext } from './mention-chip-context';

type Mode = 'streaming' | 'static';

function renderTestChip(id: string): ReactNode {
  return <mark data-id={id}>chip</mark>;
}

function toHost(element: ReactNode): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(element);
  return host;
}

/** Streaming mode goes through ChatMarkdownRenderer, static mode through MemoizedMarkdown. */
function markdownView(markdown: string, mode: Mode): ReactNode {
  if (mode === 'static') return <MemoizedMarkdown content={markdown} id="test" />;
  return <ChatMarkdownRenderer content={markdown} />;
}

function renderMarkdown(markdown: string, mode: Mode, renderChip = renderTestChip): HTMLElement {
  return toHost(
    <MentionChipContext.Provider value={renderChip}>
      {markdownView(markdown, mode)}
    </MentionChipContext.Provider>,
  );
}

function chipIds(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('mark'), (mark) => mark.getAttribute('data-id') ?? '');
}

describe.each<Mode>(['streaming', 'static'])('mention tokens in %s markdown', (mode) => {
  it('draws a leading file mention as a chip and keeps the prose', () => {
    const host = renderMarkdown('@[file:local:.oxlintrc.json] how are you?', mode);
    expect(chipIds(host)).toEqual(['file:local:.oxlintrc.json']);
    expect(host.textContent).toBe('chip how are you?');
  });

  it.each([
    'src/__tests__/foo.test.ts',
    'pkg/__init__.py',
    'a*b/c*d.ts',
    '~a~/b.ts',
    'docs/www.example.com/a.md',
    'src\\_x\\.cfg\\a.ts',
    'src/app/[id]/page.tsx',
    'app/[[...slug]]/page.tsx',
  ])('keeps the path %s whole instead of reading it as markdown', (path) => {
    const host = renderMarkdown(`fix @[file:local:${path}] now`, mode);
    expect(chipIds(host)).toEqual([`file:local:${path}`]);
    expect(host.querySelector('strong, em, del, a')).toBeNull();
    expect(host.textContent).toBe('fix chip now');
  });

  it.each([
    ['inline code', 'keep `@[file:local:a.ts]` raw', '@[file:local:a.ts]'],
    ['a fence', '```\n@[file:local:b.ts]\n```', '@[file:local:b.ts]'],
    ['an unknown kind', 'see @[nope:x] here', '@[nope:x]'],
    ['an email address', 'mail a@b.co today', 'a@b.co'],
    ['a scoped package', 'install @types/node now', '@types/node'],
    ['an unterminated token', 'open @[file:local:a.ts and more', '@[file:local:a.ts and more'],
  ])('leaves %s as literal text', (_case, markdown, literal) => {
    const host = renderMarkdown(markdown, mode);
    expect(chipIds(host)).toEqual([]);
    expect(host.textContent).toContain(literal);
  });

  it.each([
    ['sum @[file:local:notes[draft.md] up', 'sum chip up'],
    ['sum @[file:local:notes[draft.md] is great] ok', 'sum chip is great] ok'],
  ])('ends an id with an unpaired bracket at the first closing bracket: %j', (markdown, text) => {
    const host = renderMarkdown(markdown, mode);
    expect(chipIds(host)).toEqual(['file:local:notes[draft.md']);
    expect(host.textContent).toBe(text);
  });

  it('draws two adjacent tokens as two chips', () => {
    const host = renderMarkdown('@[file:local:a.ts]@[skill:review]', mode);
    expect(chipIds(host)).toEqual(['file:local:a.ts', 'skill:review']);
  });

  it('ends a token at its bracket, before trailing punctuation', () => {
    const host = renderMarkdown('use (@[tool:mcp__figma__get_design]).', mode);
    expect(chipIds(host)).toEqual(['tool:mcp__figma__get_design']);
    expect(host.textContent).toBe('use (chip).');
  });

  it('draws a token inside bold and inside a list item', () => {
    const host = renderMarkdown(
      '**@[file:local:b.ts]**\n\n- @[skill:review] first\n- second',
      mode,
    );
    expect(host.querySelector('strong mark')?.getAttribute('data-id')).toBe('file:local:b.ts');
    expect(host.querySelector('li mark')?.getAttribute('data-id')).toBe('skill:review');
  });

  it('keeps a token inside image alt text', () => {
    const host = renderMarkdown('![@[file:local:a.ts]](x.png) fix', mode);
    expect(host.textContent).toContain('@[file:local:a.ts]');
  });

  it('shows the raw token when the surface provides no chip', () => {
    const host = toHost(markdownView('@[file:local:a.ts] hi', mode));
    expect(host.textContent).toBe('@[file:local:a.ts] hi');
  });

  it('shows the raw token when the chip renderer draws nothing', () => {
    const host = renderMarkdown('@[file:local:a.ts] hi', mode, () => null);
    expect(host.textContent).toBe('@[file:local:a.ts] hi');
  });

  it('shows the raw token when the mention element is not allowed through sanitising', () => {
    const host = toHost(
      <MentionChipContext.Provider value={renderTestChip}>
        <Streamdown
          mode={mode}
          components={getStreamdownComponents('sm', 'remark-mentions-test', false)}
          remarkPlugins={REMARK_PLUGINS}
          controls={false}
          skipHtml
        >
          {'@[file:local:a.ts] hi'}
        </Streamdown>
      </MentionChipContext.Provider>,
    );
    expect(chipIds(host)).toEqual([]);
    expect(host.textContent).toBe('@[file:local:a.ts] hi');
  });
});
