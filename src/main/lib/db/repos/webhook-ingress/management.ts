import { and, count, desc, eq, isNull } from 'drizzle-orm';
import type { getDatabase } from '../..';
import { integrations, integrationWebhooks } from '../../schema/webhook-ingress';

type Db = ReturnType<typeof getDatabase>;

export type LocalIntegrationRow = typeof integrations.$inferSelect;
export type LocalWebhookRow = typeof integrationWebhooks.$inferSelect;

/** A fresh subscribe key, its public address and a fresh signing secret, all already sealed. */
export type MintedKeys = {
  pathToken: string;
  subscribeKeyEncrypted: string;
  signingSecretEncrypted: string;
};

export async function findLocalIntegration(
  db: Db,
  integrationId: string,
): Promise<LocalIntegrationRow | undefined> {
  return db.select().from(integrations).where(eq(integrations.id, integrationId)).get();
}

/** Every account this machine holds, for the plugin directory's account column. */
export async function listLocalIntegrations(db: Db): Promise<LocalIntegrationRow[]> {
  return db.select().from(integrations).where(eq(integrations.isActive, true));
}

/** The account's addresses go with it: the endpoint rows cascade. */
export async function deleteLocalIntegration(db: Db, integrationId: string): Promise<void> {
  await db.delete(integrations).where(eq(integrations.id, integrationId));
}

/** The account owns one immutable key: a first write only, so a second key cannot replace it. */
export async function setLocalIntegrationToken(
  db: Db,
  integrationId: string,
  apiTokenEncrypted: string,
): Promise<boolean> {
  const rows = await db
    .update(integrations)
    .set({ apiTokenEncrypted, updatedAt: new Date() })
    .where(and(eq(integrations.id, integrationId), isNull(integrations.apiTokenEncrypted)))
    .returning({ id: integrations.id });
  return rows.length === 1;
}

/** The vendor's own id for the account holder; written once, when a lookup first resolves it. */
export async function setLocalIntegrationExternalUserId(
  db: Db,
  integrationId: string,
  externalUserId: string,
): Promise<void> {
  await db
    .update(integrations)
    .set({ externalUserId, updatedAt: new Date() })
    .where(and(eq(integrations.id, integrationId), isNull(integrations.externalUserId)));
}

/** Everything the card lists for one account, newest first, deactivated rows included. */
export async function listWebhookEndpointsForIntegration(
  db: Db,
  integrationId: string,
): Promise<LocalWebhookRow[]> {
  return db
    .select()
    .from(integrationWebhooks)
    .where(eq(integrationWebhooks.integrationId, integrationId))
    .orderBy(desc(integrationWebhooks.createdAt));
}

export async function findWebhookEndpoint(
  db: Db,
  integrationId: string,
  endpointId: string,
): Promise<LocalWebhookRow | undefined> {
  return db
    .select()
    .from(integrationWebhooks)
    .where(
      and(
        eq(integrationWebhooks.id, endpointId),
        eq(integrationWebhooks.integrationId, integrationId),
      ),
    )
    .get();
}

/** Deactivated rows count too: the cap is on addresses ever minted for one account, as hosted. */
export async function countWebhookEndpoints(db: Db, integrationId: string): Promise<number> {
  const row = await db
    .select({ total: count() })
    .from(integrationWebhooks)
    .where(eq(integrationWebhooks.integrationId, integrationId))
    .get();
  return row?.total ?? 0;
}

/** A rotation replaces the address and both secrets at once, so the old pair verifies nothing; it
 * lands only on the address the caller read, so two overlapping rotations cannot both succeed.
 * An `auto` row keeps its vendor handle: the same subscription is re-pointed at the new address. */
export async function rotateWebhookEndpointKeys(
  db: Db,
  endpointId: string,
  expectedPathToken: string,
  keys: MintedKeys,
  keepVendorRef = false,
): Promise<LocalWebhookRow | undefined> {
  const next: Partial<typeof integrationWebhooks.$inferInsert> = {
    ...keys,
    lastReceivedAt: null,
    lastError: null,
    lastErrorAt: null,
    updatedAt: new Date(),
  };
  if (!keepVendorRef) next.vendorRef = null;
  const [row] = await db
    .update(integrationWebhooks)
    .set(next)
    .where(
      and(
        eq(integrationWebhooks.id, endpointId),
        eq(integrationWebhooks.isActive, true),
        eq(integrationWebhooks.pathToken, expectedPathToken),
      ),
    )
    .returning();
  return row;
}

export async function deactivateWebhookEndpoint(
  db: Db,
  endpointId: string,
): Promise<LocalWebhookRow | undefined> {
  const [row] = await db
    .update(integrationWebhooks)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(integrationWebhooks.id, endpointId))
    .returning();
  return row;
}

/** The vendor's own key and the exact address it was configured against, written together: a
 * signature that covers the URL fails if either lands without the other. */
export async function setWebhookEndpointVendor(
  db: Db,
  endpointId: string,
  vendorRef: string,
  signingSecretEncrypted: string,
  expectedPathToken: string,
): Promise<boolean> {
  const rows = await db
    .update(integrationWebhooks)
    .set({
      vendorRef,
      signingSecretEncrypted,
      lastError: null,
      lastErrorAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(integrationWebhooks.id, endpointId),
        eq(integrationWebhooks.pathToken, expectedPathToken),
        eq(integrationWebhooks.isActive, true),
      ),
    )
    .returning({ id: integrationWebhooks.id });
  return rows.length === 1;
}

/** The owner confirms the challenge Notion sent, against the exact generation the card showed. */
export async function confirmNotionWebhook(
  db: Db,
  endpointId: string,
  generation: string,
  candidate: string,
): Promise<boolean> {
  const rows = await db
    .update(integrationWebhooks)
    .set({
      vendorRef: candidate.replace('notion:pending:', 'notion:verified:'),
      lastError: null,
      lastErrorAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(integrationWebhooks.id, endpointId),
        eq(integrationWebhooks.provider, 'notion'),
        eq(integrationWebhooks.pathToken, generation),
        eq(integrationWebhooks.vendorRef, candidate),
        eq(integrationWebhooks.isActive, true),
      ),
    )
    .returning({ id: integrationWebhooks.id });
  return rows.length === 1;
}

/** Notion cannot re-point a verified subscription, so restarting means a new address and key. */
export async function restartNotionWebhook(
  db: Db,
  endpointId: string,
  generation: string,
  candidate: string | null,
  keys: MintedKeys,
): Promise<boolean> {
  const rows = await db
    .update(integrationWebhooks)
    .set({
      ...keys,
      vendorRef: null,
      lastReceivedAt: null,
      lastError: null,
      lastErrorAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(integrationWebhooks.id, endpointId),
        eq(integrationWebhooks.provider, 'notion'),
        eq(integrationWebhooks.pathToken, generation),
        candidate === null
          ? isNull(integrationWebhooks.vendorRef)
          : eq(integrationWebhooks.vendorRef, candidate),
        eq(integrationWebhooks.isActive, true),
      ),
    )
    .returning({ id: integrationWebhooks.id });
  return rows.length === 1;
}
