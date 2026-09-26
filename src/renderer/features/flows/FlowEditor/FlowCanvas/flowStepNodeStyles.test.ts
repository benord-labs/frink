import { describe, expect, it } from 'vitest';
import { blockIconSurfaceClass } from './flowStepNodeStyles';

const MUTED_FALLBACK = 'bg-muted text-muted-foreground ring-1 ring-inset ring-border';

describe('blockIconSurfaceClass', () => {
  it('returns the muted surface for unregistered / unknown block type strings', () => {
    expect(blockIconSurfaceClass('not_a_real_block_type')).toBe(MUTED_FALLBACK);
    expect(blockIconSurfaceClass('')).toBe(MUTED_FALLBACK);
  });

  it('returns a distinct colored surface for registered block types', () => {
    expect(blockIconSurfaceClass('agent')).toContain('fuchsia');
    expect(blockIconSurfaceClass('manual_trigger')).toContain('violet');
    expect(blockIconSurfaceClass('agent')).not.toBe(MUTED_FALLBACK);
  });
});
