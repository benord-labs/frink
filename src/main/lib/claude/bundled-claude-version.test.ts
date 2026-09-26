import { describe, expect, it, vi } from 'vitest';
import { clampEffortForBundledBinary, claudeVersionSupportsXhigh } from './bundled-claude-version';

// The module imports `app` from electron at load; getBundledClaudeVersion is never exercised here
// (every test passes an explicit version), so a stub is enough to resolve the import.
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/tmp' } }));

describe('claudeVersionSupportsXhigh', () => {
  it('is false below 2.1.173 (the version where --effort xhigh landed)', () => {
    for (const v of ['2.1.97', '2.1.111', '2.1.172', '2.0.999', '1.9.9']) {
      expect(claudeVersionSupportsXhigh(v), v).toBe(false);
    }
  });

  it('is true at or above 2.1.173', () => {
    for (const v of ['2.1.173', '2.1.197', '2.1.999', '2.2.0', '3.0.0']) {
      expect(claudeVersionSupportsXhigh(v), v).toBe(true);
    }
  });

  it('fails closed for anything that is not a leading X.Y.Z semver (clamp rather than risk a crash)', () => {
    // Missing/partial/garbage, plus a stray timestamp whose leading digits (2026) would otherwise
    // parse as a huge version and defeat the guard.
    for (const v of [null, '', 'unknown', '2.1', 'a.b.c', '2026-07-01T12:00:00Z']) {
      expect(claudeVersionSupportsXhigh(v), String(v)).toBe(false);
    }
  });
});

describe('clampEffortForBundledBinary', () => {
  it('downgrades xhigh → high below 2.1.173 or when the version is unknown (fail closed)', () => {
    expect(clampEffortForBundledBinary('xhigh', '2.1.97')).toBe('high');
    expect(clampEffortForBundledBinary('xhigh', null)).toBe('high');
    expect(clampEffortForBundledBinary('xhigh', '2.1.173')).toBe('xhigh');
    expect(clampEffortForBundledBinary('xhigh', '2.1.200')).toBe('xhigh');
  });

  it('never touches other effort levels (max is valid on every bundled version)', () => {
    for (const e of ['low', 'medium', 'high', 'max', undefined]) {
      expect(clampEffortForBundledBinary(e, '2.1.97'), String(e)).toBe(e);
    }
  });
});
