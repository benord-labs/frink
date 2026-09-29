// @vitest-environment happy-dom
import { interpolate } from 'culori/fn';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROLE_VARS, ROLES } from '../palette/roles';
import {
  inspectHover,
  inspectRoleAt,
  isEditorElement,
  roleFromUtilityClass,
  roleUsage,
  uninspectableHost,
  usageCandidates,
} from './inspector';

const html = document.documentElement;

/** `data-mix="--a --b 15"` paints `color-mix(in oklab, a, b 15%)`, serialised as Chromium does. */
function mixedColor(element: Element): string {
  const [from, to, percent] = element.getAttribute('data-mix')?.split(' ') ?? [];
  if (!from || !to || !percent) return '';
  const { l, a, b } = interpolate(
    [`hsl(${html.style.getPropertyValue(from)})`, `hsl(${html.style.getPropertyValue(to)})`],
    'oklab',
  )(Number(percent) / 100);
  return `oklab(${l} ${a} ${b})`;
}

/** happy-dom computes no colours, so paint comes from data attributes (hover-like states) or plain
 * `bg-X`/`text-X` classes; `data-transition-from` paints until `html.theme-switching` cuts it. */
function fakeComputedStyle(element: Element): CSSStyleDeclaration {
  const resolve = (attribute: string, utility = ''): string =>
    (
      element.getAttribute(attribute)?.split(' ') ??
      [...element.classList]
        .filter((className) => utility && className.startsWith(`${utility}-`))
        .map((className) => `--${className.slice(utility.length + 1)}`)
    )
      .filter(Boolean)
      .map((name) => html.style.getPropertyValue(name))
      .join(',');
  const parent = element.parentElement;
  const transitioning = !html.classList.contains('theme-switching');
  const values = new Map([
    ['display', element.classList.contains('contents') ? 'contents' : 'block'],
    [
      'background-color',
      (transitioning && element.getAttribute('data-transition-from')) || resolve('data-bg', 'bg'),
    ],
    ['border-top-style', element.hasAttribute('data-border') ? 'solid' : 'none'],
    ['border-top-width', '1px'],
    ['border-top-color', resolve('data-border')],
    ['box-shadow', resolve('data-shadow')],
    [
      'color',
      mixedColor(element) ||
        resolve('data-fg', 'text') ||
        (parent ? fakeComputedStyle(parent).getPropertyValue('color') : ''),
    ],
    ['fill', resolve('data-fg')],
  ]);
  const style = document.createElement('div').style;
  style.getPropertyValue = (property) => values.get(property) ?? '';
  return style;
}

