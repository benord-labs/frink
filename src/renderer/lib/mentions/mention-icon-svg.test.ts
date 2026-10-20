// @vitest-environment happy-dom
import pythonIcon from '@iconify-icons/vscode-icons/file-type-python';
import rubyIcon from '@iconify-icons/vscode-icons/file-type-ruby';
import typescriptIcon from '@iconify-icons/vscode-icons/file-type-typescript';
import type { LucideIconData } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import {
  iconifySvgMarkup,
  lucideSvgMarkup,
  mentionIconElement,
} from '@/lib/mentions/mention-icon-svg';

// The shape of lucide's per-icon data, including the React `key` each node carries.
const toolCaseData: LucideIconData = {
  name: 'tool-case',
  size: 24,
  node: [
    ['path', { d: 'M10 15h4', key: '192ueg' }],
    ['path', { d: 'M4 12.006A1 1 0 0 1 4.994 11H19a1 1 0 0 1 1 1v7z', key: '1vaooh' }],
  ],
};

describe('mention icon svg', () => {
  it('draws an Iconify icon at its own viewBox', () => {
    const svg = mentionIconElement(iconifySvgMarkup(typescriptIcon));
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 32 32');
    expect(svg.innerHTML).toContain('<path');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws a lucide icon with lucide defaults and its name class', () => {
    const svg = mentionIconElement(lucideSvgMarkup(toolCaseData));
    expect(svg.getAttribute('class')).toBe('lucide lucide-tool-case');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.querySelectorAll('path')).toHaveLength(toolCaseData.node.length);
    expect(svg.querySelector('[key]')).toBeNull();
  });

  it('draws nested lucide children', () => {
    const markup = lucideSvgMarkup({
      name: 'nested',
      node: [['g', { fill: 'red' }, [['circle', { r: 2 }]]]],
    });
    const svg = mentionIconElement(markup);
    expect(svg.querySelector('g > circle')?.getAttribute('r')).toBe('2');
  });

  it('renames gradient ids and their references on every call', () => {
    const markup = iconifySvgMarkup(pythonIcon);
    const [first, second] = [mentionIconElement(markup), mentionIconElement(markup)];
    const firstIds = [...first.querySelectorAll('[id]')].map((el) => el.id);
    const secondIds = [...second.querySelectorAll('[id]')].map((el) => el.id);
    expect(firstIds).toHaveLength(2);
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
    const fills = [...first.querySelectorAll('path')].map((el) => el.getAttribute('fill'));
    expect(fills).toEqual(firstIds.map((id) => `url(#${id})`));
  });

  it('renames only id declarations and references, not other values equal to an id', () => {
    const body =
      '<linearGradient id="g.1"/><path class="g.1" data-id="g.1" fill="url(#g.1)"/><use href="#g.1"/>' +
      `<rect fill="url('#g.1')"/><circle fill='url("#g.1")'/><use xlink:href='#g.1'/>`;
    const svg = mentionIconElement(iconifySvgMarkup({ width: 16, height: 16, body }));
    const id = svg.querySelector('linearGradient')?.id;
    expect(id).toMatch(/^g\.1-m\d+$/);
    expect(svg.querySelector('path')?.getAttribute('class')).toBe('g.1');
    expect(svg.querySelector('path')?.getAttribute('data-id')).toBe('g.1');
    expect(svg.querySelector('path')?.getAttribute('fill')).toBe(`url(#${id})`);
    expect(svg.querySelector('rect')?.getAttribute('fill')).toBe(`url('#${id}')`);
    expect(svg.querySelector('circle')?.getAttribute('fill')).toBe(`url("#${id}")`);
    const hrefs = [...svg.querySelectorAll('use')].map(
      (el) => el.outerHTML.match(/href="([^"]+)"/)?.[1],
    );
    expect(hrefs).toEqual([`#${id}`, `#${id}`]);
  });

  // Ruby is the densest bundled icon (16 ids, 17 references incl. gradient-to-gradient hrefs).
  it('keeps every reference pointing at a renamed id in the same svg', () => {
    const svg = mentionIconElement(iconifySvgMarkup(rubyIcon));
    const ids = new Set([...svg.querySelectorAll('[id]')].map((el) => el.id));
    const refs = [...svg.outerHTML.matchAll(/(?:url\(#|href="#)([^)"]+)/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(ids.size);
    expect(refs.filter((ref) => !ids.has(ref))).toEqual([]);
    expect([...ids].filter((id) => rubyIcon.body.includes(`id="${id}"`))).toEqual([]);
  });
});
