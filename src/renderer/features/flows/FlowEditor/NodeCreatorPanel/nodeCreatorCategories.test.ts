import { describe, expect, it } from 'vitest';
import { NODE_CREATOR_CATEGORIES } from './nodeCreatorCategories';

describe('NODE_CREATOR_CATEGORIES', () => {
  const allTypes = NODE_CREATOR_CATEGORIES.flatMap((c) => c.types);

  it('never offers the retired sc-844 provider POC block — provider actions ship as plugin operations', () => {
    expect(allTypes).not.toContain('shortcut.create_story');
  });

  it('surfaces built-in action nodes', () => {
    expect(allTypes).toContain('http_request');
    expect(allTypes).toContain('run_command');
  });
});
