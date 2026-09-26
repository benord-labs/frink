import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    files: {
      resolveDefinition: { query: vi.fn() },
    },
  },
}));

describe('clearAliasCache (deprecated)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns at most once per module load when invoked multiple times', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { clearAliasCache } = await import('./alias-definition-provider');
    clearAliasCache();
    clearAliasCache();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('clearAliasCache');
    expect(warnSpy.mock.calls[0]?.[0]).toContain('model.getValue');
  });
});
