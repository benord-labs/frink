import { describe, expect, it } from 'vitest';
import { extractEmailDisplayName } from './email-display-name';

describe('extractEmailDisplayName', () => {
  it('extracts name from "Name <email>" format', () => {
    expect(extractEmailDisplayName('Alex Example <alex@example.com>')).toBe('Alex Example');
  });

  it('returns bare email when no display name exists', () => {
    expect(extractEmailDisplayName('alex@example.com')).toBe('alex@example.com');
  });

  it('returns undefined for empty and undefined values', () => {
    expect(extractEmailDisplayName('')).toBeUndefined();
    expect(extractEmailDisplayName(undefined)).toBeUndefined();
  });

  it('trims whitespace around extracted names', () => {
    expect(extractEmailDisplayName('  Alex Example   <alex@example.com>')).toBe('Alex Example');
  });
});