function byId(id: string): Element {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} is missing`);
  return element;
}

describe('what Inspect leaves alone', () => {
  it('knows the editor panel, and the terminal or code editor that paint their own colours', () => {
    const panel = document.createElement('div');
    panel.setAttribute('data-theme-editor-panel', '');
    const inPanel = panel.appendChild(document.createElement('button'));
    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    const cell = xterm.appendChild(document.createElement('span'));
    const plain = document.createElement('p');

    expect([isEditorElement(inPanel), isEditorElement(plain)]).toEqual([true, false]);
    expect(uninspectableHost(cell)).toBe(xterm);
    expect(uninspectableHost(plain)).toBeNull();
  });
});

describe('roleFromUtilityClass', () => {
  it.each([
    ['bg-card', 'surface', 'background', 'background-color'],
    ['bg-background/80', 'background', 'background', 'background-color'],
    ['!bg-tl-background', 'sidebar', 'background', 'background-color'],
    ['bg-popover/(--glass-opacity)', 'overlay', 'background', 'background-color'],
    ['text-muted-foreground', 'mutedText', 'foreground', 'color'],
    ['text-muted', 'mutedText', 'foreground', 'color'],
    ['bg-muted', 'muted', 'background', 'background-color'],
    ['text-[hsl(var(--card-foreground))]', 'text', 'foreground', 'color'],
    ['fill-primary', 'accent', 'foreground', 'fill'],
    ['text-ink', 'text', 'foreground', 'color'],
    ['border-border', 'border', 'border', 'border-top-color'],
    ['border-x-border', 'border', 'border', 'border-left-color'],
    ['border-b-field-border', 'input', 'border', 'border-bottom-color'],
    ['outline-ring', 'accent', 'border', 'outline-color'],
  ] as const)('%s → %s', (className, role, kind, property) => {
    expect(roleFromUtilityClass(className)).toEqual({ role, kind, property });
  });

  it.each([
    'hover:bg-accent',
    'dark:text-foreground',
    'text-sm',
    'border-transparent',
    'bg-red-500',
    'ring-ring',
  ])('ignores %s', (className) => {
    expect(roleFromUtilityClass(className)).toBeNull();
  });
});

describe('probing <html> role vars', () => {
  beforeEach(() => {
    ROLES.forEach((role, index) => {
      for (const name of ROLE_VARS[role]) html.style.setProperty(name, `0 0% ${index}%`);
    });
    html.style.removeProperty('--popover');
    // Chromium's opacity check covers ancestors too; the walk prunes at the transparent one.
    Element.prototype.checkVisibility = function (this: Element) {
      return !(this instanceof HTMLElement && this.style.opacity === '0');
    };
    vi.spyOn(window, 'getComputedStyle').mockImplementation(fakeComputedStyle);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 100, 20),
    );
    document.body.innerHTML = `
      <div id="panel" data-bg="--card">
        <span id="label" data-fg="--muted-foreground">Faded</span>
        <div id="plain"><i id="deep"></i></div>
        <div id="mix" data-bg="--card --popover"></div>
        <svg id="icon" aria-hidden="true"><path data-fg="--card"></path></svg>
        <div aria-hidden="true" style="opacity: 0" data-bg="--card"></div>
        <div data-theme-editor-panel data-bg="--card"></div>
      </div>`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
    html.removeAttribute('style');
    html.classList.remove('theme-switching');
  });

  it('names the role painting the nearest element and restores every var', () => {
    const before = html.style.cssText;
    expect(inspectRoleAt(byId('label'))).toEqual({ element: byId('label'), role: 'mutedText' });
    expect(inspectRoleAt(byId('deep'))).toEqual({ element: byId('panel'), role: 'surface' });
    expect(html.style.cssText).toBe(before);
    expect(html.style.getPropertyValue('--popover')).toBe('');
  });

  it('falls back to one probe per role when a paint mixes roles', () => {
    // surface (code 2) | overlay (code 4) spells muted (code 6), which the confirm probe rejects.
    expect(inspectRoleAt(byId('mix'))).toEqual({ element: byId('mix'), role: 'surface' });
  });

  it('names the role a colour mix is mostly made of, not the first in role order', () => {
    // Frink Glass re-inks faded text 15% and error text 7.5% toward text, by default.
    document.body.innerHTML = `
      <span id="faded" data-mix="--muted-foreground --foreground 15">Faded</span>
      <span id="error" data-mix="--destructive --foreground 7.5">Failed</span>`;
    expect(inspectRoleAt(byId('faded'))).toEqual({ element: byId('faded'), role: 'mutedText' });
    expect(inspectRoleAt(byId('error'))).toEqual({ element: byId('error'), role: 'destructive' });
  });

  it('names a mix by its main role even when the mixed codes spell another of its roles', () => {
    // background (code 1) | text (code 9) spells text; the window colour is 85% of this paint.
    document.body.innerHTML = '<span id="window" data-mix="--background --foreground 15">x</span>';
    expect(inspectRoleAt(byId('window'))).toEqual({ element: byId('window'), role: 'background' });
  });

  it('counts what a role paints on screen, an aria-hidden icon as one, never a hidden tab', () => {
    expect(roleUsage('surface')).toEqual([byId('panel'), byId('mix'), byId('icon')]);
  });

  it('counts only what paints the role itself, not containers passing it down', () => {
    document.body.innerHTML = `
      <div id="pane" data-fg="--foreground" data-shadow="--foreground">
        <span id="words">Words</span>
      </div>`;
    expect(roleUsage('text')).toEqual([byId('words')]);
    // A click can still land on a shadow.
    expect(inspectRoleAt(byId('pane'))).toEqual({ element: byId('pane'), role: 'text' });
  });

  it('walks through a display: contents wrapper and counts inherited text once, at its owner', () => {
    Element.prototype.checkVisibility = function (this: Element) {
      return !this.classList.contains('contents');
    };
    document.body.innerHTML = `
      <fieldset class="contents">
        <div id="row" class="text-foreground"><span id="name">Empty chat</span></div>
      </fieldset>`;
    expect(roleUsage('text')).toEqual([byId('name')]);
  });

  it('always probes the clicked element, even past the usage cap', () => {
    const deco = '<span id="deco" class="text-foreground">3✕</span>';
    document.body.innerHTML = '<i></i>'.repeat(3000) + deco;
    expect(roleUsage('text')).toEqual([]);
    expect(roleUsage('text', byId('deco'))).toEqual([byId('deco')]);
    expect(roleUsage('mutedText', byId('deco'))).toEqual([]);
  });

  describe('while a hover transition is still running', () => {
    beforeEach(() => {
      document.body.innerHTML =
        '<div id="btn" class="bg-muted" data-transition-from="1 2% 3%">Open</div>';
    });

    it('names the role the element resolves to, not the transition’s start colour', () => {
      expect(inspectRoleAt(byId('btn'))).toEqual({ element: byId('btn'), role: 'muted' });
    });

    it('does not count the element for a role it does not paint', () => {
      expect(roleUsage('surface')).toEqual([]);
    });
  });

  it('hovers the element that paints, named by the class painting it', () => {
    document.body.innerHTML = `
      <div id="card" class="bg-card p-2"><i id="gap"></i></div>
      <div class="text-muted-foreground"><span id="faded">Faded</span></div>`;
    expect(inspectHover(byId('gap'))).toEqual({ element: byId('card'), role: 'surface' });
    expect(inspectHover(byId('faded'))).toEqual({ element: byId('faded'), role: 'mutedText' });
    expect(document.body.childElementCount).toBe(2);
  });

  it('hovers without a role when a hover state or rule outpaints the class', () => {
    document.body.innerHTML = `
      <div class="text-muted-foreground hover:text-foreground" data-fg="--foreground">
        <span id="row">Empty chat</span>
      </div>
      <div class="bg-card" data-bg="--accent"><i id="lit"></i></div>
      <i id="bare"></i>`;
    expect(inspectHover(byId('row'))).toEqual({ element: byId('row'), role: null });
    expect(inspectRoleAt(byId('row'))).toEqual({ element: byId('row'), role: 'text' });
    expect(inspectHover(byId('lit')).role).toBeNull();
    expect(inspectHover(byId('bare'))).toEqual({ element: byId('bare'), role: null });
  });
});

describe('usageCandidates', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('prunes hidden, off-screen and editor subtrees, keeps 1px dividers, and caps the count', () => {
    Element.prototype.checkVisibility = function (this: Element) {
      return !this.hasAttribute('data-skipped');
    };
    const boxes = new Map([
      ['below', new DOMRect(0, window.innerHeight + 10, 100, 100)],
      ['sr-only', new DOMRect(0, 0, 1, 1)],
      ['divider', new DOMRect(0, 0, 100, 1)],
    ]);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      return boxes.get(this.id) ?? new DOMRect(0, 0, 100, 20);
    });
    document.body.innerHTML = `
      <div id="on"><span id="on-child"></span></div>
      <div id="below"><span></span></div>
      <div id="sr-only"><span id="sr-child"></span></div>
      <div id="divider"></div>
      <div data-skipped><span></span></div>
      <div data-theme-editor-panel><span></span></div>`;
    expect(usageCandidates(document.body)).toEqual([
      document.body,
      byId('on'),
      byId('on-child'),
      byId('sr-child'),
      byId('divider'),
    ]);

    document.body.append(...Array.from({ length: 3100 }, () => document.createElement('i')));
    expect(usageCandidates(document.body)).toHaveLength(3000);
  });
});
