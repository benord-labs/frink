import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireCustomNodeReadLease,
  beginCustomNodeInstall,
  isAnyCustomNodeInstallInFlight,
  waitForCustomNodeInstall,
  waitForCustomNodeReaders,
} from './installation-coordinator';

afterEach(() => {
  vi.useRealTimers();
});

describe('custom-node installation coordination', () => {
  it('serializes filesystem swaps across node names', async () => {
    const releaseA = beginCustomNodeInstall('node-a');
    const releaseB = beginCustomNodeInstall('node-b');
    expect(releaseA).not.toBeNull();
    expect(releaseB).toBeNull();
    expect(beginCustomNodeInstall('node-a')).toBeNull();
    expect(isAnyCustomNodeInstallInFlight()).toBe(true);

    let ready = false;
    const waiting = waitForCustomNodeInstall('node-a').then((result) => {
      ready = result;
    });
    await Promise.resolve();
    expect(ready).toBe(false);

    releaseA?.();
    await waiting;
    expect(ready).toBe(true);

    const releaseBAfterA = beginCustomNodeInstall('node-b');
    expect(releaseBAfterA).not.toBeNull();
    releaseBAfterA?.();
    expect(isAnyCustomNodeInstallInFlight()).toBe(false);
  });

  it('keeps waiting when a second install starts before the waiter resumes', async () => {
    const releaseFirst = beginCustomNodeInstall('node-a');
    const waiting = waitForCustomNodeInstall('node-a');

    releaseFirst?.();
    const releaseSecond = beginCustomNodeInstall('node-a');
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSecond?.();
    await expect(waiting).resolves.toBe(true);
  });

  it('holds a writer at the swap boundary until existing readers finish', async () => {
    const releaseReader = await acquireCustomNodeReadLease('node-a');
    expect(releaseReader).not.toBeNull();
    const releaseInstall = beginCustomNodeInstall('node-a');
    expect(releaseInstall).not.toBeNull();

    let readersDrained = false;
    const draining = waitForCustomNodeReaders('node-a', 1_000).then((drained) => {
      readersDrained = drained;
    });
    let lateReaderAcquired = false;
    const lateReader = acquireCustomNodeReadLease('node-a').then((release) => {
      lateReaderAcquired = true;
      return release;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(readersDrained).toBe(false);
    expect(lateReaderAcquired).toBe(false);

    releaseReader?.();
    await draining;
    expect(readersDrained).toBe(true);
    expect(lateReaderAcquired).toBe(false);

    releaseInstall?.();
    const releaseLateReader = await lateReader;
    expect(releaseLateReader).not.toBeNull();
    releaseLateReader?.();
  });

  it('returns false at the reader deadline without releasing either lease', async () => {
    vi.useFakeTimers();
    const releaseReader = await acquireCustomNodeReadLease('node-a');
    const releaseInstall = beginCustomNodeInstall('node-a');
    expect(releaseReader).not.toBeNull();
    expect(releaseInstall).not.toBeNull();

    const draining = waitForCustomNodeReaders('node-a', 50);
    await vi.advanceTimersByTimeAsync(50);

    await expect(draining).resolves.toBe(false);
    expect(beginCustomNodeInstall('node-b')).toBeNull();

    releaseInstall?.();
    releaseReader?.();
  });

  it('requires a positive finite reader deadline even when no readers exist', async () => {
    await expect(waitForCustomNodeReaders('node-a', 0)).rejects.toThrow(/positive finite/);
    await expect(waitForCustomNodeReaders('node-a', Number.POSITIVE_INFINITY)).rejects.toThrow(
      /positive finite/,
    );
  });

  it('allows a stable node to run while a different node is being installed', async () => {
    const releaseInstall = beginCustomNodeInstall('node-a');
    const releaseReader = await acquireCustomNodeReadLease('node-b');

    expect(releaseInstall).not.toBeNull();
    expect(releaseReader).not.toBeNull();
    releaseReader?.();
    releaseInstall?.();
  });

  it('cancels a wait without releasing the installer', async () => {
    const release = beginCustomNodeInstall('node-a');
    const controller = new AbortController();
    const waiting = acquireCustomNodeReadLease('node-a', controller.signal);

    controller.abort();
    await expect(waiting).resolves.toBeNull();
    expect(beginCustomNodeInstall('node-a')).toBeNull();

    release?.();
    expect(isAnyCustomNodeInstallInFlight()).toBe(false);
  });
});
