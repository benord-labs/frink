// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { clearSearchHighlights, highlightSearchText } from './highlight-search-text';

function hostOf(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

function marks(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('mark'), (mark) => mark.outerHTML);
}

const plain = '<mark class="search-highlight">';
const current = '<mark class="search-highlight search-highlight-current">';

describe('highlightSearchText', () => {
  it('marks every occurrence in its own casing and emphasises the one picked by count', () => {
    const host = hostOf('<p>Open the <b>open</b> door, reopen it.</p>');

    highlightSearchText(host, 'open', ({ index }) => index === 1);

    expect(marks(host)).toEqual([
      `${plain}Open</mark>`,
      `${current}open</mark>`,
      `${plain}open</mark>`,
    ]);
    expect(host.textContent).toBe('Open the open door, reopen it.');
  });

  it('marks the right characters after a letter whose lower-case form is longer', () => {
    const host = hostOf('<p>\u0130stanbul and (a+b)</p>');

    highlightSearchText(host, 'stanbul', () => false);
    expect(marks(host)).toEqual([`${plain}stanbul</mark>`]);

    highlightSearchText(host, '(a+b)', () => false);
    expect(marks(host)).toEqual([`${plain}(a+b)</mark>`]);
  });

  it('emphasises the occurrence picked by its offset in the text of the nodes that hold the query', () => {
    const host = hostOf('<p>no hit here</p><p>one two</p><p>two one two</p>');
    const offsets: number[] = [];

    highlightSearchText(host, 'two', ({ offset }) => {
      offsets.push(offset);
      return offset === 7;
    });

    expect(offsets).toEqual([4, 7, 15]);
    expect(marks(host)).toEqual([
      `${plain}two</mark>`,
      `${current}two</mark>`,
      `${plain}two</mark>`,
    ]);
  });

  it('leaves out text marked as skipped, counting only the text beside it', () => {
    const host = hostOf(
      '<p>see <span>src/a.ts:42</span><span data-search-skip><b>a.ts</b></span> and a.ts</p>',
    );

    highlightSearchText(host, 'a.ts', ({ index }) => index === 1);

    expect(host.querySelector('[data-search-skip]')?.innerHTML).toBe('<b>a.ts</b>');
    expect(marks(host)).toEqual([`${plain}a.ts</mark>`, `${current}a.ts</mark>`]);
  });

  it('flags hidden stand-in text while it holds the current match, and unflags it when cleared', () => {
    const host = hostOf('<p><span data-search-stand-in>src/a.ts</span> and a.ts</p>');
    const standIn = host.querySelector('[data-search-stand-in]');

    highlightSearchText(host, 'a.ts', ({ index }) => index === 0);
    expect(standIn?.hasAttribute('data-search-current')).toBe(true);

    highlightSearchText(host, 'a.ts', ({ index }) => index === 1);
    expect(standIn?.hasAttribute('data-search-current')).toBe(false);

    highlightSearchText(host, 'a.ts', ({ index }) => index === 0);
    clearSearchHighlights(host);
    expect(standIn?.hasAttribute('data-search-current')).toBe(false);
  });

  it('replaces the highlights of an earlier query and restores the text when cleared', () => {
    const html = '<p>Open the <b>open</b> door.</p>';
    const host = hostOf(html);

    highlightSearchText(host, 'open', () => false);
    highlightSearchText(host, 'door', () => true);
    expect(marks(host)).toEqual([`${current}door</mark>`]);

    highlightSearchText(host, '', () => true);
    expect(host.innerHTML).toBe(html);

    highlightSearchText(host, 'the', () => false);
    clearSearchHighlights(host);
    expect(host.innerHTML).toBe(html);
  });
});
