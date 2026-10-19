import type { IconifyIcon } from '@iconify/react/offline';
import type { LucideIconData, LucideIconNode } from 'lucide-react';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ID_ATTR_REGEX = /\bid="([^"]+)"/g;
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

/** A fresh, decorative svg node per call, with ids made unique so chips never share gradients. */
export function mentionIconElement(markup: string): SVGSVGElement {
  const suffix = `-m${++idSuffix}`;
  let unique = markup;
  for (const [, id] of markup.matchAll(ID_ATTR_REGEX)) {
    unique = unique.replace(new RegExp(`(["#])${id}(["')])`, 'g'), `$1${id}${suffix}$2`);
  }
  const template = document.createElement('template');
  template.innerHTML = unique;
  // SAFETY: both markup builders emit a single root <svg>, so the first child is always an svg.
  const svg = template.content.firstElementChild as SVGSVGElement;
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}
