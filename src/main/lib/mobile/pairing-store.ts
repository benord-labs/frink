import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Mutex } from 'async-mutex';
import { z } from 'zod';
import { MOBILE_API_VERSION, mobilePairingSchema } from '../../../shared/types/remote/mobile';
import { MobileApiError } from './domain/errors';

const PAIRING_DURATION_MS = 5 * 60_000;
const MAX_PAIRING_ATTEMPTS = 10;
const MAX_DEVICES = 20;
const credentialSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const deviceSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(80),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
});
const configSchema = z.object({
  version: z.literal(MOBILE_API_VERSION),
  enabled: z.boolean(),
  devices: z.array(deviceSchema).max(MAX_DEVICES),
});
type MobileConfig = z.infer<typeof configSchema>;
type PendingPairing = { digest: string; expiresAt: number; attempts: number };

function emptyConfig(): MobileConfig {
  return { version: MOBILE_API_VERSION, enabled: false, devices: [] };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function matches(value: string, expected: string): boolean {
  return timingSafeEqual(Buffer.from(digest(value), 'hex'), Buffer.from(expected, 'hex'));
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

  async pair(url: string) {
    return this.mutex.runExclusive(() => {
      if (!this.config.enabled) throw new MobileApiError(409, 'Enable mobile access first.');
      if (this.config.devices.length >= MAX_DEVICES) {
        throw new MobileApiError(409, 'Remove a paired device before adding another.');
      }
      const pairing = mobilePairingSchema.parse({
        version: MOBILE_API_VERSION,
        url,
        code: randomBytes(32).toString('base64url'),
      });
      const expiresAt = this.now() + PAIRING_DURATION_MS;
      this.pending = { digest: digest(pairing.code), expiresAt, attempts: 0 };
      return { pairing, expiresAt: new Date(expiresAt).toISOString() };
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
      if (pending.attempts >= MAX_PAIRING_ATTEMPTS) {
        throw new MobileApiError(429, 'Too many attempts. Create a new pairing code in Frink.');
      }
      pending.attempts++;
      if (!credentialSchema.safeParse(code).success || !matches(code, pending.digest)) {
        throw new MobileApiError(401, 'Pairing code is incorrect.');
      }
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

  async revoke(id: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const config = {
        ...this.config,
        devices: this.config.devices.filter((device) => device.id !== id),
      };
      // A revoked token cannot authorize another request while the file write is pending.
      this.config = config;
      await this.persistRevocation(config);
    });
  }
}
