import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Mutex } from 'async-mutex';
import { z } from 'zod';
import {
  MOBILE_API_VERSION,
  mobilePairingSchema,
  type MobilePairing,
} from '../../../shared/types/remote/mobile';
import {
  liveActivityTokenSchema,
  pushTokenSchema,
  type NotificationRegistration,
} from '../../../shared/types/remote/notifications';
import { MobileApiError } from './domain/errors';

const PAIRING_DURATION_MS = 5 * 60_000;
const MAX_PAIRING_ATTEMPTS = 10;
const MAX_DEVICES = 20;
/** iOS ends a Live Activity after eight hours, so an older token has nothing left to update. */
const ACTIVITY_TOKEN_MAX_AGE_MS = 8 * 60 * 60_000;
const credentialSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const deviceSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(80),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
  pushToken: pushTokenSchema.optional(),
  pushError: z.string().optional(),
  activityToken: liveActivityTokenSchema.optional(),
  activityTokenAt: z.iso.datetime().optional(),
});
const configSchema = z.object({
  version: z.literal(MOBILE_API_VERSION),
  enabled: z.boolean(),
  devices: z.array(deviceSchema).max(MAX_DEVICES),
});
type MobileConfig = z.infer<typeof configSchema>;
type Device = z.infer<typeof deviceSchema>;
type PendingPairing = {
  digest: string;
  expiresAt: number;
  attempts: number;
  /** Held in memory only, so a second Settings window shows the live code instead of replacing it. */
  issued: { pairing: MobilePairing; expiresAt: string };
};

