// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/postcss';
import { Window } from 'happy-dom';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const ENTRY = resolve(__dirname, 'globals.css');

/** The renderer stylesheet as the production build emits it (Lightning CSS optimisation on). */
async function buildCss(): Promise<string> {
  const plugin = tailwindcss({ base: resolve(__dirname, '..'), optimize: true });
  const { css } = await postcss([plugin]).process(readFileSync(ENTRY, 'utf8'), { from: ENTRY });
  return css;
}

function declares(rule: Rule, prop: string): boolean {
  return rule.some((node) => node.type === 'decl' && node.prop === prop);
}

function valueOf(rule: Rule | undefined, prop: string): string | undefined {
  let value: string | undefined;
  rule?.walkDecls(prop, (decl) => {
    value = decl.value;
  });
  return value;
}

/** Top-left, top-right and bottom-left radius of `#id` in ChatDock's stack, with the stacked-cards
 *  column flagged or not. */
async function dockRadii(css: string, hasCards: boolean, id: string): Promise<string[]> {
  const window = new Window();
  const sheet = window.document.createElement('style');
  sheet.textContent = `.composer-slot-surface { border-radius: 16px }\n${css}`;
  window.document.head.append(sheet);
  window.document.body.innerHTML = `<div data-chat-dock>
    <div${hasCards ? ' data-stacked-cards' : ''}><div></div></div>
    <div><div><div id="slot" class="composer-slot-surface"></div></div></div>
    <div><div id="below" class="composer-slot-surface"></div></div>
  </div>`;
  const surface = window.document.getElementById(id);
  if (!surface) throw new Error(`no #${id}`);
  const style = window.getComputedStyle(surface);
  const radii = [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomLeftRadius,
  ];
  await window.happyDOM.close();
  return radii;
}

/** Index just past the parenthesised group that opens at `open`. */
function skipGroup(selector: string, open: number): number {
  let depth = 0;
  for (let i = open; i < selector.length; i++) {
    if (selector[i] === '(') depth++;
    else if (selector[i] === ')' && --depth === 0) return i + 1;
  }
  return selector.length;
}

/** What follows `from` in its own selector: up to the enclosing `)` or `,`, nested groups dropped. */
function restOfSelector(selector: string, from: number): string {
  let rest = '';
  for (let i = from; i < selector.length && !/[),]/.test(selector[i]); i++) {
    if (selector[i] === '(') i = skipGroup(selector, i) - 1;
    else rest += selector[i];
  }
  return rest.trimEnd();
}

