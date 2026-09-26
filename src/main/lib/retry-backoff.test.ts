import { describe, expect, it } from 'vitest';
import { computeExponentialBackoffMs } from './retry-backoff';

describe('computeExponentialBackoffMs', () => {
  it('uses exponential curve with optional offset and no jitter', () => {
    const noJitter = () => 0;
    expect(
      computeExponentialBackoffMs(1, {
        baseMs: 5_000,
        maxMs: 120_000,
        jitterMaxMs: 2_000,
        exponentOffset: -1,
        randomFn: noJitter,
      }),
    ).toBe(5_000);
    expect(
      computeExponentialBackoffMs(2, {
        baseMs: 5_000,
        maxMs: 120_000,
        jitterMaxMs: 2_000,
        exponentOffset: -1,
        randomFn: noJitter,
      }),
    ).toBe(10_000);
  });

  it('caps at max delay before jitter', () => {
    const noJitter = () => 0;
    expect(
      computeExponentialBackoffMs(10, {
        baseMs: 5_000,
        maxMs: 30_000,
        jitterMaxMs: 1_000,
        randomFn: noJitter,
      }),
    ).toBe(30_000);
  });

  it('adds jitter based on provided random function', () => {
    const jitter = computeExponentialBackoffMs(1, {
      baseMs: 5_000,
      maxMs: 30_000,
      jitterMaxMs: 1_000,
      randomFn: () => 0.5,
    });
    expect(jitter).toBe(10_500);
  });
});
