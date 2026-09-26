import { describe, expect, it } from 'vitest';
import { BUTTON_SHADOW } from './button-shadow';
import {
  getPaneColor,
  getPanePermissionChrome,
  getPanePermissionHighlightRing,
} from './pane-colors';

describe('getPanePermissionChrome', () => {
  it('pane 0 uses theme primary for divider and omits CTA override', () => {
    const c = getPanePermissionChrome(0);
    expect(c.primaryCtaClassName).toBeUndefined();
    expect(c.splitDividerClassName).toContain('divide-primary-foreground');
    expect(c.badgeClassName).toContain('text-primary');
  });

  it('pane 1 (cyan) uses pane-accent for badge and CTA', () => {
    const c = getPanePermissionChrome(1);
    expect(c.badgeClassName).toContain('text-pane-accent');
    expect(c.primaryCtaClassName).toContain('bg-pane-accent');
    expect(c.primaryCtaClassName).toContain('text-pane-accent-foreground');
    expect(c.splitDividerClassName).toContain('divide-pane-accent-foreground');
  });

  it('pane 2 (green) uses status-online tokens', () => {
    const c = getPanePermissionChrome(2);
    expect(c.badgeClassName).toContain('text-status-online');
    expect(c.primaryCtaClassName).toContain('bg-status-online');
    expect(c.splitDividerClassName).toContain('divide-status-online-foreground');
  });

  it('pane 3 uses plan-mode tokens', () => {
    const c = getPanePermissionChrome(3);
    expect(c.badgeClassName).toContain('text-plan-mode');
    expect(c.primaryCtaClassName).toContain('bg-plan-mode');
    expect(c.splitDividerClassName).toContain('divide-plan-mode-foreground');
  });

  it('non-default pane CTAs include BUTTON_SHADOW for parity with default Button', () => {
    for (const i of [1, 2, 3] as const) {
      expect(getPanePermissionChrome(i).primaryCtaClassName).toContain(BUTTON_SHADOW);
    }
  });

  it('wraps pane index modulo 4 so index 4 matches index 0', () => {
    const a = getPanePermissionChrome(0);
    const b = getPanePermissionChrome(4);
    expect(a.badgeClassName).toBe(b.badgeClassName);
    expect(a.primaryCtaClassName).toBe(b.primaryCtaClassName);
    expect(a.splitDividerClassName).toBe(b.splitDividerClassName);
    expect(getPaneColor(0).badgeText).toBe(getPaneColor(4).badgeText);
  });
});

describe('getPanePermissionHighlightRing', () => {
  it('uses distinct ring hue per pane index', () => {
    expect(getPanePermissionHighlightRing(0)).toContain('ring-primary/60');
    expect(getPanePermissionHighlightRing(1)).toContain('ring-pane-accent/60');
    expect(getPanePermissionHighlightRing(2)).toContain('ring-status-online/60');
    expect(getPanePermissionHighlightRing(3)).toContain('ring-plan-mode/60');
  });

  it('wraps at RING.length like getPaneColor', () => {
    expect(getPanePermissionHighlightRing(4)).toContain('ring-primary/60');
    expect(getPanePermissionHighlightRing(5)).toContain('ring-pane-accent/60');
  });
});
