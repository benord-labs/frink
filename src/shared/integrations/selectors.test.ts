import { describe, expect, it } from 'vitest';
import { PROVIDERS } from './providers';

/** Provider readiness drives the directory's availability groups and connection controls. */
describe('integration provider surfacing', () => {
  it('separates a shipped provider from one Frink cannot verify yet', () => {
    const statusById = new Map(PROVIDERS.map((p) => [p.id, p.status]));
    expect(statusById.get('clickup')).toBe('available');
    expect(statusById.get('atlassian')).toBe('coming_soon');
    expect(statusById.get('webflow')).toBe('coming_soon');
  });
});
