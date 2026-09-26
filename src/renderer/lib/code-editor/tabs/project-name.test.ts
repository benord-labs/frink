import { describe, expect, it } from 'vitest';
import { disambiguateProjectPaths, getProjectName } from './project-name';

describe('getProjectName', () => {
  it('returns undefined for undefined input', () => {
    expect(getProjectName(undefined)).toBeUndefined();
  });

  it('returns the final path segment', () => {
    expect(getProjectName('/Users/benji/work/api')).toBe('api');
    expect(getProjectName('api')).toBe('api');
  });
});

describe('disambiguateProjectPaths', () => {
  it('keeps plain folder names when unique', () => {
    const result = disambiguateProjectPaths(['/work/api', '/work/web']);
    expect(result.get('/work/api')).toBe('api');
    expect(result.get('/work/web')).toBe('web');
  });

  it('prepends the parent dir when folder names collide', () => {
    const result = disambiguateProjectPaths(['/work/api', '/personal/api']);
    expect(result.get('/work/api')).toBe('work/api');
    expect(result.get('/personal/api')).toBe('personal/api');
  });

  it('uses the full path for a colliding root-level segment', () => {
    const result = disambiguateProjectPaths(['/api', '/work/api']);
    // '/api' has a single segment → falls back to the full path
    expect(result.get('/api')).toBe('/api');
    expect(result.get('/work/api')).toBe('work/api');
  });

  it('returns an empty map for no paths', () => {
    expect(disambiguateProjectPaths([]).size).toBe(0);
  });
});
