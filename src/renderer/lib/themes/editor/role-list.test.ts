import { describe, expect, it } from 'vitest';
import { changedRoleCount, filterRoleGroups } from './role-list';

describe('filterRoleGroups', () => {
  it('lists every group but the two seeds, which have their own fields', () => {
    const groups = filterRoleGroups('  ', null);
    expect(groups.map((group) => group.label)).toEqual([
      'Backgrounds',
      'Text',
      'Lines and signals',
    ]);
    const roles = groups.flatMap((group) => group.roles);
    expect(roles).toHaveLength(16);
    expect(roles).not.toContain('background');
    expect(roles).not.toContain('accent');
  });

  it('matches a whole group by its label and single roles by theirs', () => {
    expect(filterRoleGroups('TEXT', null)).toEqual([
      { label: 'Text', roles: ['text', 'mutedText', 'subtleForeground', 'highlightForeground'] },
      { label: 'Lines and signals', roles: ['accentForeground', 'destructiveForeground'] },
    ]);
  });

  it('keeps the selected role listed when nothing else matches', () => {
    expect(filterRoleGroups('zzz', null)).toEqual([]);
    expect(filterRoleGroups('zzz', 'border')).toEqual([
      { label: 'Lines and signals', roles: ['border'] },
    ]);
  });
});

describe('changedRoleCount', () => {
  it('counts the colours set by hand, not seeds or ones inherited from the copy', () => {
    const half = {
      background: '#101010',
      accent: '#ff8800',
      syntax: 'github-dark',
      overrides: { text: '#eeeeee', border: '#333333', muted: '#222222' },
    } as const;
    expect(changedRoleCount(half, ['muted'])).toBe(2);
    expect(changedRoleCount({ ...half, overrides: {} }, [])).toBe(0);
  });
});
