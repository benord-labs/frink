import { describe, expect, it, vi } from 'vitest';
import {
  withConnectionLifecycleOperation,
  withPluginLifecycleOperation,
} from './connection-lifecycle-operation';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('connection lifecycle operation serialization', () => {
  it('serializes operations for the same connection key', async () => {
    const firstRelease = deferred();
    const secondStarted = vi.fn();
    const first = withConnectionLifecycleOperation('connection-1', async () => {
      await firstRelease.promise;
      return 'first';
    });
    const second = withConnectionLifecycleOperation('connection-1', async () => {
      secondStarted();
      return 'second';
    });

    await Promise.resolve();
    expect(secondStarted).not.toHaveBeenCalled();
    firstRelease.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
  });

  it('releases the key after a failed operation', async () => {
    await expect(
      withConnectionLifecycleOperation('connection-2', async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');

    await expect(
      withConnectionLifecycleOperation('connection-2', async () => 'recovered'),
    ).resolves.toBe('recovered');
  });

  it('serializes package mutations without blocking a different package', async () => {
    const firstRelease = deferred();
    const samePluginStarted = vi.fn();
    const otherPluginStarted = vi.fn();
    const first = withPluginLifecycleOperation('slack', async () => {
      await firstRelease.promise;
      return 'first';
    });
    const samePlugin = withPluginLifecycleOperation('slack', async () => {
      samePluginStarted();
      return 'same';
    });
    const otherPlugin = withPluginLifecycleOperation('clickup', async () => {
      otherPluginStarted();
      return 'other';
    });

    await vi.waitFor(() => expect(otherPluginStarted).toHaveBeenCalledOnce());
    expect(samePluginStarted).not.toHaveBeenCalled();
    firstRelease.resolve();
    await expect(Promise.all([first, samePlugin, otherPlugin])).resolves.toEqual([
      'first',
      'same',
      'other',
    ]);
  });
});
