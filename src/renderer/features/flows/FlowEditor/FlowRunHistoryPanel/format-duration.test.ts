import { describe, expect, it, vi } from 'vitest';
import {
  formatDuration,
  formatDurationLive,
  formatElapsedSinceStart,
  formatElapsedSinceStartLive,
} from './format-duration';

describe('formatDuration', () => {
  it('formats sub-second as ms', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('formats seconds below one minute', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(59_500)).toBe('59.5s');
  });

  it('formats whole minutes', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(120_000)).toBe('2m');
  });

  it('does not show 60.0s for values that round to a full minute', () => {
    expect(formatDuration(59_950)).toBe('1m');
  });
});

describe('formatElapsedSinceStart', () => {
  it('formats elapsed from ISO start to endMs', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:02.000Z'));
    expect(formatElapsedSinceStart('2025-01-01T00:00:00.000Z')).toBe('2.0s');
    vi.useRealTimers();
  });

  it('returns empty string when start is null', () => {
    expect(formatElapsedSinceStart(null)).toBe('');
  });
});

describe('formatDurationLive', () => {
  it('formats sub-second as ms', () => {
    expect(formatDurationLive(0)).toBe('0ms');
    expect(formatDurationLive(500)).toBe('500ms');
  });

  it('formats seconds below one minute without fractional part', () => {
    expect(formatDurationLive(1000)).toBe('1s');
    expect(formatDurationLive(1500)).toBe('1s');
    expect(formatDurationLive(59_999)).toBe('59s');
  });

  it('includes both minutes and seconds', () => {
    expect(formatDurationLive(60_000)).toBe('1m 0s');
    expect(formatDurationLive(90_000)).toBe('1m 30s');
    expect(formatDurationLive(22 * 60_000 + 15_000)).toBe('22m 15s');
  });

  it('includes hours for long durations', () => {
    expect(formatDurationLive(3600_000)).toBe('1h 0m 0s');
    expect(formatDurationLive(3600_000 + 5 * 60_000 + 42_000)).toBe('1h 5m 42s');
  });
});

describe('formatElapsedSinceStartLive', () => {
  it('returns empty string when start is null', () => {
    expect(formatElapsedSinceStartLive(null)).toBe('');
  });

  it('formats elapsed using the live (always-seconds) format', () => {
    const start = new Date('2025-01-01T00:00:00.000Z').getTime();
    const end = start + 22 * 60_000 + 15_000;
    expect(formatElapsedSinceStartLive('2025-01-01T00:00:00.000Z', end)).toBe('22m 15s');
  });
});
