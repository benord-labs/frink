// culori's colour modes are registered by ../palette/color, imported below.
import { differenceEuclidean } from 'culori/fn';
import { holdThemeSwitching } from '../paint-theme';
import { toHex } from '../palette/color';
import { ROLE_VARS, ROLES, type Role } from '../palette/roles';

// `shadow` (box and text shadows) can be clicked but never counts as a place a role is shown.
type PaintKind = 'background' | 'border' | 'foreground' | 'shadow';
type PaintSnapshot = Record<PaintKind, string>;

/** An element and the role that paints it. */
type Inspection = { element: Element; role: Role };
/** What hover shows: the painting element, and its role when a class provably paints it. */
type HoverHit = { element: Element; role: Role | null };

const PAINT_KINDS: readonly PaintKind[] = ['background', 'border', 'foreground', 'shadow'];
const BORDER_SIDES = ['top', 'right', 'bottom', 'left'] as const;
const INVISIBLE_PAINT = new Set(['', 'none', 'transparent', 'rgba(0, 0, 0, 0)']);

// Two decimals: no theme (written to one decimal) or globals.css value can equal it.
const SENTINEL = '163.71 97.31% 50.13%';

/** Roles are coded index + 1, so 0 means "no role"; five bits cover all 18. */
const BIT_COUNT = Math.ceil(Math.log2(ROLES.length + 1));

const oklabDistance = differenceEuclidean('oklab');
// A computed value's colour functions: `rgb(…)`, `oklab(…)`, `color(srgb …)`, a gradient's stops.
const COLOR_FUNCTION = /[a-z-]+\([^()]*\)/g;

const HIT_CHAIN_LIMIT = 15;
const USAGE_CAP = 3000;

// Opacity prunes hidden keep-alive chat tabs and content-visibility off-screen message groups;
// aria-hidden can't, as every lucide icon carries it.
const SKIPPED_SELECTOR = '[data-theme-editor-panel]';
const COUNTABLE_VISIBILITY = {
  contentVisibilityAuto: true,
  opacityProperty: true,
  visibilityProperty: true,
};

// frink-primitives' bridge tokens (globals.css :root) alias role vars under their own names.
const BRIDGE_TOKENS = {
  bg: 'background',
  surface: 'background',
  elevated: 'surface',
  raised: 'overlay',
  field: 'field',
  'field-border': 'input',
  ink: 'text',
  'muted-fg': 'mutedText',
  dim: 'mutedText',
  'primary-fg': 'accentForeground',
  danger: 'destructive',
  rim: 'border',
  hairline: 'border',
  'hairline-strong': 'border',
} satisfies Record<string, Role>;

/** Tailwind colour name → role: each role var minus `--`, plus the bridge tokens. */
const ROLE_BY_TOKEN = new Map<string, Role>([
  ...ROLES.flatMap((role) => ROLE_VARS[role].map((name) => [name.slice(2), role] as const)),
  ...Object.entries(BRIDGE_TOKENS),
]);

// globals.css repoints the `text-muted` utility at faded text; `bg-muted` stays the soft fill.
const TEXT_UTILITY_ROLES = new Map<string, Role>([['muted', 'mutedText']]);

