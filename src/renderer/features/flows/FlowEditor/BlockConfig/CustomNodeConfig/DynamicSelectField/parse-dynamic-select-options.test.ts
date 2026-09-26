// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { parseDynamicSelectOptionsFromStdout } from './parse-dynamic-select-options';

describe('parseDynamicSelectOptionsFromStdout', () => {
  it('returns empty array when stdout is undefined', () => {
    expect(parseDynamicSelectOptionsFromStdout(undefined)).toEqual([]);
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseDynamicSelectOptionsFromStdout('not json')).toEqual([]);
  });

  it('returns empty array for non-array JSON', () => {
    expect(parseDynamicSelectOptionsFromStdout('{"name":"x","value":"y"}')).toEqual([]);
  });

  it('returns empty array when an item is missing name or value', () => {
    expect(
      parseDynamicSelectOptionsFromStdout(
        JSON.stringify([{ name: 'A', value: 'a' }, { name: 'B' }]),
      ),
    ).toEqual([]);
    expect(
      parseDynamicSelectOptionsFromStdout(
        JSON.stringify([{ name: 'A', value: 'a' }, { value: 'b' }]),
      ),
    ).toEqual([]);
  });

  it('parses valid option list', () => {
    const raw = JSON.stringify([
      { name: 'One', value: '1' },
      { name: 'Two', value: '2' },
    ]);
    expect(parseDynamicSelectOptionsFromStdout(raw)).toEqual([
      { name: 'One', value: '1' },
      { name: 'Two', value: '2' },
    ]);
  });

  it('dedupes by value keeping the first row (duplicate value, different name)', () => {
    const raw = JSON.stringify([
      { name: 'First label', value: 'same' },
      { name: 'Second label', value: 'same' },
      { name: 'Other', value: 'other' },
    ]);
    expect(parseDynamicSelectOptionsFromStdout(raw)).toEqual([
      { name: 'First label', value: 'same' },
      { name: 'Other', value: 'other' },
    ]);
  });

  it('returns empty array for empty JSON array', () => {
    expect(parseDynamicSelectOptionsFromStdout('[]')).toEqual([]);
  });
});
