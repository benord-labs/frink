import { describe, expect, it } from 'vitest';
import { createFolderLoadMoreSyncGuard } from './folder-load-more-sync-guard';

describe('createFolderLoadMoreSyncGuard', () => {
  it('blocks a second tryEnter for the same key until exit', () => {
    const g = createFolderLoadMoreSyncGuard();
    expect(g.tryEnter('folder-a')).toBe(true);
    expect(g.tryEnter('folder-a')).toBe(false);
    g.exit('folder-a');
    expect(g.tryEnter('folder-a')).toBe(true);
  });

  it('allows different folder keys concurrently', () => {
    const g = createFolderLoadMoreSyncGuard();
    expect(g.tryEnter('a')).toBe(true);
    expect(g.tryEnter('b')).toBe(true);
    g.exit('a');
    expect(g.tryEnter('a')).toBe(true);
  });

  it('is safe to exit a key that was never entered (no-op)', () => {
    const g = createFolderLoadMoreSyncGuard();
    expect(() => g.exit('missing')).not.toThrow();
    expect(g.tryEnter('missing')).toBe(true);
  });
});