/** Whether a `:has(...)` is followed by a combinator, i.e. styles something other than itself. */
function hasNonSubjectHas(selector: string): boolean {
  return [...selector.matchAll(/:has\(/g)].some((match) =>
    /[\s>+~]/.test(restOfSelector(selector, skipGroup(selector, match.index + ':has'.length))),
  );
}

describe('production CSS', () => {
  const built = buildCss();

  // Lightning CSS folds `backdrop-filter` followed by a hand-written `-webkit-backdrop-filter`
  // into the prefixed form alone, which Chromium ignores: the blur silently disappears.
  it('never ships a backdrop filter only Safari reads', async () => {
    const prefixedOnly: string[] = [];
    postcss.parse(await built).walkRules((rule) => {
      if (declares(rule, '-webkit-backdrop-filter') && !declares(rule, 'backdrop-filter'))
        prefixedOnly.push(rule.selector);
    });
    expect(prefixedOnly).toEqual([]);
  });

  it('keeps toasts on the glass material, with a focus ring, over the sheet Sonner injects after it', async () => {
    const ours: string[] = [];
    postcss.parse(await built).walkRules((rule) => {
      if (rule.selector.includes('data-sonner-toast')) ours.push(rule.toString());
    });
    const sonner = readFileSync(createRequire(__filename).resolve('sonner/dist/styles.css'));
    const window = new Window();
    for (const css of [ours.join('\n'), sonner.toString()]) {
      const sheet = window.document.createElement('style');
      sheet.textContent = css;
      window.document.head.append(sheet);
    }
    const toaster = window.document.createElement('section');
    toaster.dataset.sonnerToaster = '';
    toaster.style.cssText = '--popover: 1 2% 3%; --glass-opacity: 80%';
    for (const theme of ['light', 'dark']) {
      toaster.dataset.sonnerTheme = theme;
      window.document.body.append(toaster);
      expect(window.getComputedStyle(toaster).getPropertyValue('--normal-bg')).toBe(
        'hsl(1 2% 3% / 80%)',
      );
    }
    const toast = window.document.createElement('li');
    Object.assign(toast.dataset, { sonnerToast: '', styled: 'true' });
    toast.tabIndex = 0;
    toast.style.cssText = '--glass-rim-shadow: inset 1px 1px red; --color-ring: blue';
    toaster.append(toast);
    toast.focus();
    const shadow = window.getComputedStyle(toast).boxShadow;
    expect(shadow).toContain('inset 1px 1px red');
    expect(shadow).toMatch(/0 0 0 2px blue$/);
    await window.happyDOM.close();
  });

  it('puts panels, cards and chat floats on the one lit glass material', async () => {
    const rules = new Map<string, Rule>();
    postcss.parse(await built).walkRules((rule) => {
      if (!rules.has(rule.selector)) rules.set(rule.selector, rule);
    });
    const panel = rules.get(
      '[data-agents-page] .unified-sidebar-glass,[data-agents-page].unified-sidebar-glass',
    );
    for (const rule of [rules.get('.glass-card'), rules.get('.glass-float'), panel]) {
      expect(valueOf(rule, 'background-color')).toBe('hsl(var(--card) / var(--glass-opacity))');
      expect(valueOf(rule, '--tw-inset-shadow')).toBe('var(--glass-rim-shadow)');
    }
    // Blur only where content moves behind. A filter on a panel or card would also trap its
    // fixed-position children, such as the file tree's drag preview.
    expect(valueOf(rules.get('.glass-float'), 'backdrop-filter')).toBe('var(--glass-filter)');
    expect(valueOf(rules.get('.glass-card'), 'backdrop-filter')).toBeUndefined();
    expect(valueOf(panel, 'backdrop-filter')).toBeUndefined();
    // A panel's own shadow goes in --tw-shadow; a box-shadow of its own would drop the rim.
    const lit = valueOf(rules.get('.glass-lit'), 'box-shadow');
    for (const [selector, rule] of rules) {
      const shadow = valueOf(rule, 'box-shadow');
      if (selector.includes('unified-sidebar-glass') && shadow) expect(shadow, selector).toBe(lit);
    }
  });

  it('puts sticky transcript lists on the glass only while they are stuck', async () => {
    const stuck: Rule[] = [];
    postcss.parse(await built).walkAtRules('container', (query) => {
      if (/^scroll-state\(stuck:\s?top\)$/.test(query.params))
        query.walkRules('.stuck\\:glass-float', (rule) => {
          stuck.push(rule);
        });
    });
    expect(stuck).toHaveLength(1);
    expect(valueOf(stuck[0], 'background-color')).toBe('hsl(var(--card) / var(--glass-opacity))');
    expect(valueOf(stuck[0], 'backdrop-filter')).toBe('var(--glass-filter)');
  });

  it('squares the top of the slot surface a stacked card sits on, and only that one', async () => {
    const rules: Rule[] = [];
    postcss.parse(await built).walkRules((rule) => {
      if (rule.selector.includes('.composer-slot-surface')) rules.push(rule);
    });
    expect(rules).not.toEqual([]);
    // The utilities layer, so it beats the account cards' `rounded-2xl` and the composer's radius.
    for (const rule of rules) expect(rule.parent?.toString()).toMatch(/^@layer utilities/);
    const css = rules.join('\n');
    expect(await dockRadii(css, true, 'slot')).toEqual(['0px', '0px', '16px']);
    // No card showing (a status card whose files are all committed renders none): fully rounded.
    expect(await dockRadii(css, false, 'slot')).toEqual(['16px', '16px', '16px']);
    // Only the surface directly under the cards, not a later one in the stack.
    expect(await dockRadii(css, true, 'below')).toEqual(['16px', '16px', '16px']);
  });

  // Chromium re-checks a `:has()` followed by a combinator (Tailwind's `group-has-*`, `.a:has(b) .c`)
  // across the whole subtree on every DOM change: a ~70ms full-document restyle per insert with a
  // few split panes open. Style from an attribute the owning component sets instead.
  it('keeps every :has() on the element it styles', async () => {
    const offenders = new Set<string>();
    postcss.parse(await built).walkRules((rule) => {
      // Sonner's toast rules only re-check inside a toast, which holds a handful of elements.
      if (rule.selector.startsWith('[data-sonner-toast]')) return;
      if (hasNonSubjectHas(rule.selector)) offenders.add(rule.selector);
    });
    expect([...offenders]).toEqual([]);
  });

  // The OS override forces the Solid glass vars, so a surface must look as it does at Solid.
  it('keeps surface shadows when the OS forces Solid', async () => {
    const resets: string[] = [];
    postcss.parse(await built).walkAtRules('media', (media) => {
      if (media.params.includes('prefers-reduced-transparency'))
        media.walkDecls('box-shadow', (decl) => {
          resets.push(decl.toString());
        });
    });
    expect(resets).toEqual([]);
  });

  // glass-lit restates Tailwind's box-shadow stack by name; if an upgrade renames it, the rim or
  // the surface's own shadow-* silently disappears.
  it('keeps the glass-lit rim on the shadow-* box-shadow stack', async () => {
    const shadow: Record<string, string> = {};
    const inks: string[] = [];
    postcss.parse(await built).walkRules((rule) => {
      if (rule.selector !== '.glass-lit' && rule.selector !== '.shadow-lg') return;
      rule.walkDecls((decl) => {
        if (decl.prop === 'box-shadow') shadow[rule.selector] = decl.value;
        if (decl.value === 'var(--glass-muted-ink)') inks.push(decl.prop);
      });
    });
    // The primitives compile text-muted-fg to var(--muted-fg), so both muted inks must lift.
    expect(inks.sort()).toEqual(['--color-muted-foreground', '--muted-fg']);
    expect(shadow['.glass-lit']).toContain('var(--tw-inset-shadow)');
    expect(shadow['.glass-lit']).toBe(shadow['.shadow-lg']);
    // The rim's glint reads the root token from plain CSS, so it must still be emitted.
    expect(await built).toMatch(/--color-primary:/);
  });
});
