import { eq } from 'drizzle-orm';
import { integrationWebhooks } from '../db/schema/webhook-ingress';
import type { TestDb } from '../db/test-utils/fresh-db';
import type { LocalWebhookIo } from './deps';

/** Tests have no OS keyring, so the sealing is a visible prefix the deps unwrap the same way. */
export function seal(plaintext: string): string {
  return `sealed:${plaintext}`;
}

export const FOREIGN_KEYRING = 'sealed-on-another-machine';

export function unseal(ciphertext: string): string | null {
  // safeStorage throws on ciphertext another machine's keyring sealed, rather than returning null.
  if (ciphertext === FOREIGN_KEYRING) throw new Error('Cannot decrypt this buffer');
  return ciphertext.startsWith('sealed:') ? ciphertext.slice('sealed:'.length) : null;
}

export function sealedWebhookIo(
  db: TestDb,
  forwardEvent: LocalWebhookIo['forwardEvent'],
  captureException: LocalWebhookIo['captureException'],
): LocalWebhookIo {
  return { db, encryptSecret: seal, decryptSecret: unseal, forwardEvent, captureException };
}

export function endpointRow(db: TestDb, id: string) {
  return db.select().from(integrationWebhooks).where(eq(integrationWebhooks.id, id)).get();
}
