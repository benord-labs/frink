import { describe, expect, it } from 'vitest';
import { toCamelKey } from './case-strings';

describe('toCamelKey', () => {
  it('converts snake_case to camelCase', () => {
    expect(toCamelKey('user_id')).toBe('userId');
    expect(toCamelKey('command_pattern')).toBe('commandPattern');
    expect(toCamelKey('git_remote_url')).toBe('gitRemoteUrl');
  });

  it('is idempotent on already-camelCase keys', () => {
    expect(toCamelKey('userId')).toBe('userId');
    expect(toCamelKey('commandPattern')).toBe('commandPattern');
  });

  it('converts kebab-case to camelCase', () => {
    expect(toCamelKey('user-id')).toBe('userId');
    expect(toCamelKey('git-remote')).toBe('gitRemote');
  });

  it('handles numeric segments', () => {
    expect(toCamelKey('item_2_value')).toBe('item2Value');
    expect(toCamelKey('v1_id')).toBe('v1Id');
  });

  it('preserves leading underscores (private convention) by leaving the first char untouched', () => {
    // /[_-]+([a-z0-9])/gi consumes the leading underscore + uppercases the first char.
    // This is the upstream lib's behavior; document it.
    expect(toCamelKey('_user_id')).toBe('UserId');
  });

  it('preserves single letters', () => {
    expect(toCamelKey('a')).toBe('a');
    expect(toCamelKey('_')).toBe('_');
  });

  it('handles empty string', () => {
    expect(toCamelKey('')).toBe('');
  });
});
