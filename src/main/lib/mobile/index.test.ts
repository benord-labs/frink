import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOBILE_API_VERSION } from '../../../shared/types/remote/mobile';
import type { MobilePairingStore } from './pairing-store';

const mocks = vi.hoisted(() => ({
  directory: '',
  start: vi.fn(),
  stop: vi.fn(),
  executor: vi.fn(),
  warn: vi.fn(),
  liveActivity: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => mocks.directory } }));
vi.mock('electron-log', () => ({ default: { warn: mocks.warn } }));
vi.mock('./domain-api', () => ({
  executeMobileRequest: mocks.executor,
  storeMobileAttachment: vi.fn(),
}));
vi.mock('./server', () => ({ startMobileServer: mocks.start, stopMobileServer: mocks.stop }));
vi.mock('./live-activity', () => ({ startMobileLiveActivity: mocks.liveActivity }));

beforeEach(async () => {
  vi.resetModules();
  mocks.directory = await mkdtemp(join(tmpdir(), 'frink-mobile-lifecycle-'));
  mocks.start.mockReset().mockResolvedValue({ listening: true });
  mocks.stop.mockReset().mockResolvedValue(undefined);
  mocks.warn.mockReset();
  mocks.liveActivity.mockReset().mockReturnValue({ stop: vi.fn(), endDevice: vi.fn() });
});
afterEach(async () => {
  await rm(mocks.directory, { recursive: true, force: true });
});

describe('desktop mobile access lifecycle', () => {
  it('never opens a listener until access is enabled and starts only once', async () => {
    const mobile = await import('./index');
    await mobile.initializeMobileAccess();
    expect(mocks.start).not.toHaveBeenCalled();
    await Promise.all([mobile.enableMobileAccess(), mobile.enableMobileAccess()]);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(await mobile.mobileAccessStatus()).toMatchObject({
      enabled: true,
      running: true,
      port: 43129,
    });
  });

  it('reports a port failure without pretending that mobile access is running', async () => {
    mocks.start.mockRejectedValueOnce(new Error('EADDRINUSE'));
    const mobile = await import('./index');
    await expect(mobile.enableMobileAccess()).rejects.toThrow('port 43129');
    expect(await mobile.mobileAccessStatus()).toMatchObject({
      enabled: true,
      running: false,
      error: expect.stringContaining('port 43129'),
    });
    await expect(mobile.createMobilePairing('https://computer.ts.net')).rejects.toThrow(
      'Enable mobile access',
    );
    await mobile.enableMobileAccess();
    expect(await mobile.mobileAccessStatus()).toMatchObject({ running: true, error: null });
  });

  it('restores an explicitly enabled listener and closes it without revoking on normal shutdown', async () => {
    await writeFile(
      join(mocks.directory, 'mobile.json'),
      JSON.stringify({ version: MOBILE_API_VERSION, enabled: true, devices: [] }),
    );
    const mobile = await import('./index');
    await mobile.initializeMobileAccess();
    expect(mocks.start).toHaveBeenCalledTimes(1);
    await mobile.stopMobileAccess();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(await mobile.mobileAccessStatus()).toMatchObject({ enabled: true, running: false });
    await mobile.stopMobileAccess();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it('explicit disable clears persisted grants and closes the listener', async () => {
    const mobile = await import('./index');
    await mobile.enableMobileAccess();
    await mobile.createMobilePairing('https://computer.ts.net');
    await mobile.disableMobileAccess();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(await mobile.mobileAccessStatus()).toMatchObject({
      enabled: false,
      running: false,
      devices: [],
    });
    vi.resetModules();
    const restarted = await import('./index');
    await restarted.initializeMobileAccess();
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it('logs listener close errors without interrupting the remaining app shutdown', async () => {
    const mobile = await import('./index');
    await mobile.enableMobileAccess();
    const error = new Error('Listener was already closed');
    mocks.stop.mockRejectedValueOnce(error);

    await expect(mobile.stopMobileAccess()).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledWith('[Mobile] Listener shutdown failed:', error);
    expect(await mobile.mobileAccessStatus()).toMatchObject({ enabled: true, running: false });
    await mobile.stopMobileAccess();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it('makes corrupt persisted settings recoverable without ever opening the server', async () => {
    await writeFile(join(mocks.directory, 'mobile.json'), 'broken config');
    const mobile = await import('./index');
    await mobile.initializeMobileAccess();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(await mobile.mobileAccessStatus()).toMatchObject({
      enabled: false,
      running: false,
      error: expect.any(String),
    });
    await mobile.disableMobileAccess();
    await mobile.enableMobileAccess();
    expect(await mobile.mobileAccessStatus()).toMatchObject({
      enabled: true,
      running: true,
      error: null,
    });
  });

  it('ends Live Activity cards while the store still knows the phone', async () => {
    const seen: string[] = [];
    mocks.liveActivity.mockImplementation((store: MobilePairingStore) => ({
      stop: () => seen.push(`stop with access ${store.status().enabled ? 'on' : 'off'}`),
      endDevice: (id: string) =>
        seen.push(
          `end ${store.status().devices.some((device) => device.id === id) ? 'paired' : 'gone'}`,
        ),
    }));
    const mobile = await import('./index');
    await mobile.enableMobileAccess();
    const [store] = mocks.liveActivity.mock.calls[0] as [MobilePairingStore];
    const { pairing } = await mobile.createMobilePairing('https://computer.ts.net');
    const { deviceId } = await store.redeem(pairing.code, 'Phone');
    await mobile.revokeMobileDevice(deviceId);
    await mobile.disableMobileAccess();
    expect(seen).toEqual(['end paired', 'stop with access on']);
  });
});
