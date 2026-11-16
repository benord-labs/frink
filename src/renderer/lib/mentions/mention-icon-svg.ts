import type { IconifyIcon } from '@iconify/react/offline';
import type { LucideIconData, LucideIconNode } from 'lucide-react';

const SVG_NS = 'http://www.w3.org/2000/svg';
const URL_QUOTES = ['', "'", '"'];
const LUCIDE_SVG_ATTRS =
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

let idSuffix = 0;

export function iconifySvgMarkup(icon: IconifyIcon): string {
  return `<svg xmlns="${SVG_NS}" viewBox="0 0 ${icon.width ?? 16} ${icon.height ?? 16}">${icon.body}</svg>`;
}

function lucideNodeMarkup([tag, attrs, children]: LucideIconNode): string {
  const attrText = Object.entries(attrs)
    .filter(([name]) => name !== 'key')
    .map(([name, value]) => ` ${name}="${value}"`)
    .join('');
  return `<${tag}${attrText}>${(children ?? []).map(lucideNodeMarkup).join('')}</${tag}>`;
}

export function lucideSvgMarkup(icon: LucideIconData): string {
  const size = icon.size ?? 24;
  return `<svg xmlns="${SVG_NS}" viewBox="0 0 ${size} ${size}" ${LUCIDE_SVG_ATTRS} class="lucide lucide-${icon.name}">${icon.node.map(lucideNodeMarkup).join('')}</svg>`;
}

/** Points each `#id` link (`href`, `xlink:href`) and `url(#id)` reference at its renamed id. */
function relinkAttribute(attr: Attr, renamed: Map<string, string>): void {
  if (attr.name.endsWith('href')) {
    const target = attr.value.startsWith('#') ? renamed.get(attr.value.slice(1)) : undefined;
    if (target) attr.value = `#${target}`;
    return;
  }
  if (!attr.value.includes('url(')) return;
  for (const [from, to] of renamed) {
    for (const q of URL_QUOTES) {
      attr.value = attr.value.replaceAll(`url(${q}#${from}${q})`, `url(${q}#${to}${q})`);
    }
  }
}

/** A fresh, decorative svg node per call, with ids made unique so chips never share gradients. */
export function mentionIconElement(markup: string): SVGSVGElement {
  const template = document.createElement('template');
  template.innerHTML = markup;
  // SAFETY: both markup builders emit a single root <svg>, so the first child is always an svg.
  const svg = template.content.firstElementChild as SVGSVGElement;
  const suffix = `-m${++idSuffix}`;
  const renamed = new Map<string, string>();
  for (const el of svg.querySelectorAll('[id]')) {
    renamed.set(el.id, `${el.id}${suffix}`);
    el.id = `${el.id}${suffix}`;
  }
  if (renamed.size > 0) {
    for (const el of svg.querySelectorAll('*')) {
      for (const attr of el.attributes) relinkAttribute(attr, renamed);
    }
  }
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}