function emptyConfig(): MobileConfig {
  return { version: MOBILE_API_VERSION, enabled: false, devices: [] };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function matches(value: string, expected: string): boolean {
  return timingSafeEqual(Buffer.from(digest(value), 'hex'), Buffer.from(expected, 'hex'));
}

/** One token belongs to one pairing, so re-pairing the phone retires a stale entry's copy. */
function assignToken(
  devices: Device[],
  id: string,
  key: 'pushToken' | 'activityToken',
  token: string | undefined,
  fields: (token?: string) => Partial<Device>,
): Device[] {
  return devices.map((entry) =>
    entry.id === id
      ? { ...entry, ...fields(token) }
      : token && entry[key] === token
        ? { ...entry, ...fields() }
        : entry,
  );
}

/** One authority for the per-installation credentials; plaintext credentials never reach disk. */
export class MobilePairingStore {
  private config = emptyConfig();
  private pending: PendingPairing | null = null;
  private readonly mutex = new Mutex();
  private configError: string | null = null;

  constructor(
    private readonly filePath: string,
    private readonly now = Date.now,
  ) {}

  async initialize(): Promise<void> {
    try {
      this.config = configSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      this.config = emptyConfig();
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        this.configError =
          'Mobile access configuration could not be read. Reset mobile access to pair again.';
      }
    }
  }

  status() {
    return {
      enabled: this.config.enabled,
      error: this.configError,
      devices: this.config.devices.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
    };
  }

  private async persist(config: MobileConfig): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
      this.config = config;
      this.configError = null;
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async persistRevocation(config: MobileConfig): Promise<void> {
    try {
      await this.persist(config);
    } catch (error) {
      this.configError =
        'Mobile access changes could not be saved. Removed access is blocked for this session but may return after restarting Frink. Reset mobile access to retry.';
      throw error;
    }
  }

  async enable(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      if (this.configError) throw new MobileApiError(503, this.configError);
      await this.persist({ ...this.config, enabled: true });
    });
  }

  async disable(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      // Revoke in memory before I/O, including when a disk failure prevents persistence.
      this.pending = null;
      this.config = emptyConfig();
      await this.persistRevocation(this.config);
    });
  }

  /** `address` is where this desktop is reached; the store adds the one-time code. */
  async pair(address: Omit<MobilePairing, 'version' | 'code'>) {
    return this.mutex.runExclusive(() => {
      if (!this.config.enabled) throw new MobileApiError(409, 'Enable mobile access first.');
      if (this.config.devices.length >= MAX_DEVICES) {
        throw new MobileApiError(409, 'Remove a paired device before adding another.');
      }
      const live = this.pending;
      const reusable = live && this.now() < live.expiresAt && live.attempts < MAX_PAIRING_ATTEMPTS;
      if (reusable && live.issued.pairing.route === address.route) return live.issued;
      const pairing = mobilePairingSchema.parse({
        ...address,
        version: MOBILE_API_VERSION,
        code: randomBytes(32).toString('base64url'),
      });
      const expiresAt = this.now() + PAIRING_DURATION_MS;
      const issued = { pairing, expiresAt: new Date(expiresAt).toISOString() };
      this.pending = { digest: digest(pairing.code), expiresAt, attempts: 0, issued };
      return issued;
    });
  }

  async redeem(code: string, name: string): Promise<{ token: string; deviceId: string }> {
    return this.mutex.runExclusive(async () => {
      const pending = this.pending;
      if (!this.config.enabled || !pending || this.now() >= pending.expiresAt) {
        this.pending = null;
        throw new MobileApiError(
          401,
          'Pairing code expired or already used. Create a new code in Frink.',
        );
      }
      if (!credentialSchema.safeParse(code).success || !matches(code, pending.digest)) {
        if (pending.attempts >= MAX_PAIRING_ATTEMPTS) {
          throw new MobileApiError(429, 'Too many attempts. Create a new pairing code in Frink.');
        }
        pending.attempts++;
        throw new MobileApiError(401, 'Pairing code is incorrect.');
      }
      // Wrong guesses cannot lock out the holder of the current 256-bit capability.
      const token = randomBytes(32).toString('base64url');
      const device = deviceSchema.parse({
        id: randomUUID(),
        name,
        digest: digest(token),
        createdAt: new Date(this.now()).toISOString(),
      });
      await this.persist({ ...this.config, devices: [...this.config.devices, device] });
      this.pending = null;
      return { token, deviceId: device.id };
    });
  }

  authenticate(token: string): boolean {
    if (!this.config.enabled || !credentialSchema.safeParse(token).success) return false;
    return this.config.devices.some((device) => matches(token, device.digest));
  }

  async notifications(credential: string, input: NotificationRegistration) {
    return this.mutex.runExclusive(async () => {
      if (!this.authenticate(credential)) throw new MobileApiError(401, 'Pair this device again.');
      const device = this.config.devices.find((entry) => matches(credential, entry.digest))!;
      let { devices } = this.config;
      if (input.token !== undefined && (input.token !== device.pushToken || device.pushError)) {
        devices = assignToken(
          devices,
          device.id,
          'pushToken',
          input.token ?? undefined,
          (pushToken) => ({
            pushToken,
            pushError: undefined,
          }),
        );
      }
      const activityToken = input.activityToken ?? undefined;
      if (input.activityToken !== undefined && activityToken !== device.activityToken) {
        const at = new Date(this.now()).toISOString();
        devices = assignToken(devices, device.id, 'activityToken', activityToken, (token) => ({
          activityToken: token,
          activityTokenAt: token && at,
        }));
      }
      if (devices !== this.config.devices) await this.persist({ ...this.config, devices });
      const current = this.config.devices.find((entry) => entry.id === device.id)!;
      return { enabled: !!current.pushToken, error: current.pushError ?? null };
    });
  }

  notificationRecipients() {
    return this.config.enabled
      ? this.config.devices.flatMap(({ id, pushToken }) =>
          pushToken ? [{ id, token: pushToken }] : [],
        )
      : [];
  }

  liveActivityRecipients() {
    const cutoff = this.now() - ACTIVITY_TOKEN_MAX_AGE_MS;
    return this.config.enabled
      ? this.config.devices.flatMap(({ id, activityToken, activityTokenAt }) =>
          activityToken && Date.parse(activityTokenAt!) > cutoff
            ? [{ id, token: activityToken }]
            : [],
        )
      : [];
  }

  /** Clears the token only while it is still current, so a newer card keeps its token. */
  async liveActivityGone(id: string, token: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      if (!this.config.devices.some((entry) => entry.id === id && entry.activityToken === token))
        return;
      await this.persist({
        ...this.config,
        devices: assignToken(this.config.devices, id, 'activityToken', undefined, () => ({
          activityToken: undefined,
          activityTokenAt: undefined,
        })),
      });
    });
  }

  async notificationFailed(id: string, token: string, unregistered: boolean): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const device = this.config.devices.find(
        (entry) => entry.id === id && entry.pushToken === token,
      );
      if (!device) return;
      await this.persist({
        ...this.config,
        devices: this.config.devices.map((entry) =>
          entry === device
            ? {
                ...entry,
                pushToken: unregistered ? undefined : token,
                pushError: unregistered
                  ? 'Your Mac couldn’t reach this iPhone. Turn this on again to keep getting alerts.'
                  : 'Your Mac couldn’t deliver the last alert.',
              }
            : entry,
        ),
      });
    });
  }

  /** `revoked` runs once the token is refused in memory, before the file write. */
  async revoke(id: string, revoked?: () => void): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const config = {
        ...this.config,
        devices: this.config.devices.filter((device) => device.id !== id),
      };
      // A revoked token cannot authorize another request while the file write is pending.
      this.config = config;
      revoked?.();
      await this.persistRevocation(config);
    });
  }
}
