// @vitest-environment happy-dom
import githubLogo from '@iconify-icons/simple-icons/github';
import { Icon } from '@iconify/react/offline';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Globe } from 'lucide-react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatMarkdownRenderer, MemoizedMarkdown } from '../chat-markdown-renderer';
import { MarkdownLink } from './index';

type Mode = 'streaming' | 'static';

const LINK_CLASSES =
  'text-blue-600 dark:text-blue-400 no-underline hover:underline hover:decoration-current underline-offset-2 decoration-1 transition-all duration-150 cursor-pointer focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-blue-500/30 focus-visible:rounded-sm';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

/** What the first icon under `element` draws, so two icons compare by their picture. */
function drawing(element: ReactNode): string | undefined {
  return toHost(element).querySelector('svg')?.innerHTML;
}

const GITHUB_MARK = drawing(<Icon icon={githubLogo} />);
const GLOBE = drawing(<Globe />);

describe.each<Mode>(['streaming', 'static'])('links in %s markdown', (mode) => {
  it.each([
    ['github.com', '[docs](https://github.com/a/b)'],
    ['a github.com subdomain', '[gist](https://gist.github.com/a/b)'],
  ])('leads a link to %s with the GitHub mark', (_case, markdown) => {
    expect(drawing(markdownView(markdown, mode))).toBe(GITHUB_MARK);
  });

  it.each([
    ['another https host', '[site](https://example.com/a)'],
    ['an http host', '[site](http://example.com/a)'],
    ['a bare autolink', 'see https://example.com/a now'],
    ['a host that only ends like github.com', '[site](https://notgithub.com/a)'],
    ['a host that only carries github.com as its user', '[site](https://github.com@example.com/a)'],
  ])('leads a link to %s with the globe', (_case, markdown) => {
    expect(drawing(markdownView(markdown, mode))).toBe(GLOBE);
  });

  it('draws one decorative icon before the words and leaves the words as they were', () => {
    const host = toHost(markdownView('read [the **docs**](https://example.com/a) first', mode));
    const link = host.querySelector('a');
    const icon = link?.firstElementChild;
    expect(host.querySelectorAll('svg')).toHaveLength(1);
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.querySelector('svg')).not.toBeNull();
    expect(link?.querySelector('img, image, use')).toBeNull();
    expect(link?.textContent).toBe('the docs');
    expect(link?.className).toBe(LINK_CLASSES);
    // An empty span holds the icon's room and the icon is drawn over it, so no line breaks at it.
    expect(icon?.className).toBe('relative ps-4.5');
    expect(icon?.textContent).toBe('');
    expect(icon?.firstElementChild?.getAttribute('class')).toMatch(
      /(^| )absolute inset-y-0 inset-s-0 my-auto size-3\.5$/,
    );
  });

  it.each([
    ['mail', '[mail](mailto:a@b.co)'],
    ['a bare email address', 'mail a@b.co today'],
    ['a blocked scheme', '[x](javascript:alert(1))'],
    ['a path inside the app', '[users](/api/users)'],
    ['a link around only an image', '[![logo](https://example.com/i.png)](https://example.com)'],
  ])('draws no icon for %s', (_case, markdown) => {
    expect(toHost(markdownView(markdown, mode)).querySelector('svg')).toBeNull();
  });

  it.each([
    ['[mail](mailto:a@b.co)', 'mailto:a@b.co', 'mail'],
    ['[users](/api/users)', '/api/users', 'users'],
  ])('renders the link %s exactly as it did without icons', (markdown, href, words) => {
    expect(toHost(markdownView(markdown, mode)).querySelector('a')?.outerHTML).toBe(
      `<a href="${href}" class="${LINK_CLASSES}" target="_blank" rel="noopener noreferrer" node="[object Object]">${words}</a>`,
    );
  });

  it('opens web and mail links in the system browser and nothing else', () => {
    const openExternal = vi.fn();
    vi.stubGlobal('desktopApi', { openExternal });
    const { container } = render(
      markdownView(
        '[site](https://example.com/a) [mail](mailto:a@b.co) [users](/api/users) [top](#top)',
        mode,
      ),
    );

    for (const link of container.querySelectorAll('a')) expect(fireEvent.click(link)).toBe(false);

    expect(openExternal.mock.calls).toEqual([['https://example.com/a'], ['mailto:a@b.co']]);
  });
});

describe('MarkdownLink on its own', () => {
  it.each(['javascript:alert(1)', 'file:///etc/hosts', 'vscode://file/a.ts', 'not a url'])(
    'draws no icon for %s and does not open it',
    (href) => {
      const openExternal = vi.fn();
      vi.stubGlobal('desktopApi', { openExternal });
      const { container, getByText } = render(<MarkdownLink href={href}>words</MarkdownLink>);

      fireEvent.click(getByText('words'));

      expect(container.querySelector('svg')).toBeNull();
      expect(openExternal).not.toHaveBeenCalled();
    },
  );
});
