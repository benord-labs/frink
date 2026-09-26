import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDayLabel, formatRelativeTime, formatShortTimeAgo } from './format-time';

describe('formatShortTimeAgo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('compresses date-fns distance strings (minutes → m)', () => {
    vi.setSystemTime(new Date('2026-03-22T12:00:00.000Z'));
    expect(formatShortTimeAgo(new Date('2026-03-22T11:50:00.000Z'))).toBe('10m');
    expect(formatShortTimeAgo(new Date('2026-03-22T11:59:45.000Z'))).toBe('<1m');
  });

  it('keeps month and year distances compact', () => {
    vi.setSystemTime(new Date('2026-08-11T12:00:00.000Z'));

    expect(formatShortTimeAgo(new Date('2026-01-11T12:00:00.000Z'))).toBe('7mo');
    expect(formatShortTimeAgo(new Date('2025-08-11T12:00:00.000Z'))).toBe('1y');
  });
});

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the input string for invalid ISO (NaN time)', () => {
    expect(formatRelativeTime('not-a-date')).toBe('not-a-date');
    expect(formatRelativeTime('')).toBe('');
  });

  it('returns "Just now" for past timestamps under 60 seconds', () => {
    vi.setSystemTime(new Date('2026-03-22T12:00:00.000Z'));
    expect(formatRelativeTime('2026-03-22T11:59:30.000Z')).toBe('Just now');
  });

  it('returns "Xm ago" for past minutes under 1 hour', () => {
    vi.setSystemTime(new Date('2026-03-22T12:00:00.000Z'));
    expect(formatRelativeTime('2026-03-22T11:55:00.000Z')).toBe('5m ago');
  });

  it('returns "Xh ago" for past hours under 24 hours', () => {
    vi.setSystemTime(new Date('2026-03-22T12:00:00.000Z'));
    expect(formatRelativeTime('2026-03-22T06:00:00.000Z')).toBe('6h ago');
  });

  it('returns "Xd ago" for past days under 7 days', () => {
    vi.setSystemTime(new Date('2026-03-22T12:00:00.000Z'));
    expect(formatRelativeTime('2026-03-20T12:00:00.000Z')).toBe('2d ago');
  });

  it('returns "in <1m" for future under 60 seconds', () => {
    vi.setSystemTime(new Date('2026-03-22T12:00:00.000Z'));
    expect(formatRelativeTime('2026-03-22T12:00:45.000Z')).toBe('in <1m');
  });

  it('returns "in Xm" for future minutes under 1 hour', () => {
    vi.setSystemTime(new Date('2026-03-22T12:00:00.000Z'));
    expect(formatRelativeTime('2026-03-22T12:10:00.000Z')).toBe('in 10m');
  });

  it('returns "in Xh" for future hours under 24 hours', () => {
    vi.setSystemTime(new Date('2026-03-22T12:00:00.000Z'));
    expect(formatRelativeTime('2026-03-22T18:00:00.000Z')).toBe('in 6h');
  });

  it('returns "in Xd" for future days under 7 days', () => {
    vi.setSystemTime(new Date('2026-03-22T12:00:00.000Z'));
    expect(formatRelativeTime('2026-03-25T12:00:00.000Z')).toBe('in 3d');
  });

  it('uses calendar-style output for past >= 7 days (not relative buckets)', () => {
    vi.setSystemTime(new Date('2026-03-22T15:00:00.000Z'));
    const out = formatRelativeTime('2026-03-01T15:00:00.000Z');
    expect(out).not.toMatch(/\d+[mhd] ago$/);
    expect(out).not.toMatch(/^Just now$/);
    expect(out).not.toMatch(/^in /);
    expect(out.length).toBeGreaterThan(4);
  });

  it('uses calendar-style output for future >= 7 days (not relative buckets)', () => {
    vi.setSystemTime(new Date('2026-03-22T15:00:00.000Z'));
    const out = formatRelativeTime('2026-05-01T15:00:00.000Z');
    expect(out).not.toMatch(/^in \d+[mhd]$/);
    expect(out).not.toMatch(/ago$/);
    expect(out.length).toBeGreaterThan(4);
  });
});

describe('formatDayLabel', () => {
  it('reads a local calendar day without shifting it across a timezone', () => {
    expect(formatDayLabel('2026-08-29')).toBe(
      new Date(2026, 7, 29).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
    );
  });
});
