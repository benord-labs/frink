// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Streamdown } from 'streamdown';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TAGS,
  ChatMarkdownRenderer,
  getStreamdownComponents,
  MemoizedMarkdown,
  REMARK_PLUGINS,
} from '../../components/chat-markdown-renderer';
import { FileLinkBadgeContext, type FileReference } from './file-link-badge-context';
import { remarkFileLinks } from './remark-file-links';

type Mode = 'streaming' | 'static';

const WITHOUT_FILE_LINKS = REMARK_PLUGINS.filter((plugin) => plugin !== remarkFileLinks);

function renderTestBadge({ path, line, label }: FileReference): ReactNode {
  return <mark data-path={path} data-line={line} data-label={label} />;
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

function renderWithBadges(markdown: string, mode: Mode): HTMLElement {
  return toHost(
    <FileLinkBadgeContext value={renderTestBadge}>
      {markdownView(markdown, mode)}
    </FileLinkBadgeContext>,
  );
}

function badges(host: HTMLElement) {
  return Array.from(host.querySelectorAll('mark'), ({ dataset }) => ({ ...dataset }));
}

/** The renderer's own Streamdown setup with no badge provider, with or without file links. */
function streamdownHtml(markdown: string, mode: Mode, plugins = REMARK_PLUGINS): string {
  return renderToStaticMarkup(
    <Streamdown
      mode={mode}
      components={getStreamdownComponents('sm', 'file-links-test', false)}
      remarkPlugins={plugins}
      allowedTags={ALLOWED_TAGS}
      controls={false}
      skipHtml
    >
      {markdown}
    </Streamdown>,
  );
}

describe.each<Mode>(['streaming', 'static'])('file references in %s markdown', (mode) => {
  it('draws one badge per file link and path-shaped inline code', () => {
    const host = renderWithBadges(
      'Fixed [app.py](/Users/x/app.py:12), [the handler](</Users/x/My Project/h.ts>), ' +
        '[notes](~/notes/a.md#L3) and `src/a.ts:42`, not `index.ts`.',
      mode,
    );
    expect(badges(host)).toEqual([
      { path: '/Users/x/app.py', line: '12', label: 'app.py' },
      { path: '/Users/x/My Project/h.ts', label: 'the handler' },
      { path: '~/notes/a.md', line: '3', label: 'notes' },
      { path: 'src/a.ts', line: '42', label: 'src/a.ts:42' },
    ]);
    expect(host.textContent).toContain('not index.ts.');
  });

  it('draws path-shaped code inside bold, a heading and a table cell', () => {
    const host = renderWithBadges(
      '## see `src/h.ts`\n\n**`src/b.ts:3`**\n\n| f |\n|---|\n| `src/t.ts` |',
      mode,
    );
    expect(badges(host).map(({ path }) => path)).toEqual(['src/h.ts', 'src/b.ts', 'src/t.ts']);
  });

  it.each([
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](data:text/html,hi)',
    '[x](vscode://file/Users/x/a.ts)',
  ])('leaves the blocked link %s exactly as before', (markdown) => {
    expect(badges(renderWithBadges(markdown, mode))).toEqual([]);
    const html = streamdownHtml(markdown, mode);
    expect(html).toBe(streamdownHtml(markdown, mode, WITHOUT_FILE_LINKS));
    expect(toHost(html).querySelector('a[href]')).toBeNull();
  });

  it.each([
    '[docs](https://github.com/a/b)',
    'see https://example.com/a.ts now',
    '<https://example.com/x.ts>',
    '[users](/api/users)',
  ])('leaves the web link %s exactly as before', (markdown) => {
    expect(badges(renderWithBadges(markdown, mode))).toEqual([]);
    expect(streamdownHtml(markdown, mode)).toBe(streamdownHtml(markdown, mode, WITHOUT_FILE_LINKS));
  });

  it.each(['see `src/a.t', 'open [app.py](/Users/x/app.py:1'])(
    'draws no badge for the half-arrived %j',
    (markdown) => {
      expect(badges(renderWithBadges(markdown, mode))).toEqual([]);
    },
  );

  it('keeps code inside a web link as code, with no badge inside the link', () => {
    const host = renderWithBadges('[`src/a.ts`](https://github.com/x/y/blob/main/src/a.ts)', mode);
    expect(badges(host)).toEqual([]);
    expect(host.querySelector('a')?.textContent).toBe('src/a.ts');
  });

  it.each([
    '[app.py](/Users/x/app.py:12)',
    '[index.ts](</Users/benji/Desktop/Personal and learning/frink/src/preload/index.ts:12>)',
    '[the handler](file:///Users/x/h.ts) and [docs](./docs/a.md)',
    'see `src/a.ts:42`, `~/x/y.json` and `/abs/a.ts`',
    '## see `src/a.ts`\n\n| f |\n|---|\n| `src/a.ts` |',
  ])('renders %j exactly as before when no surface draws badges', (markdown) => {
    expect(streamdownHtml(markdown, mode)).toBe(streamdownHtml(markdown, mode, WITHOUT_FILE_LINKS));
    expect(toHost(markdownView(markdown, mode)).querySelector('frink-file')).toBeNull();
  });
});
