import crypto from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { getDatabase } from '../..';
import { integrations, integrationWebhooks } from '../../schema/webhook-ingress';

type Db = ReturnType<typeof getDatabase>;

/** The generation a write must still match, so a re-minted endpoint ignores an in-flight delivery. */
export type WebhookGeneration = { generation: string; vendorRef: string };

/** The endpoint an inbound delivery names, joined to the account that owns it. */
export type LocalWebhookEndpoint = {
  integration: { id: string; externalUserId: string | null };
  endpoint: {
    id: string;
    pathToken: string;
    signingSecretEncrypted: string;
    vendorRef: string | null;
  };
};

export type NewIntegration = {
  id?: string;
  provider: string;
  externalUserId?: string | null;
};

export type NewWebhookEndpoint = {
  id?: string;
  integrationId: string;
  provider: string;
  pathToken: string;
  subscribeKeyEncrypted: string;
  signingSecretEncrypted: string;
  vendorRef?: string | null;
};

function generationMatch(endpointId: string, expected: WebhookGeneration | undefined) {
  const byId = eq(integrationWebhooks.id, endpointId);
  if (!expected) return byId;
  return and(
    byId,
    eq(integrationWebhooks.pathToken, expected.generation),
    eq(integrationWebhooks.vendorRef, expected.vendorRef),
    eq(integrationWebhooks.isActive, true),
  );
}

export async function insertIntegration(db: Db, values: NewIntegration): Promise<string> {
  const [row] = await db.insert(integrations).values(values).returning({ id: integrations.id });
  if (!row) throw new Error('Failed to insert integration');
  return row.id;
}

export async function insertWebhookEndpoint(db: Db, values: NewWebhookEndpoint): Promise<string> {
  const [row] = await db
    .insert(integrationWebhooks)
    .values(values)
    .returning({ id: integrationWebhooks.id });
  if (!row) throw new Error('Failed to insert webhook endpoint');
  return row.id;
}

/** The one active endpoint that token names under that provider; the row, not the caller, is the truth. */
export async function findActiveWebhookEndpoint(
  db: Db,
  pathToken: string,
  provider: string,
): Promise<LocalWebhookEndpoint | null> {
  const [row] = await db
    .select({
      integrationId: integrations.id,
      externalUserId: integrations.externalUserId,
      id: integrationWebhooks.id,
      pathToken: integrationWebhooks.pathToken,
      signingSecretEncrypted: integrationWebhooks.signingSecretEncrypted,
      vendorRef: integrationWebhooks.vendorRef,
    })
    .from(integrationWebhooks)
    .innerJoin(integrations, eq(integrations.id, integrationWebhooks.integrationId))
    .where(
      and(
        eq(integrationWebhooks.pathToken, pathToken),
        eq(integrationWebhooks.provider, provider),
        eq(integrationWebhooks.isActive, true),
        eq(integrations.isActive, true),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    integration: { id: row.integrationId, externalUserId: row.externalUserId },
    endpoint: {
      id: row.id,
      pathToken: row.pathToken,
      signingSecretEncrypted: row.signingSecretEncrypted,
      vendorRef: row.vendorRef,
    },
  };
}

/** Every address this machine still answers for: the key a reconnecting client claims each one
 * with, the account whose class decides how a re-mint moves it, and the generation it must match. */
export async function listActiveWebhookEndpoints(db: Db): Promise<
  {
    id: string;
    integrationId: string;
    pathToken: string;
    subscribeKeyEncrypted: string;
    vendorRef: string | null;
  }[]
> {
  return db
    .select({
      id: integrationWebhooks.id,
      integrationId: integrationWebhooks.integrationId,
      pathToken: integrationWebhooks.pathToken,
      subscribeKeyEncrypted: integrationWebhooks.subscribeKeyEncrypted,
      vendorRef: integrationWebhooks.vendorRef,
    })
    .from(integrationWebhooks)
    .innerJoin(integrations, eq(integrations.id, integrationWebhooks.integrationId))
    .where(and(eq(integrationWebhooks.isActive, true), eq(integrations.isActive, true)));
}

/** Returns whether the endpoint is still the generation the caller verified against. */
export async function markWebhookEndpointReceived(
  db: Db,
  endpointId: string,
  expected?: WebhookGeneration,
  recordReceipt = true,
): Promise<boolean> {
  const where = generationMatch(endpointId, expected);
  if (!recordReceipt) {
    const [row] = await db
      .select({ id: integrationWebhooks.id })
      .from(integrationWebhooks)
      .where(where)
      .limit(1);
    return row !== undefined;
  }
  const now = new Date();
  const rows = await db
    .update(integrationWebhooks)
    .set({ lastReceivedAt: now, lastError: null, lastErrorAt: null, updatedAt: now })
    .where(where)
    .returning({ id: integrationWebhooks.id });
  return rows.length === 1;
}

export async function markWebhookEndpointError(
  db: Db,
  endpointId: string,
  errorMessage: string,
  expected?: WebhookGeneration,
): Promise<void> {
  const now = new Date();
  await db
    .update(integrationWebhooks)
    .set({ lastError: errorMessage, lastErrorAt: now, updatedAt: now })
    .where(generationMatch(endpointId, expected));
}

/** The unauthenticated handshake can suggest one key, but only the owner can confirm it. */
export async function captureNotionChallengeSecret(
  db: Db,
  endpointId: string,
  generation: string,
  signingSecretEncrypted: string,
): Promise<boolean> {
  const rows = await db
    .update(integrationWebhooks)
    .set({
      signingSecretEncrypted,
      vendorRef: `notion:pending:${crypto.randomUUID()}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(integrationWebhooks.id, endpointId),
        eq(integrationWebhooks.provider, 'notion'),
        eq(integrationWebhooks.pathToken, generation),
        isNull(integrationWebhooks.vendorRef),
        eq(integrationWebhooks.isActive, true),
      ),
    )
    .returning({ id: integrationWebhooks.id });
  return rows.length === 1;
}
