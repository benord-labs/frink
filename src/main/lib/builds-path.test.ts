import { describe, expect, it } from 'vitest';
import { isManagedBuildPath } from './builds-path';

const HOME = '/Users/me';

describe('isManagedBuildPath', () => {
  it('matches a folder under ~/.frink/builds', () => {
    expect(isManagedBuildPath('/Users/me/.frink/builds/seo-dash', HOME)).toBe(true);
    expect(isManagedBuildPath('/Users/me/.frink/builds/a/b', HOME)).toBe(true);
  });

  it('does NOT match a user-opened folder elsewhere', () => {
    expect(isManagedBuildPath('/Users/me/code/my-repo', HOME)).toBe(false);
    expect(isManagedBuildPath('/Users/me/.frink/repos/owner/x', HOME)).toBe(false);
  });

  it('does NOT match the builds root itself (no slug)', () => {
    expect(isManagedBuildPath('/Users/me/.frink/builds', HOME)).toBe(false);
  });

  it('does NOT match a sibling that shares the prefix (builds-evil)', () => {
    expect(isManagedBuildPath('/Users/me/.frink/builds-evil/x', HOME)).toBe(false);
    expect(isManagedBuildPath('/Users/me/.frink/buildsX', HOME)).toBe(false);
  });

  it('is scoped to the given home dir', () => {
    expect(isManagedBuildPath('/Users/other/.frink/builds/x', HOME)).toBe(false);
  });
});
