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
  sever: vi.fn(),
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
vi.mock('./relay-host', () => ({ startRelayHost: mocks.start }));
vi.mock('./live-activity', () => ({ startMobileLiveActivity: mocks.liveActivity }));
vi.mock('./live-activity/counts', () => ({ readWaitingChats: async () => new Map() }));

beforeEach(async () => {
  vi.resetModules();
  mocks.directory = await mkdtemp(join(tmpdir(), 'frink-mobile-lifecycle-'));
  vi.stubEnv('FRINK_MOBILE_RELAY_URL', undefined);
  vi.stubEnv('FRINK_WEBHOOK_BASE_URL', undefined);
  mocks.stop.mockReset();
  mocks.sever.mockReset();
  mocks.start
    .mockReset()
    .mockReturnValue({ close: mocks.stop, sever: mocks.sever, connected: () => true });
  mocks.warn.mockReset();
  mocks.liveActivity.mockReset().mockReturnValue({ stop: vi.fn(), endDevice: vi.fn() });
});
afterEach(async () => {
  vi.unstubAllEnvs();
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
      relayConnected: true,
    });
  });

  it('refuses to start without an HTTPS relay and says how to fix it', async () => {
    vi.stubEnv('FRINK_MOBILE_RELAY_URL', 'http://relay.example.com');
    const mobile = await import('./index');
    await expect(mobile.enableMobileAccess()).rejects.toThrow('needs the Frink relay');
    expect(await mobile.mobileAccessStatus()).toMatchObject({
      enabled: true,
      running: false,
      error: expect.stringContaining('FRINK_MOBILE_RELAY_URL'),
    });
    await expect(mobile.createMobilePairing()).rejects.toThrow('Enable mobile access');
    vi.stubEnv('FRINK_MOBILE_RELAY_URL', undefined);
    await mobile.enableMobileAccess();
    expect(await mobile.mobileAccessStatus()).toMatchObject({ running: true, error: null });
  });

  it.each(['https://webhook-tunnel.example.com', '', 'http://127.0.0.1:8787'])(
    'keeps mobile on the public relay when webhook ingress is %j',
    async (webhookUrl) => {
      vi.stubEnv('FRINK_WEBHOOK_BASE_URL', webhookUrl);
      const mobile = await import('./index');
      await mobile.enableMobileAccess();
      expect(mocks.start.mock.calls[0][0].relay).toBe('https://relay.frink.dev');
      expect((await mobile.createMobilePairing()).pairing.relay).toBe('https://relay.frink.dev');
    },
  );

  it('uses the explicit mobile relay override in both the host and QR', async () => {
    vi.stubEnv('FRINK_MOBILE_RELAY_URL', ' https://mobile.example.com/ ');
    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', 'https://webhooks.example.com');
    const mobile = await import('./index');
    await mobile.enableMobileAccess();
    expect(mocks.start.mock.calls[0][0].relay).toBe('https://mobile.example.com');
    expect((await mobile.createMobilePairing()).pairing.relay).toBe('https://mobile.example.com');
  });

  it.each(['', 'https://user:pass@relay.example.com', 'https://relay.example.com/path', 'https://relay.example.com/?key=x', 'https://relay.example.com/#fragment'])(
    'rejects a mobile relay that is not a bare HTTPS origin: %j',
    async (relay) => {
      vi.stubEnv('FRINK_MOBILE_RELAY_URL', relay);
      const mobile = await import('./index');
      await expect(mobile.enableMobileAccess()).rejects.toThrow('FRINK_MOBILE_RELAY_URL');
      expect(mocks.start).not.toHaveBeenCalled();
    },
  );

  it('hosts the route its pairing code names and pins the key it holds', async () => {
    const mobile = await import('./index');
    await mobile.enableMobileAccess();
    const [{ identity, relay }] = mocks.start.mock.calls[0] as [
      { identity: { route: string; routeKey: string }; relay: string },
    ];
    const { pairing } = await mobile.createMobilePairing();
    expect(relay).toBe('https://relay.frink.dev');
    expect(pairing).toMatchObject({ relay, route: identity.route, version: MOBILE_API_VERSION });
    expect(pairing.route).not.toBe(identity.routeKey);
    expect(JSON.stringify(pairing)).not.toContain(identity.routeKey);
  });

  it('revoking a phone severs its live channel', async () => {
    const mobile = await import('./index');
    await mobile.enableMobileAccess();
    const [store] = mocks.liveActivity.mock.calls[0] as [MobilePairingStore];
    const { pairing } = await mobile.createMobilePairing();
    const { token, deviceId } = await store.redeem(pairing.code, 'Phone');
    await mobile.revokeMobileDevice(deviceId);
    const [revoked] = mocks.sever.mock.calls[0] as [(token: string) => boolean];
    expect(revoked(token)).toBe(true);
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
    const before = (await mobile.createMobilePairing()).pairing;
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
    // Re-enabling mints a new identity, so an old QR or pinned key reaches nothing.
    await restarted.enableMobileAccess();
    const after = (await restarted.createMobilePairing()).pairing;
    expect(after.key).not.toBe(before.key);
    expect(after.route).not.toBe(before.route);
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
    const { pairing } = await mobile.createMobilePairing();
    const { deviceId } = await store.redeem(pairing.code, 'Phone');
    await mobile.revokeMobileDevice(deviceId);
    await mobile.disableMobileAccess();
    expect(seen).toEqual(['end paired', 'stop with access on']);
  });
});
