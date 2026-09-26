import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { integrationWebhooks, integrations } from '../../schema/webhook-ingress';
import { freshDb } from '../../test-utils/fresh-db';
import {
  captureNotionChallengeSecret,
  findActiveWebhookEndpoint,
  insertIntegration,
  insertWebhookEndpoint,
  markWebhookEndpointError,
  markWebhookEndpointReceived,
  type NewWebhookEndpoint,
} from '.';

type Db = ReturnType<typeof freshDb>;

const TOKEN = 'a'.repeat(64);
const OTHER_TOKEN = 'b'.repeat(64);

async function seed(
  db: Db,
  endpoint: Partial<NewWebhookEndpoint> = {},
  provider = 'generic_webhook',
) {
  const integrationId = await insertIntegration(db, { provider, externalUserId: 'owner-1' });
  const endpointId = await insertWebhookEndpoint(db, {
    integrationId,
    provider,
    pathToken: TOKEN,
    subscribeKeyEncrypted: 'sealed-k',
    signingSecretEncrypted: 'sealed-s',
    ...endpoint,
  });
  return { integrationId, endpointId };
}

function readRow(db: Db, endpointId: string) {
  return db.select().from(integrationWebhooks).where(eq(integrationWebhooks.id, endpointId)).get();
}

describe('local webhook endpoint lookup', () => {
  it('returns the endpoint and its account for an active row', async () => {
    const db = freshDb();
    const { integrationId, endpointId } = await seed(db);

    expect(await findActiveWebhookEndpoint(db, TOKEN, 'generic_webhook')).toEqual({
      integration: { id: integrationId, externalUserId: 'owner-1' },
      endpoint: {
        id: endpointId,
        pathToken: TOKEN,
        signingSecretEncrypted: 'sealed-s',
        vendorRef: null,
      },
    });
  });

  it('will not answer for another provider, an inactive row, or an inactive account', async () => {
    const db = freshDb();
    const { integrationId, endpointId } = await seed(db);

    expect(await findActiveWebhookEndpoint(db, TOKEN, 'linear')).toBeNull();
    expect(await findActiveWebhookEndpoint(db, OTHER_TOKEN, 'generic_webhook')).toBeNull();

    await db
      .update(integrationWebhooks)
      .set({ isActive: false })
      .where(eq(integrationWebhooks.id, endpointId));
    expect(await findActiveWebhookEndpoint(db, TOKEN, 'generic_webhook')).toBeNull();

    await db
      .update(integrationWebhooks)
      .set({ isActive: true })
      .where(eq(integrationWebhooks.id, endpointId));
    await db
      .update(integrations)
      .set({ isActive: false })
      .where(eq(integrations.id, integrationId));
    expect(await findActiveWebhookEndpoint(db, TOKEN, 'generic_webhook')).toBeNull();
  });

  it('drops the endpoint with the account it belonged to', async () => {
    const db = freshDb();
    const { integrationId } = await seed(db);

    await db.delete(integrations).where(eq(integrations.id, integrationId));

    expect(await db.select().from(integrationWebhooks)).toEqual([]);
  });
});

describe('local webhook endpoint stamps', () => {
  it('records receipt and clears the previous error', async () => {
    const db = freshDb();
    const { endpointId } = await seed(db);

    await markWebhookEndpointError(db, endpointId, 'Invalid webhook signature - secret mismatch');
    expect(readRow(db, endpointId)?.lastError).toBe('Invalid webhook signature - secret mismatch');

    expect(await markWebhookEndpointReceived(db, endpointId)).toBe(true);
    const row = readRow(db, endpointId);
    expect(row?.lastError).toBeNull();
    expect(row?.lastErrorAt).toBeNull();
    expect(row?.lastReceivedAt).toBeInstanceOf(Date);
  });

  it('refuses both stamps once the endpoint has been re-minted', async () => {
    const db = freshDb();
    const { endpointId } = await seed(db, { vendorRef: 'notion:verified:v1' }, 'notion');
    const stale = { generation: OTHER_TOKEN, vendorRef: 'notion:verified:v1' };

    expect(await markWebhookEndpointReceived(db, endpointId, stale)).toBe(false);
    await markWebhookEndpointError(db, endpointId, 'Signature required', stale);

    const row = readRow(db, endpointId);
    expect(row?.lastReceivedAt).toBeNull();
    expect(row?.lastError).toBeNull();
  });

  it('reports the live generation without claiming a vendor receipt', async () => {
    const db = freshDb();
    const { endpointId } = await seed(db, { vendorRef: 'notion:verified:v1' }, 'notion');
    const live = { generation: TOKEN, vendorRef: 'notion:verified:v1' };

    expect(await markWebhookEndpointReceived(db, endpointId, live, false)).toBe(true);
    expect(readRow(db, endpointId)?.lastReceivedAt).toBeNull();
  });
});

describe('Notion challenge capture', () => {
  it('accepts the first challenge and refuses every later one', async () => {
    const db = freshDb();
    const { endpointId } = await seed(db, {}, 'notion');

    expect(await captureNotionChallengeSecret(db, endpointId, TOKEN, 'sealed-first')).toBe(true);
    const claimed = readRow(db, endpointId);
    expect(claimed?.signingSecretEncrypted).toBe('sealed-first');
    expect(claimed?.vendorRef).toMatch(/^notion:pending:/);

    expect(await captureNotionChallengeSecret(db, endpointId, TOKEN, 'sealed-second')).toBe(false);
    expect(readRow(db, endpointId)?.signingSecretEncrypted).toBe('sealed-first');
  });

  it('refuses a challenge aimed at a superseded address', async () => {
    const db = freshDb();
    const { endpointId } = await seed(db, {}, 'notion');

    expect(await captureNotionChallengeSecret(db, endpointId, OTHER_TOKEN, 'sealed-x')).toBe(false);
    expect(readRow(db, endpointId)?.vendorRef).toBeNull();
  });
});
