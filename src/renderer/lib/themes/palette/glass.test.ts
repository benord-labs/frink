import { describe, expect, it } from 'vitest';
import { overlayContentBase } from '../../overlay-styles';
import { glassVars, TRANSPARENCY_SCALE } from './glass';

describe('glassVars', () => {
  it('defaults to Standard, the step globals.css paints before a level is chosen', () => {
    expect(glassVars(TRANSPARENCY_SCALE.default, 'light')).toMatchObject({
      '--glass-opacity': '70%',
      '--glass-filter': 'blur(8px) saturate(1.6)',
    });
  });

  it.each([
    [0, '100%', 'none'],
    [25, '85%', 'blur(10px) saturate(1.4)'],
    [50, '70%', 'blur(8px) saturate(1.6)'],
    [75, '55%', 'blur(6px) saturate(1.8)'],
    [100, '40%', 'blur(5px) saturate(1.8)'],
  ] as const)('one material at level %d, the same in light and dark', (level, opacity, filter) => {
    for (const appearance of ['light', 'dark'] as const) {
      expect(glassVars(level, appearance)).toMatchObject({
        '--glass-opacity': opacity,
        '--glass-filter': filter,
      });
    }
  });

  it.each([
    [0, 'light', '0', '0', '0', '0%'],
    [0, 'dark', '0', '0', '0', '0%'],
    [50, 'light', '0.65', '0.24', '0.08', '15%'],
    [100, 'dark', '0.3', '0.08', '0.19', '30%'],
  ] as const)('Frink Glass at level %d %s', (level, appearance, rim, sheen, tint, ink) => {
    expect(glassVars(level, appearance)).toMatchObject({
      '--glass-rim': rim,
      '--glass-sheen': sheen,
      '--glass-tint': tint,
      '--glass-ink': ink,
    });
  });

  it('snaps a stored off-step or out-of-range level to the nearest step', () => {
    expect(glassVars(30, 'light')).toEqual(glassVars(25, 'light'));
    expect(glassVars(400, 'dark')).toEqual(glassVars(100, 'dark'));
  });

  it('overlays apply the glass opacity to the root-resolved popover token', () => {
    // A raw hsl(var(--popover)) resolves on the element, where a nested `.dark` repaints it.
    expect(overlayContentBase).toContain('bg-popover/(--glass-opacity)');
    expect(overlayContentBase).not.toContain('var(--popover)');
  });
});
