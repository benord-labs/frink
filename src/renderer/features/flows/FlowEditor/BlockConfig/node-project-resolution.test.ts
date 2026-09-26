import { describe, expect, it } from 'vitest';
import { getEffectiveNodeProjectId, getNodeProjectFieldError } from './node-project-resolution';

describe('getEffectiveNodeProjectId', () => {
  it('uses trimmed block projectId when non-empty', () => {
    expect(getEffectiveNodeProjectId('  pid-1  ', undefined)).toBe('pid-1');
    expect(getEffectiveNodeProjectId('pid-2', 'default-id')).toBe('pid-2');
  });

  it('falls back to flow default when block project is blank', () => {
    expect(getEffectiveNodeProjectId('', 'default-uuid')).toBe('default-uuid');
    expect(getEffectiveNodeProjectId('   ', '  spaced-default  ')).toBe('spaced-default');
  });

  it('returns undefined when neither block nor default is usable', () => {
    expect(getEffectiveNodeProjectId('', undefined)).toBeUndefined();
    expect(getEffectiveNodeProjectId('   ', '')).toBeUndefined();
  });
});

describe('getNodeProjectFieldError', () => {
  it('is null when effective project id is non-empty', () => {
    expect(getNodeProjectFieldError('any-id')).toBeNull();
    expect(getNodeProjectFieldError('  x  ')).toBeNull();
  });

  it('returns select message when missing or whitespace-only', () => {
    expect(getNodeProjectFieldError(undefined)).toBe('Select a project.');
    expect(getNodeProjectFieldError('')).toBe('Select a project.');
    expect(getNodeProjectFieldError('   ')).toBe('Select a project.');
  });
});