const COLOR_UTILITY = /^!?(bg|text|border(?:-[xytrblse])?|outline|fill|stroke)-(.+?)!?$/;
const ARBITRARY_VAR = /var\(--([\w-]+)/;
const UTILITY_PAINT = new Map<string, { kind: PaintKind; property: string }>([
  ['bg', { kind: 'background', property: 'background-color' }],
  ['text', { kind: 'foreground', property: 'color' }],
  ['fill', { kind: 'foreground', property: 'fill' }],
  ['stroke', { kind: 'foreground', property: 'stroke' }],
  ['outline', { kind: 'border', property: 'outline-color' }],
]);
const BORDER_SIDE_BY_SUFFIX = new Map([
  ['r', 'right'],
  ['e', 'right'],
  ['b', 'bottom'],
  ['l', 'left'],
  ['s', 'left'],
  ['x', 'left'],
]);

type UtilityPaint = { role: Role; kind: PaintKind; property: string };

/** The role a colour utility names and the property it sets: `bg-card/80`, `border-t-border`. */
export function roleFromUtilityClass(className: string): UtilityPaint | null {
  // A variant (`hover:`, `dark:`) may not be painting now.
  if (className.includes(':')) return null;
  const [, prefix = '', value = ''] = COLOR_UTILITY.exec(className) ?? [];
  const token = value.startsWith('[') ? ARBITRARY_VAR.exec(value)?.[1] : value.split('/')[0];
  const role =
    token === undefined
      ? undefined
      : (prefix === 'text' && TEXT_UTILITY_ROLES.get(token)) || ROLE_BY_TOKEN.get(token);
  if (!role) return null;
  const paint = UTILITY_PAINT.get(prefix);
  if (paint) return { role, ...paint };
  const side = BORDER_SIDE_BY_SUFFIX.get(prefix.slice('border-'.length)) ?? 'top';
  return { role, kind: 'border', property: `border-${side}-color` };
}

/** `target` and its ancestors, nearest first, below <html>. */
function hitChain(target: Element): Element[] {
  const chain: Element[] = [];
  for (
    let element: Element | null = target;
    element && element !== document.documentElement && chain.length < HIT_CHAIN_LIMIT;
    element = element.parentElement
  ) {
    chain.push(element);
  }
  return chain;
}

/**
 * The role a utility on `owners` paints `kind` of `element` with, checked against the element's
 * computed colour (a hover state or CSS rule may be painting instead); null when none is.
 */
function paintingUtilityRole(element: Element, kind: PaintKind, owners: Element[]): Role | null {
  const painted = getComputedStyle(element);
  const probe = document.body.appendChild(document.createElement('span'));
  probe.hidden = true;
  try {
    for (const owner of owners) {
      const utilities = [...owner.classList]
        .map((className) => ({ className, paint: roleFromUtilityClass(className) }))
        .filter(({ paint }) => paint?.kind === kind);
      if (utilities.length === 0) continue;
      const match = utilities.find(({ className, paint }) => {
        probe.className = className;
        const property = paint?.property ?? '';
        return (
          getComputedStyle(probe).getPropertyValue(property) === painted.getPropertyValue(property)
        );
      });
      return match?.paint?.role ?? null;
    }
    return null;
  } finally {
    probe.remove();
  }
}

/**
 * Hover: the nearest element that paints on its own (the one a click resolves to), named by a colour
 * utility only when it is painting it now. No sentinel probe; role null means "click to inspect".
 */
export function inspectHover(target: Element): HoverHit {
  const chain = hitChain(target);
  for (const [index, element] of chain.entries()) {
    const paint = paintSnapshot(element);
    const kind = paint && PAINT_KINDS.find((candidate) => paint[candidate] !== '');
    if (!kind) continue;
    // Colour inherits, so an ancestor's text utility may be what paints this element's text.
    const owners = kind === 'foreground' ? chain.slice(index) : [element];
    return { element, role: paintingUtilityRole(element, kind, owners) };
  }
  return { element: target, role: null };
}

export function isEditorElement(element: Element): boolean {
  return element.closest('[data-theme-editor-panel]') !== null;
}

/** The terminal or code editor around `element`: they paint from their own themes, not CSS vars. */
export function uninspectableHost(element: Element): Element | null {
  return element.closest('.xterm, .monaco-editor');
}

function hasOwnText(element: Element): boolean {
  if (element.matches('input, textarea, select')) return true;
  return [...element.childNodes].some(
    (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
  );
}

function visiblePaint(values: string[]): string {
  return values.filter((value) => !INVISIBLE_PAINT.has(value)).join(' ');
}

type ReadStyle = (property: string) => string;

/** Colours of the border sides and outline that have width. */
function borderColors(read: ReadStyle): string[] {
  const border = BORDER_SIDES.filter(
    (side) =>
      read(`border-${side}-style`) !== 'none' &&
      Number.parseFloat(read(`border-${side}-width`)) > 0,
  ).map((side) => read(`border-${side}-color`));
  if (read('outline-style') !== 'none' && Number.parseFloat(read('outline-width')) > 0) {
    border.push(read('outline-color'));
  }
  return border;
}

/** Text colour counts only with the element's own text; SVG fill and stroke always count. */
function foregroundColors(element: Element, read: ReadStyle, ownText: boolean): string[] {
  const foreground = ownText ? [read('color')] : [];
  if (ownText && read('text-decoration-line') !== 'none') {
    foreground.push(read('text-decoration-color'));
  }
  if (element instanceof SVGElement) foreground.push(read('fill'), read('stroke'));
  return foreground;
}

/**
 * What an element paints itself, per kind ('' for none); null when hidden. A container that merely
 * passes its colour down paints no foreground.
 */
function paintSnapshot(element: Element): PaintSnapshot | null {
  const style = getComputedStyle(element);
  const read: ReadStyle = (property) => style.getPropertyValue(property);
  if (read('display') === 'none' || read('visibility') === 'hidden' || read('opacity') === '0') {
    return null;
  }
  const border = borderColors(read);
  const ownText = hasOwnText(element);
  return {
    background: visiblePaint([read('background-color'), read('background-image')]),
    border: visiblePaint([...border, border.length > 0 ? read('border-image-source') : '']),
    foreground: visiblePaint(foregroundColors(element, read, ownText)),
    shadow: visiblePaint([read('box-shadow'), ownText ? read('text-shadow') : '']),
  };
}

/** Each element's paint with transitions held, so a running one can't pass for a probe's change. */
function baselinePaint(elements: readonly Element[]): (PaintSnapshot | null)[] {
  holdThemeSwitching();
  return elements.map((element) => paintSnapshot(element));
}

/** Puts every var of `roles` on the sentinel colour; returns the restore. */
function wearSentinel(roles: readonly Role[]): () => void {
  const { style } = document.documentElement;
  const saved = roles
    .flatMap((role) => ROLE_VARS[role])
    .map((name) => ({
      name,
      value: style.getPropertyValue(name),
      priority: style.getPropertyPriority(name),
    }));
  for (const { name } of saved) style.setProperty(name, SENTINEL, 'important');
  return () => {
    for (const { name, value, priority } of saved) {
      if (value) style.setProperty(name, value, priority);
      else style.removeProperty(name);
    }
  };
}

/** Each element's paint while `roles` wear the sentinel; null where it was hidden. */
function sentinelPaint(
  elements: readonly Element[],
  baseline: readonly (PaintSnapshot | null)[],
  roles: readonly Role[],
): (PaintSnapshot | null)[] {
  const restore = wearSentinel(roles);
  try {
    return elements.map((element, index) => (baseline[index] ? paintSnapshot(element) : null));
  } finally {
    restore();
  }
}

/** The paint kinds each element changes while `roles` wear the sentinel. */
function probe(
  elements: readonly Element[],
  baseline: readonly (PaintSnapshot | null)[],
  roles: readonly Role[],
): PaintKind[][] {
  return sentinelPaint(elements, baseline, roles).map((after, index) => {
    const before = baseline[index];
    return before && after ? PAINT_KINDS.filter((kind) => before[kind] !== after[kind]) : [];
  });
}

/** Bit-slice probe `bit` covers every role whose code has that bit. */
function sliceRoles(bit: number): Role[] {
  return ROLES.filter((_, index) => ((index + 1) >> bit) % 2 === 1);
}

/** How far a paint moved: the OKLab distance of each colour it lists, summed; 0 when none parse. */
function paintDistance(before: string, after: string): number {
  const moved = after.match(COLOR_FUNCTION) ?? [];
  return (before.match(COLOR_FUNCTION) ?? []).reduce((sum, value, index) => {
    const from = toHex(value);
    const to = toHex(moved[index] ?? '');
    return from && to ? sum + oklabDistance(from, to) : sum;
  }, 0);
}

/** A mixed paint's main role: of the roles within `code`'s bits, the one whose sentinel moves it
 * furthest (a `color-mix` moves by each role's share); ties keep ROLES order. */
function dominantRole(
  element: Element,
  before: PaintSnapshot | null,
  kind: PaintKind,
  code: number,
): Role | undefined {
  let dominant: Role | undefined;
  let furthest = -1;
  for (const [index, role] of ROLES.entries()) {
    if (((index + 1) | code) !== code) continue;
    const after = sentinelPaint([element], [before], [role])[0]?.[kind];
    if (!before || after === undefined || after === before[kind]) continue;
    const shift = paintDistance(before[kind], after);
    if (shift > furthest) [dominant, furthest] = [role, shift];
  }
  return dominant;
}

/** Click: the role painting the nearest element under the pointer: five bit-sliced probes, then one
 * per role the code may hold (a `color-mix` can spell another role); sentinels restore at once. */
export function inspectRoleAt(target: Element): Inspection | null {
  const chain = hitChain(target);
  const baseline = baselinePaint(chain);
  const slices = Array.from({ length: BIT_COUNT }, (_, bit) =>
    probe(chain, baseline, sliceRoles(bit)),
  );
  for (const [index, element] of chain.entries()) {
    const before = baseline[index] ?? null;
    for (const kind of PAINT_KINDS) {
      const code = slices.reduce(
        (bits, kinds, bit) => (kinds[index]?.includes(kind) ? bits | (1 << bit) : bits),
        0,
      );
      if (code === 0) continue;
      const role = dominantRole(element, before, kind, code);
      return role ? { element, role } : null;
    }
  }
  return null;
}

function isOnScreen({ top, right, bottom, left }: DOMRect): boolean {
  return bottom >= 0 && right >= 0 && top <= window.innerHeight && left <= window.innerWidth;
}

/** Visibility first, so a skipped content-visibility subtree is never laid out. `display: contents`
 * wrappers and boxes at most 1px both ways (screen-reader text) are walked through, not pruned. */
function candidateFilter(node: Node): number {
  if (!(node instanceof Element) || node.matches(SKIPPED_SELECTOR)) return NodeFilter.FILTER_REJECT;
  if (node.checkVisibility(COUNTABLE_VISIBILITY)) {
    const rect = node.getBoundingClientRect();
    if (!isOnScreen(rect)) return NodeFilter.FILTER_REJECT;
    return rect.width > 1 || rect.height > 1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
  }
  return getComputedStyle(node).display === 'contents'
    ? NodeFilter.FILTER_SKIP
    : NodeFilter.FILTER_REJECT;
}

/** Elements a usage count may include: visible, on screen, outside the editor; capped. */
export function usageCandidates(root: Element): Element[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: candidateFilter,
  });
  const candidates: Element[] = [root];
  for (
    let node = walker.nextNode();
    node instanceof Element && candidates.length < USAGE_CAP;
    node = walker.nextNode()
  ) {
    candidates.push(node);
  }
  return candidates;
}

/** Everything on screen painting `role` itself (text, fill, border) in one probe; an SVG's parts
 * count as the icon, and `clicked` (the picked element) is always probed past the cap. */
export function roleUsage(role: Role, clicked?: Element | null): Element[] {
  const candidates = usageCandidates(document.body);
  if (clicked?.isConnected && !candidates.includes(clicked)) candidates.push(clicked);
  const baseline = baselinePaint(candidates);
  const changed = probe(candidates, baseline, [role]);
  const painted = candidates.filter((_, index) =>
    changed[index]?.some((kind) => kind !== 'shadow'),
  );
  return [
    ...new Set(
      painted.map((element) =>
        element instanceof SVGElement ? (element.closest('svg') ?? element) : element,
      ),
    ),
  ];
}
