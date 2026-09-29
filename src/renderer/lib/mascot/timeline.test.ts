import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SequenceCancelled, tween, wait } from './timeline';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('timeline', () => {
  it('rejects a wait whose sequence was cancelled meanwhile', async () => {
    const token = { cancelled: false };
    const pending = wait(100, token);
    token.cancelled = true;
    vi.advanceTimersByTime(100);
    await expect(pending).rejects.toBeInstanceOf(SequenceCancelled);
  });

  it('refuses to start a tween on a cancelled sequence', () => {
    expect(() => tween(100, { cancelled: true }, () => {})).toThrow(SequenceCancelled);
  });
});
