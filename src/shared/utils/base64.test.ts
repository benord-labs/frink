import { describe, expect, it } from 'vitest';
import { decodedBytes } from './base64';

describe('decodedBytes', () => {
  it.each([
    [3, 'no padding'],
    [4, 'two padding characters'],
    [5, 'one padding character'],
  ])('matches the decoded length for %i bytes (%s)', (size) => {
    const encoded = Buffer.alloc(size, 0xab).toString('base64');
    expect(decodedBytes(encoded)).toBe(Buffer.from(encoded, 'base64').length);
    expect(decodedBytes(encoded)).toBe(size);
  });
});
