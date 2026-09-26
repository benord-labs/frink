import { describe, expect, it } from 'vitest';
import { rememberBounded } from '.';

describe('rememberBounded', () => {
  it('evicts the oldest value after the limit is exceeded', () => {
    const values = new Set(['first', 'second']);

    rememberBounded(values, 'third', 2);

    expect([...values]).toEqual(['second', 'third']);
  });

  it('does not refresh or evict when remembering an existing value', () => {
    const values = new Set(['first', 'second']);

    rememberBounded(values, 'first', 2);

    expect([...values]).toEqual(['first', 'second']);
  });
});
