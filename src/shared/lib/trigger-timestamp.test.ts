import { describe, expect, it } from 'vitest';
import { formatTriggerTimestamp, UNKNOWN_TRIGGER_TIMESTAMP } from './trigger-timestamp';

describe('formatTriggerTimestamp', () => {
  it('returns Unknown for undefined, empty, and whitespace', () => {
    expect(formatTriggerTimestamp(undefined)).toBe('Unknown');
    expect(formatTriggerTimestamp('')).toBe('Unknown');
    expect(formatTriggerTimestamp('   ')).toBe('Unknown');
  });

  it('returns Unknown for unknown sentinel with varied casing', () => {
    expect(formatTriggerTimestamp(UNKNOWN_TRIGGER_TIMESTAMP)).toBe('Unknown');
    expect(formatTriggerTimestamp('UNKNOWN')).toBe('Unknown');
    expect(formatTriggerTimestamp('  UnKnOwN  ')).toBe('Unknown');
  });

  it('returns Unknown for invalid date strings', () => {
    expect(formatTriggerTimestamp('not-a-date')).toBe('Unknown');
    expect(formatTriggerTimestamp('2026-99-99T99:99:99.999Z')).toBe('Unknown');
  });

  it('formats valid timestamps as deterministic UTC strings', () => {
    expect(formatTriggerTimestamp('2026-03-02T12:34:56.000Z')).toBe('2026-03-02 12:34:56.000 UTC');
    expect(formatTriggerTimestamp('2026-03-02T12:34:56.789Z')).toBe('2026-03-02 12:34:56.789 UTC');
  });

  it('parses valid ISO after trimming surrounding whitespace', () => {
    expect(formatTriggerTimestamp('  2026-03-02T12:34:56.000Z  ')).toBe(
      '2026-03-02 12:34:56.000 UTC',
    );
  });

  it('formats UTC deterministically across year and ms boundaries', () => {
    expect(formatTriggerTimestamp('1999-12-31T23:59:59.999Z')).toBe('1999-12-31 23:59:59.999 UTC');
    expect(formatTriggerTimestamp('2000-01-01T00:00:00.000Z')).toBe('2000-01-01 00:00:00.000 UTC');
  });
});
