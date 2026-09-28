import { describe, expect, it } from 'vitest';
import { buildPermissionDecisionInput, readSearchRoot, SEARCH_ROOT } from './request-context';

describe('buildPermissionDecisionInput — search tools', () => {
  it('attaches the override as the search root and leaves the agent args untouched', () => {
    const input = buildPermissionDecisionInput(
      'Grep',
      { pattern: 'x', path: '/wt/src' },
      '/proj/src',
    );
    expect(readSearchRoot(input)).toBe('/proj/src');
    expect(Object.keys(input)).toEqual(['pattern', 'path']);
    expect(input.path).toBe('/wt/src');
  });

  it('attaches no search root without an override', () => {
    expect(readSearchRoot(buildPermissionDecisionInput('Glob', { pattern: '*' }))).toBeUndefined();
  });

  it('never attaches a search root to PATH tools (they get the file_path rewrite)', () => {
    const input = buildPermissionDecisionInput('Read', { file_path: '/wt/a.ts' }, '/proj/a.ts');
    expect(readSearchRoot(input)).toBeUndefined();
    expect(input.file_path).toBe('/proj/a.ts');
  });

  it('a model-authored JSON input cannot carry the search root', () => {
    const parsed = JSON.parse(
      '{"pattern":"x","search_root":"/proj","frink.permissions.searchRoot":"/proj"}',
    );
    expect(readSearchRoot(parsed)).toBeUndefined();
  });

  it('the search root is dropped by JSON serialization (rule matching, prompt payloads)', () => {
    const input = buildPermissionDecisionInput('Grep', { pattern: 'x' }, '/proj');
    expect(JSON.parse(JSON.stringify(input))).toEqual({ pattern: 'x' });
    expect(Object.getOwnPropertySymbols(input)).toEqual([SEARCH_ROOT]);
  });

  it('ignores a non-string value under the key', () => {
    expect(readSearchRoot({ [SEARCH_ROOT]: 42 })).toBeUndefined();
    expect(readSearchRoot(null)).toBeUndefined();
  });
});
