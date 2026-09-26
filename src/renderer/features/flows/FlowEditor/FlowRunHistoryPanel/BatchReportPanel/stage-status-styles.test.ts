/**
 * Contract tests for inline SVG/React Flow stroke colors (theme tokens, not hardcoded RGB).
 */

import { describe, expect, it } from 'vitest';
import { getEdgeStrokeColor } from './stage-status-styles';

describe('getEdgeStrokeColor', () => {
  it('uses --status-online for completed (theme-aligned success stroke)', () => {
    expect(getEdgeStrokeColor('completed')).toBe('hsl(var(--status-online) / 0.6)');
  });

  it('uses semantic tokens for other known statuses', () => {
    expect(getEdgeStrokeColor('pending')).toBe('hsl(var(--muted-foreground) / 0.3)');
    expect(getEdgeStrokeColor('running')).toBe('hsl(var(--primary) / 0.6)');
    expect(getEdgeStrokeColor('failed')).toBe('hsl(var(--destructive) / 0.6)');
    expect(getEdgeStrokeColor('cancelled')).toBe('hsl(var(--muted-foreground) / 0.2)');
  });

  it('falls back to muted stroke for unknown status strings', () => {
    expect(getEdgeStrokeColor('unknown-status')).toBe('hsl(var(--muted-foreground) / 0.3)');
  });
});
