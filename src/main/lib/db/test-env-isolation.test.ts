import log from 'electron-log';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/never-reached',
    isPackaged: false,
    getAppPath: () => '/tmp',
  },
}));

/**
 * Locks the hermetic-test invariant (decision: test-environment-isolation): tests must
 * never open the user's real agents.db nor write the real app log. Recorded after a
 * real-data incident where test-env bleed reached production resources.
 */
describe('test environment isolation', () => {
  it('initDatabase refuses to open the real agents.db under vitest', async () => {
    const { getDatabase } = await import('./index');
    expect(() => getDatabase()).toThrow(/freshDb\(\) or vi\.mock/);
  });

  it('global electron-log mock exposes the transports.file surface source code reads', () => {
    // auto-updater/index/debug read getFile().path and assign sync/level — a mock
    // missing this shape would throw TypeError in any test importing them.
    expect(log.transports.file.getFile().path).toBe('');
    expect(() => {
      log.transports.file.sync = true;
      log.transports.file.level = 'info';
    }).not.toThrow();
  });
});
