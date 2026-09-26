import { describe, expect, it } from 'vitest';
import { wallDurationMs } from './wall-duration-ms';

describe('wallDurationMs', () => {
  it('returns null when either timestamp missing', () => {
    expect(wallDurationMs(null, '2025-01-01T00:00:00.000Z')).toBeNull();
    expect(wallDurationMs('2025-01-01T00:00:00.000Z', null)).toBeNull();
  });

  it('returns delta in ms', () => {
    expect(wallDurationMs('2025-01-01T00:00:00.000Z', '2025-01-01T00:00:01.000Z')).toBe(1000);
  });
});
