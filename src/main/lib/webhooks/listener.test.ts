import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WEBHOOK_BODY_MAX_BYTES } from '../../../shared/webhooks/content-limits';
import { buildGithubSignature } from '../../../shared/webhooks/github-hmac';
import type { WebhookReceiverDeps } from '../../../shared/webhooks/receiver';
import { insertIntegration, insertWebhookEndpoint } from '../db/repos/webhook-ingress';
import { integrationWebhooks } from '../db/schema/webhook-ingress';
import { freshDb } from '../db/test-utils/fresh-db';
import { createLocalWebhookDeps } from './deps';
import { startWebhookListener } from './listener';
import { endpointRow, FOREIGN_KEYRING, seal, sealedWebhookIo } from './test-utils';

type ForwardedWebhookEvent = Parameters<WebhookReceiverDeps['forwardWebhookEvent']>[0];

const SECRET = 'f'.repeat(64);
const TOKEN = 'a'.repeat(64);
const NOT_FOUND = { status: 'ignored', reason: 'webhook_not_found_or_inactive' };

let db: ReturnType<typeof freshDb>;
let forwarded: ForwardedWebhookEvent[];
let captured: unknown[];
let lookups: number;
let listener: Awaited<ReturnType<typeof startWebhookListener>>;
let integrationId: string;
let endpointId: string;

const UNREADABLE_SECRET = 'The saved secret for this address cannot be read on this machine';

async function seedEndpoint(provider: string, pathToken = TOKEN) {
  const id = await insertIntegration(db, { provider, externalUserId: 'owner-1' });
  const endpoint = await insertWebhookEndpoint(db, {
    integrationId: id,
    provider,
    pathToken,
    subscribeKeyEncrypted: seal('subscribe-key'),
    signingSecretEncrypted: seal(SECRET),
  });
  return { id, endpoint };
}

function post(path: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${listener.port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-frink-delivery-id': 'delivery-1',
      ...headers,
    },
    body,
  });
}

function signed(body: string, secret = SECRET) {
  return post(`/api/triggers/generic_webhook/${TOKEN}`, body, {
    'x-frink-signature': buildGithubSignature(secret, body),
  });
}

beforeEach(async () => {
  db = freshDb();
  forwarded = [];
  captured = [];
  lookups = 0;
  const seeded = await seedEndpoint('generic_webhook');
  integrationId = seeded.id;
  endpointId = seeded.endpoint;
  const base = createLocalWebhookDeps(
    sealedWebhookIo(
      db,
      async (event) => {
        forwarded.push(event);
      },
      (cause) => captured.push(cause),
    ),
  );
  listener = await startWebhookListener(
    {
      ...base,
      getWebhookEndpointByPathToken: (pathToken, provider) => {
        lookups += 1;
        return base.getWebhookEndpointByPathToken(pathToken, provider);
      },
    },
    0,
  );
});

afterEach(async () => {
  await listener.close();
  db.$client.close();
});

describe('loopback webhook ingress', () => {
  it('turns a signed delivery into a flow-start event with no account involved', async () => {
    const body = JSON.stringify({ order: 'o-1' });

    const res = await signed(body);

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'relayed', eventType: 'received' });
    expect(forwarded).toHaveLength(1);
    const event = forwarded[0];
    expect(event.integrationId).toBe(integrationId);
    expect(event.eventType).toBe('received');
    expect(event.deliveryId).toBe(createHash('sha256').update(body).digest('hex'));
    expect(event.ownerExternalId).toBe('owner-1');
    expect(event.rawPayload).toEqual({ order: 'o-1' });
    // The parts `handleVerifiedWebhookEvent` builds the idempotency key from, and the key it
    // must not carry: a machine with nobody signed in names no user.
    expect('userId' in event).toBe(false);
    expect(endpointRow(db, endpointId)?.lastReceivedAt).toBeInstanceOf(Date);
    expect(captured).toEqual([]);
  });

  it('verifies over the exact bytes a multibyte body was signed as', async () => {
    const body = JSON.stringify({ title: 'café — 日本語 🚀' });

    expect((await signed(body)).status).toBe(202);
    expect(forwarded[0].rawPayload).toEqual({ title: 'café — 日本語 🚀' });
  });

  it('refuses a tampered signature, starts nothing, and says so on the endpoint', async () => {
    const body = JSON.stringify({ order: 'o-1' });
    const signature = buildGithubSignature(SECRET, body);
    const flipped = `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`;

    const res = await post(`/api/triggers/generic_webhook/${TOKEN}`, body, {
      'x-frink-signature': flipped,
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid signature' });
    expect(forwarded).toEqual([]);
    const row = endpointRow(db, endpointId);
    expect(row?.lastError).toBe('Invalid webhook signature - secret mismatch');
    expect(row?.lastReceivedAt).toBeNull();
  });

  it('refuses a provider whose catalog row names no signature scheme', async () => {
    const supabase = await seedEndpoint('supabase', 'b'.repeat(64));

    const res = await post(
      `/api/triggers/supabase/${'b'.repeat(64)}`,
      JSON.stringify({ type: 'INSERT' }),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Signature required' });
    expect(forwarded).toEqual([]);
    expect(endpointRow(db, supabase.endpoint)?.lastError).toBe(
      'Missing required webhook signature',
    );
  });

  it('answers an unminted address and an unrouted path identically', async () => {
    const unknownToken = await post(
      `/api/triggers/generic_webhook/${'c'.repeat(64)}`,
      JSON.stringify({}),
    );
    const unknownRoute = await post('/api/triggers/generic_webhook', JSON.stringify({}));

    expect(unknownRoute.status).toBe(unknownToken.status);
    expect(await unknownRoute.json()).toEqual(await unknownToken.json());
    expect(unknownToken.status).toBe(404);
    expect(forwarded).toEqual([]);
  });

  it('will not answer for a token addressed under another vendor', async () => {
    const body = JSON.stringify({ order: 'o-1' });

    const res = await post(`/api/triggers/linear/${TOKEN}`, body, {
      'x-frink-signature': buildGithubSignature(SECRET, body),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
    expect(forwarded).toEqual([]);
  });

  it('refuses an oversized body before it looks the endpoint up at all', async () => {
    const body = `{"pad":"${'x'.repeat(WEBHOOK_BODY_MAX_BYTES)}"}`;

    const res = await signed(body);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Payload too large' });
    expect(lookups).toBe(0);
    expect(forwarded).toEqual([]);
  });

  it.each(['not-sealed', FOREIGN_KEYRING])(
    'answers as if unminted when the stored secret cannot be read (%s), and says so on the row',
    async (signingSecretEncrypted) => {
      await db
        .update(integrationWebhooks)
        .set({ signingSecretEncrypted })
        .where(eq(integrationWebhooks.id, endpointId));

      const res = await signed(JSON.stringify({ order: 'o-1' }));

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
      expect(forwarded).toEqual([]);
      expect(captured).toEqual([]);
      expect(endpointRow(db, endpointId)?.lastError).toBe(UNREADABLE_SECRET);
    },
  );
});
