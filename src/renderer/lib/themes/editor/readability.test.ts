import { describe, expect, it } from 'vitest';
import { derivePalette } from '../palette/derive';
import { ROLES } from '../palette/roles';
import { isHardToRead } from './readability';

const PALETTE = derivePalette({ background: '#011627', accent: '#82aaff' });

describe('isHardToRead', () => {
  it('passes every colour Frink derives', () => {
    expect(ROLES.filter((role) => isHardToRead(PALETTE, role))).toEqual([]);
  });

  it('flags text below AA on any surface it is read on', () => {
    expect(isHardToRead({ ...PALETTE, mutedText: '#3f5670' }, 'mutedText')).toBe(true);
    expect(isHardToRead({ ...PALETTE, overlay: PALETTE.text }, 'text')).toBe(true);
    expect(isHardToRead({ ...PALETTE, accentForeground: PALETTE.accent }, 'accentForeground')).toBe(
      true,
    );
  });

  it('never flags lines or fills, which carry no text', () => {
    const faint = { ...PALETTE, border: PALETTE.background, surface: PALETTE.background };
    expect(isHardToRead(faint, 'border')).toBe(false);
    expect(isHardToRead(faint, 'surface')).toBe(false);
  });
});
