import { describe, expect, it } from 'vitest';
import { validateProjectAgainstList } from './validate-project-against-list';

const project = { id: 'p-1' };

describe('validateProjectAgainstList', () => {
  it('returns null when project is null', () => {
    expect(validateProjectAgainstList(null, [{ id: 'p-1' }], false)).toBe(null);
  });

  it('passes the project through while the list is loading', () => {
    expect(validateProjectAgainstList(project, undefined, true)).toBe(project);
  });

  it('returns null when the list is undefined', () => {
    expect(validateProjectAgainstList(project, undefined, false)).toBe(null);
  });

  it('returns null when the project id is not in the list', () => {
    expect(validateProjectAgainstList(project, [{ id: 'other' }], false)).toBe(null);
  });

  it('returns the project when its id is in the list', () => {
    expect(validateProjectAgainstList(project, [{ id: 'p-1' }], false)).toBe(project);
  });

  it('returns null for an empty list', () => {
    expect(validateProjectAgainstList(project, [], false)).toBe(null);
  });

  // Regression: during tRPC client hydration, data can briefly be a non-array
  // non-undefined value (see commit a6d57596). The previous `!projects` guard
  // let these through and crashed on `.some`. Array.isArray must reject them.
  it('returns null when projects is a non-array object (hydration flash)', () => {
    const nonArray = { json: [{ id: 'p-1' }], meta: {} } as unknown as { id: string }[];
    expect(() => validateProjectAgainstList(project, nonArray, false)).not.toThrow();
    expect(validateProjectAgainstList(project, nonArray, false)).toBe(null);
  });

  it('returns null when projects is a primitive value (hydration flash)', () => {
    const nonArray = 'loading' as unknown as { id: string }[];
    expect(() => validateProjectAgainstList(project, nonArray, false)).not.toThrow();
    expect(validateProjectAgainstList(project, nonArray, false)).toBe(null);
  });
});
