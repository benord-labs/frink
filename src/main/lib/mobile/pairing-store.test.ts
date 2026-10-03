import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MobilePairingStore } from './pairing-store';

const endpoint = {
  relay: 'https://relay.frink.dev',
  route: 'a'.repeat(64),
  key: 'K'.repeat(43),
  machine: 'Mac',
};
let directory: string;
let filePath: string;
let now: number;
let store: MobilePairingStore;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'frink-mobile-pairing-'));
  filePath = join(directory, 'profile', 'mobile.json');
  now = Date.now();
  store = new MobilePairingStore(filePath, () => now);
  await store.initialize();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function pairPhone() {
  await store.enable();
  const { pairing } = await store.pair(endpoint);
  return store.redeem(pairing.code, 'My iPhone');
}

describe('mobile pairing credentials', () => {
  it('starts disabled and requires explicit enablement before pairing', async () => {
    expect(store.status()).toEqual({ enabled: false, error: null, devices: [] });
    await expect(store.pair(endpoint)).rejects.toThrow('Enable mobile access first');
    expect(store.authenticate('a'.repeat(43))).toBe(false);
  });

  it('writes only token digests with owner-only permissions and restores paired devices', async () => {
    await store.enable();
    const { pairing } = await store.pair(endpoint);
    const { token, deviceId } = await store.redeem(pairing.code, 'My iPhone');
    const persisted = await readFile(filePath, 'utf8');
    expect(persisted).not.toContain(token);
    expect(persisted).not.toContain(pairing.code);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(store.status().devices).toEqual([
      { id: deviceId, name: 'My iPhone', createdAt: new Date(now).toISOString() },
    ]);
    const reopened = new MobilePairingStore(filePath);
    await reopened.initialize();
    expect(reopened.authenticate(token)).toBe(true);
    expect(reopened.authenticate('a'.repeat(43))).toBe(false);
    expect(reopened.authenticate('')).toBe(false);
    expect(reopened.status().devices[0]).not.toHaveProperty('digest');
  });

  it('allows exactly one concurrent redemption of a pairing code', async () => {
    await store.enable();
    const { pairing } = await store.pair(endpoint);
    const results = await Promise.allSettled([
      store.redeem(pairing.code, 'First phone'),
      store.redeem(pairing.code, 'Second phone'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(store.status().devices).toHaveLength(1);
  });

  it('shows the one live code to every window, expires it at five minutes, then issues another', async () => {
    await store.enable();
    const first = await store.pair(endpoint);
    const second = await store.pair(endpoint);
    expect(second).toEqual(first);
    now += 5 * 60_000;
    await expect(store.redeem(first.pairing.code, 'Phone')).rejects.toThrow('expired');
    const fresh = await store.pair(endpoint);
    expect(fresh.pairing.code).not.toBe(first.pairing.code);
    await expect(store.redeem(first.pairing.code, 'Phone')).rejects.toThrow('incorrect');
    expect(store.status().devices).toHaveLength(0);
  });

  it('throttles expired QR guesses without locking out the correct fresh code', async () => {
    await store.enable();
    const expired = await store.pair(endpoint);
    now += 5 * 60_000 + 1;
    const fresh = await store.pair(endpoint);
    for (let attempt = 0; attempt < 10; attempt++) {
      await expect(store.redeem(expired.pairing.code, 'Phone')).rejects.toThrow('incorrect');
    }
    await expect(store.redeem(expired.pairing.code, 'Phone')).rejects.toThrow('Too many attempts');
    const credentials = await store.redeem(fresh.pairing.code, 'Phone');
    expect(store.authenticate(credentials.token)).toBe(true);
  });

  it('persists revocation and disabling removes every device and pending code', async () => {
    const first = await pairPhone();
    const next = await store.pair(endpoint);
    const second = await store.redeem(next.pairing.code, 'Second phone');
    await store.revoke(first.deviceId);
    expect(store.authenticate(first.token)).toBe(false);
    expect(store.authenticate(second.token)).toBe(true);
    const pending = await store.pair(endpoint);
    await store.disable();
    expect(store.authenticate(second.token)).toBe(false);
    await store.enable();
    await expect(store.redeem(pending.pairing.code, 'Third phone')).rejects.toThrow('expired');
    const reopened = new MobilePairingStore(filePath);
    await reopened.initialize();
    expect(reopened.status().devices).toEqual([]);
    expect(reopened.authenticate(first.token)).toBe(false);
    expect(reopened.authenticate(second.token)).toBe(false);
  });

  it('serializes disabling behind a redemption without leaving a valid credential', async () => {
    await store.enable();
    const { pairing } = await store.pair(endpoint);
    const [credentials] = await Promise.all([store.redeem(pairing.code, 'Phone'), store.disable()]);
    expect(store.authenticate(credentials.token)).toBe(false);
    expect(store.status().devices).toHaveLength(0);
    expect(JSON.parse(await readFile(filePath, 'utf8')).enabled).toBe(false);
  });

  it.each([
    ['revoke', 'reset'],
    ['disable', 'reset'],
    ['revoke', 'pair'],
  ] as const)(
    'discloses unsaved %s after a disk failure until %s succeeds',
    async (operation, recovery) => {
      const { token, deviceId } = await pairPhone();
      await chmod(join(directory, 'profile'), 0o500);
      try {
        const result = operation === 'revoke' ? store.revoke(deviceId) : store.disable();
        await expect(result).rejects.toThrow();
        expect(store.authenticate(token)).toBe(false);
        expect(store.status().error).toContain('could not be saved');
        expect(store.status().error).toContain('may return after restarting Frink');
      } finally {
        await chmod(join(directory, 'profile'), 0o700);
      }
      const reopened = new MobilePairingStore(filePath);
      await reopened.initialize();
      expect(reopened.authenticate(token)).toBe(true);

      if (recovery === 'pair') {
        const { pairing } = await store.pair(endpoint);
        const replacement = await store.redeem(pairing.code, 'Replacement phone');
        await reopened.initialize();
        expect(reopened.authenticate(replacement.token)).toBe(true);
      } else {
        await store.disable();
      }
      expect(store.status().error).toBeNull();
      await reopened.initialize();
      expect(reopened.status().enabled).toBe(recovery === 'pair');
      expect(reopened.authenticate(token)).toBe(false);
    },
  );

  it('issues no credential when persistence fails and keeps a valid code retryable', async () => {
    await store.enable();
    const { pairing } = await store.pair(endpoint);
    await rm(join(directory, 'profile'), { recursive: true });
    await writeFile(join(directory, 'profile'), 'not a directory');
    await expect(store.redeem(pairing.code, 'Phone')).rejects.toThrow();
    expect(store.status().devices).toHaveLength(0);
    await rm(join(directory, 'profile'));
    await mkdir(join(directory, 'profile'));
    const { token } = await store.redeem(pairing.code, 'Phone');
    expect(store.authenticate(token)).toBe(true);
  });

  it('fails closed on malformed configuration until an explicit reset', async () => {
    await mkdir(join(directory, 'profile'));
    await writeFile(filePath, '{"version":1,"enabled":true,"devices":[{"digest":"invalid"}]}');
    const invalid = new MobilePairingStore(filePath);
    await invalid.initialize();
    expect(invalid.status().enabled).toBe(false);
    expect(invalid.status().error).toContain('could not be read');
    await expect(invalid.enable()).rejects.toThrow('could not be read');
    await invalid.disable();
    await invalid.enable();
    expect(invalid.status().error).toBeNull();
  });

  it('stores, replaces, moves and clears a Live Activity token', async () => {
    const first = await pairPhone();
    const next = await store.pair(endpoint);
    const second = await store.redeem(next.pairing.code, 'Second phone');
    const [a, b] = ['a'.repeat(64), 'b'.repeat(64)];
    await store.notifications(first.token, { activityToken: a });
    expect(store.liveActivityRecipients()).toEqual([{ id: first.deviceId, token: a }]);
    await store.notifications(first.token, { activityToken: b });
    await store.notifications(first.token, {});
    expect(store.liveActivityRecipients()).toEqual([{ id: first.deviceId, token: b }]);
    // Re-pairing the same phone carries its token to the new pairing.
    await store.notifications(second.token, { activityToken: b });
    expect(store.liveActivityRecipients()).toEqual([{ id: second.deviceId, token: b }]);
    const reopened = new MobilePairingStore(filePath, () => now);
    await reopened.initialize();
    expect(reopened.liveActivityRecipients()).toEqual([{ id: second.deviceId, token: b }]);
    await store.notifications(second.token, { activityToken: null });
    expect(store.liveActivityRecipients()).toEqual([]);
  });

  it('skips tokens past the eight-hour card limit and drops them on revoke or disable', async () => {
    const { token } = await pairPhone();
    await store.notifications(token, { activityToken: 'a'.repeat(64) });
    now += 8 * 60 * 60_000 - 1;
    expect(store.liveActivityRecipients()).toHaveLength(1);
    await store.disable();
    expect(store.liveActivityRecipients()).toEqual([]);
    const phone = await pairPhone();
    await store.notifications(phone.token, { activityToken: 'a'.repeat(64) });
    now += 8 * 60 * 60_000;
    expect(store.liveActivityRecipients()).toEqual([]);
    await store.notifications(phone.token, { activityToken: 'b'.repeat(64) });
    expect(store.liveActivityRecipients()).toHaveLength(1);
    await store.revoke(phone.deviceId);
    expect(store.liveActivityRecipients()).toEqual([]);
  });

  it('clears a gone Live Activity token only while it is still current', async () => {
    const { token, deviceId } = await pairPhone();
    await store.notifications(token, { activityToken: 'b'.repeat(64) });
    await store.liveActivityGone(deviceId, 'a'.repeat(64));
    expect(store.liveActivityRecipients()).toHaveLength(1);
    await store.liveActivityGone(deviceId, 'b'.repeat(64));
    expect(store.liveActivityRecipients()).toEqual([]);
  });

  it.each([
    'http://relay.frink.dev',
    'https://user:pass@relay.frink.dev',
    'https://relay.frink.dev/path',
    'https://relay.frink.dev/?token=secret',
  ])('rejects unsafe relay address %s', async (relay) => {
    await store.enable();
    await expect(store.pair({ ...endpoint, relay })).rejects.toThrow();
  });

  it('reports a revocation once the token is refused, before the file is rewritten', async () => {
    await store.enable();
    const { pairing } = await store.pair(endpoint);
    const { token, deviceId } = await store.redeem(pairing.code, 'Phone');
    const seen: { refused: boolean; stillOnDisk: boolean }[] = [];
    await store.revoke(deviceId, () =>
      seen.push({
        refused: !store.authenticate(token),
        stillOnDisk: readFileSync(filePath, 'utf8').includes(deviceId),
      }),
    );
    expect(seen).toEqual([{ refused: true, stillOnDisk: true }]);
    expect(await readFile(filePath, 'utf8')).not.toContain(deviceId);
  });
});
