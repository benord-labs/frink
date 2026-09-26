import { describe, expect, it } from 'vitest';
import { ROLE_GROUPS, ROLE_LABELS, ROLE_VARS, ROLES } from './roles';

describe('roles', () => {
  it('lists every role in exactly one editor group', () => {
    expect(ROLE_GROUPS.flatMap((group) => group.roles).sort()).toEqual([...ROLES].sort());
  });

  it('writes each CSS var from exactly one role', () => {
    const vars = ROLES.flatMap((role) => ROLE_VARS[role]);
    expect(new Set(vars).size).toBe(vars.length);
  });

  it('gives every role its own label', () => {
    expect(new Set(Object.values(ROLE_LABELS)).size).toBe(ROLES.length);
  });
});
