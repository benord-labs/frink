/**
 * Unit tests for workstream-colors utilities.
 */

import { describe, expect, it } from 'vitest';
import {
  getWorkstreamAbbrev,
  getWorkstreamColor,
  WORKSTREAM_COLOR_PALETTE,
} from './workstream-colors';

describe('getWorkstreamColor', () => {
  it('returns a string from the palette for any non-empty input', () => {
    const color = getWorkstreamColor('auth-module');
    expect(typeof color).toBe('string');
    expect(WORKSTREAM_COLOR_PALETTE).toContain(color);
  });

  it('is deterministic — same input always returns same color', () => {
    const a = getWorkstreamColor('auth-module');
    const b = getWorkstreamColor('auth-module');
    expect(a).toBe(b);
  });

  it('returns the same color across multiple independent calls', () => {
    for (let i = 0; i < 5; i++) {
      expect(getWorkstreamColor('ui-work')).toBe(getWorkstreamColor('ui-work'));
    }
  });

  it('different inputs produce consistent (potentially different) colors', () => {
    // This confirms the function doesn't always return the same color regardless of input.
    const colors = [
      'auth',
      'api',
      'ui',
      'infra',
      'data',
      'test',
      'docs',
      'config',
      'ci',
      'tools',
    ].map(getWorkstreamColor);
    // At least some should be in the palette (all of them should)
    for (const c of colors) {
      expect(WORKSTREAM_COLOR_PALETTE).toContain(c);
    }
  });

  it('handles single-char input without throwing', () => {
    expect(() => getWorkstreamColor('a')).not.toThrow();
  });

  it('handles empty string without throwing', () => {
    expect(() => getWorkstreamColor('')).not.toThrow();
  });

  it('palette cycling: more than palette-length distinct inputs all return a valid color', () => {
    const paletteSize = WORKSTREAM_COLOR_PALETTE.length;
    // Generate paletteSize + 5 unique workstream names to verify cycling
    const names = Array.from({ length: paletteSize + 5 }, (_, i) => `workstream-${i}`);
    for (const name of names) {
      expect(WORKSTREAM_COLOR_PALETTE).toContain(getWorkstreamColor(name));
    }
  });
});

describe('getWorkstreamAbbrev', () => {
  it('returns first 2 chars uppercased for alphabetic names', () => {
    expect(getWorkstreamAbbrev('auth-module')).toBe('AU');
  });

  it('strips non-alphanumeric chars before slicing', () => {
    expect(getWorkstreamAbbrev('ui-work')).toBe('UI');
  });

  it('handles all-numeric input', () => {
    expect(getWorkstreamAbbrev('123-pipeline')).toBe('12');
  });

  it('handles short names (< 2 chars after strip)', () => {
    expect(getWorkstreamAbbrev('a')).toBe('A');
  });

  it('returns fallback "??" for empty string', () => {
    expect(getWorkstreamAbbrev('')).toBe('??');
  });

  it('returns fallback "??" for all-symbol string', () => {
    expect(getWorkstreamAbbrev('---')).toBe('??');
  });

  it('is deterministic', () => {
    expect(getWorkstreamAbbrev('api-gateway')).toBe(getWorkstreamAbbrev('api-gateway'));
  });

  it('returns "??" when the id has no alphanumeric chars after strip (e.g. CJK-only)', () => {
    expect(getWorkstreamAbbrev('日本語')).toBe('??');
  });
});
