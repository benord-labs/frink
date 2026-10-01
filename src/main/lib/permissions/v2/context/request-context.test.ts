import { describe, expect, it } from 'vitest';
import { buildPermissionDecisionInput } from './request-context';

describe('buildPermissionDecisionInput', () => {
  it('replaces a search path with the resolved root and keeps the pattern', () => {
    expect(buildPermissionDecisionInput('Grep', { pattern: 'x', path: 'src' }, '/p/src')).toEqual({
      pattern: 'x',
      path: '/p/src',
    });
  });

  it('replaces a file tool path with file_path', () => {
    expect(buildPermissionDecisionInput('Read', { path: 'a.ts' }, '/p/a.ts')).toEqual({
      file_path: '/p/a.ts',
      file: undefined,
      path: undefined,
    });
  });

  it('leaves other tools and missing overrides untouched', () => {
    const input = { command: 'ls' };
    expect(buildPermissionDecisionInput('Bash', input, '/p')).toBe(input);
    expect(buildPermissionDecisionInput('Grep', input)).toBe(input);
  });
});
