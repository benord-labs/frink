import { escapeRegExp } from '../../../../shared/utils/escape-regexp';

// Set on hidden text that a badge stands in for while it holds the current match, so the badge
// can be styled from an attribute; a `:has()` rule here would restyle the whole page per change.
const CURRENT_STAND_IN = 'data-search-current';

/** Where a highlight sits: its count among the highlights and its offset in the searched text. */
type HighlightPosition = { index: number; offset: number };

/** Unwraps every search highlight under `container`, restoring its plain text. */
export function clearSearchHighlights(container: HTMLElement): void {
  container.querySelectorAll(`[${CURRENT_STAND_IN}]`).forEach((standIn) => {
    standIn.removeAttribute(CURRENT_STAND_IN);
  });
  container.querySelectorAll('.search-highlight').forEach((mark) => {
    const parent = mark.parentNode;
    mark.replaceWith(mark.textContent ?? '');
    parent?.normalize();
  });
}

// A badge marked `data-search-skip` stands in for hidden text beside it, which is searched instead.
function searchedTextNodes(container: HTMLElement, search: RegExp): Text[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const isSkipped = node.parentElement?.closest('[data-search-skip]');
    if (!isSkipped && node instanceof Text && node.data.search(search) !== -1) {
      nodes.push(node);
    }
  }
  return nodes;
}

/** Wraps each occurrence of `searchText` under `container` in a mark; `isCurrent` picks the emphasised one. */
export function highlightSearchText(
  container: HTMLElement,
  searchText: string,
  isCurrent: (position: HighlightPosition) => boolean,
): void {
  clearSearchHighlights(container);
  if (!searchText) return;

  // Matched on the text itself, so offsets hold where lower-casing would change its length.
  const search = new RegExp(escapeRegExp(searchText), 'gi');
  let index = 0;
  let nodeStart = 0;
  for (const node of searchedTextNodes(container, search)) {
    const text = node.data;
    const pieces: (string | HTMLElement)[] = [];
    let end = 0;
    for (const match of text.matchAll(search)) {
      const mark = document.createElement('mark');
      mark.className = 'search-highlight';
      mark.textContent = match[0];
      const position = { index: index++, offset: nodeStart + match.index };
      if (isCurrent(position)) {
        mark.classList.add('search-highlight-current');
        node.parentElement?.closest('[data-search-stand-in]')?.setAttribute(CURRENT_STAND_IN, '');
      }
      pieces.push(text.slice(end, match.index), mark);
      end = match.index + match[0].length;
    }
    node.replaceWith(...[...pieces, text.slice(end)].filter(Boolean));
    nodeStart += text.length;
  }
}
