import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRelay, type Relay } from '../../../../relay/src/index';
import { PROVIDERS } from '../../../shared/integrations/providers';
import { getProviderById, mintsLocally } from '../../../shared/integrations/selectors';
import { buildGithubSignature } from '../../../shared/webhooks/github-hmac';
import type { WebhookReceiverDeps } from '../../../shared/webhooks/receiver';
import { vendorSignatureHeaders } from '../../../shared/webhooks/signatures/vendor-hmac';
import {
  deleteLocalIntegration,
  insertIntegration,
  type LocalWebhookRow,
} from '../db/repos/webhook-ingress';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import { createLocalWebhookDeps } from './deps';
import { startWebhookListener } from './listener';
import {
  confirmLocalNotion,
  createLocalTriggerAccount,
  deactivateLocalEndpoint,
  importLocalVendorSecret,
  listLocalEndpoints,
  type LocalEndpointIo,
  type LocalEndpointView,
  type LocalTriggerAccount,
  mintLocalEndpoint,
  rotateLocalEndpoint,
  sendLocalTestEvent,
} from './local-endpoints';
import { type RelayClient, startRelayClient } from './relay-client';
import { endpointRow } from './test-utils';

type ForwardedWebhookEvent = Parameters<WebhookReceiverDeps['forwardWebhookEvent']>[0];

const PROVIDER = 'sentry';
const CLIENT_SECRET = 'sentry-client-secret-abcdef';
const ENDPOINT_LIMIT = 3;
const KEYRING = randomBytes(32);
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A sealer the test cannot see through, so "no secret in the clear" is a real assertion. */
function seal(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', KEYRING, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function unseal(ciphertext: string): string {
  const raw = Buffer.from(ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', KEYRING, raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([
    decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
}

let relay: Relay;
let relayPort: number;
let loopback: { port: number; close(): Promise<void> };
let db: TestDb;
let io: LocalEndpointIo;
let client: RelayClient | null;
let forwarded: ForwardedWebhookEvent[];
let captured: unknown[];

function listen(server: Relay): Promise<number> {
  return new Promise((resolve) => {
    server.httpServer.listen(0, () => {
      const address = server.httpServer.address();
      if (!(address instanceof Object)) throw new Error('the relay bound no TCP port');
      resolve(address.port);
    });
  });
}

async function account(provider = PROVIDER): Promise<LocalTriggerAccount> {
  return { id: await createLocalTriggerAccount(io, provider), provider };
}

function storedRow(endpointId: string): LocalWebhookRow {
  const row = endpointRow(db, endpointId);
  if (!row) throw new Error('the endpoint row vanished');
  return row;
}

function subscribeKey(endpointId: string): string {
  return unseal(storedRow(endpointId).subscribeKeyEncrypted);
}

/** The client this machine really runs: it claims whatever addresses the table holds right now. */
function startClient(owner: LocalTriggerAccount): void {
  client = startRelayClient({
    subscribeKeys: async () =>
      (await listLocalEndpoints(io, owner)).map((row) => subscribeKey(row.id)),
    deps: createLocalWebhookDeps(io),
  });
}

async function mint(owner: LocalTriggerAccount): Promise<LocalEndpointView> {
  const minted = await mintLocalEndpoint(io, owner, ENDPOINT_LIMIT);
  if (!minted.success) throw new Error(minted.error);
  return minted.endpoint;
}

/** Mint, then hand the vendor's own key back the way the card's setup form does. */
async function armedEndpoint(owner: LocalTriggerAccount): Promise<LocalEndpointView> {
  const endpoint = await mint(owner);
  const imported = await importLocalVendorSecret(io, owner, endpoint.id, CLIENT_SECRET);
  if (!imported.success) throw new Error(imported.error);
  return endpoint;
}

function post(
  base: string,
  endpoint: LocalEndpointView,
  body: string,
  headers: Record<string, string>,
) {
  return fetch(`${base}/api/triggers/${endpoint.provider}/${endpoint.webhookPathToken}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

/** Exactly the headers Sentry sends: one signature over the unmodified body. */
function sentryHeaders(url: string, body: string): Record<string, string> {
  const signed = vendorSignatureHeaders('sentry', CLIENT_SECRET, url, body);
  return Object.fromEntries(Object.entries(signed).map(([name, value]) => [name, String(value)]));
}

function sentryPost(base: string, endpoint: LocalEndpointView, body: string) {
  return post(base, endpoint, body, sentryHeaders(endpoint.webhookUrl, body));
}

function claimed(address: string): Promise<void> {
  return vi.waitFor(
    () => {
      expect(relay.io.sockets.adapter.rooms.has(address)).toBe(true);
    },
    { timeout: 10_000 },
  );
}

beforeEach(async () => {
  relay = createRelay();
  relayPort = await listen(relay);
  vi.stubEnv('FRINK_WEBHOOK_BASE_URL', `http://127.0.0.1:${relayPort}`);
  db = freshDb();
  forwarded = [];
  captured = [];
  client = null;
  io = {
    db,
    encryptSecret: seal,
    decryptSecret: unseal,
    forwardEvent: async (event) => {
      forwarded.push(event);
    },
    captureException: (cause) => captured.push(cause),
    claimAddresses: () => client?.refresh(),
  };
  loopback = await startWebhookListener(createLocalWebhookDeps(io), 0);
});

afterEach(async () => {
  client?.close();
  await loopback.close();
  await relay.close();
  db.$client.close();
  vi.unstubAllEnvs();
});

describe('local webhook endpoints', () => {
  it('mints, adopts the vendor key, tests and takes a real Sentry delivery', async () => {
    const owner = await account();
    startClient(owner);
    await vi.waitFor(() => {
      expect(relay.io.engine.clientsCount).toBe(1);
    });

    const endpoint = await armedEndpoint(owner);
    // Claimed off the mint itself: the socket that was already open never reconnected.
    await claimed(endpoint.webhookPathToken);
    expect(relay.io.engine.clientsCount).toBe(1);

    expect(endpoint.webhookUrl).toBe(
      `http://127.0.0.1:${relayPort}/api/triggers/sentry/${endpoint.webhookPathToken}`,
    );
    const [listed] = await listLocalEndpoints(io, owner);
    expect(listed.vendorRef).toBe(`manual:sentry:${endpoint.webhookUrl}`);
    // The secret stays readable every time the card asks for it.
    expect(listed.webhookSecret).toBe(CLIENT_SECRET);

    const test = await sendLocalTestEvent(io, owner, endpoint.id, 'issue_resolved');
    expect(test).toEqual({ success: true, eventType: 'issue_resolved' });
    expect(forwarded).toHaveLength(1);

    const body = JSON.stringify({ action: 'resolved', data: { issue: { id: '5512' } } });
    const delivered = await sentryPost(`http://127.0.0.1:${relayPort}`, endpoint, body);

    expect(delivered.status).toBe(202);
    await vi.waitFor(() => {
      expect(forwarded).toHaveLength(2);
    });
    expect(forwarded[1]).toMatchObject({ integrationId: owner.id, eventType: 'issue_resolved' });
    expect('userId' in forwarded[1]).toBe(false);
    expect(captured).toEqual([]);
  }, 30_000);

  it('takes a Frink-minted generic webhook with no vendor key to import', async () => {
    const owner = await account('generic_webhook');
    const endpoint = await mint(owner);
    const body = JSON.stringify({ order: 'o-1' });

    const delivered = await post(`http://127.0.0.1:${loopback.port}`, endpoint, body, {
      'x-frink-signature': buildGithubSignature(endpoint.webhookSecret, body),
      'x-frink-delivery-id': 'delivery-1',
    });

    expect(delivered.status).toBe(202);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      integrationId: owner.id,
      deliveryId: createHash('sha256').update(body).digest('hex'),
    });
  });

  it('says a vendor-key address needs its key imported before a test event can pass', async () => {
    for (const [provider, name] of [
      ['sentry', 'Sentry'],
      ['square', 'Square'],
    ]) {
      const owner = await account(provider);
      const unimported = await mint(owner);
      expect(await sendLocalTestEvent(io, owner, unimported.id, 'issue_resolved')).toEqual({
        success: false,
        error: `Save ${name}'s signing secret under Advanced first.`,
      });
    }
  });

  it('captures the Notion challenge, confirms it and then accepts signed Notion deliveries', async () => {
    const owner = await account('notion');
    const endpoint = await mint(owner);
    const token = 'notion-verification-token-0001';

    const challenge = await post(
      `http://127.0.0.1:${loopback.port}`,
      endpoint,
      JSON.stringify({ verification_token: token }),
      {},
    );
    expect(challenge.status).toBe(200);
    const [pending] = await listLocalEndpoints(io, owner);
    expect(pending.vendorRef).toMatch(/^notion:pending:/);
    expect(pending.webhookSecret).toBe(token);

    const confirmed = await confirmLocalNotion(
      io,
      owner,
      endpoint.id,
      pending.webhookPathToken,
      pending.vendorRef ?? '',
    );
    expect(confirmed).toEqual({ success: true });

    const body = JSON.stringify({ type: 'page.created', entity: { id: 'page-1' } });
    const delivered = await post(`http://127.0.0.1:${loopback.port}`, endpoint, body, {
      'x-notion-signature': buildGithubSignature(token, body),
    });

    expect(delivered.status).toBe(202);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ integrationId: owner.id, eventType: 'page_created' });
  });

  it('makes the address the hash of the subscribe key and keeps both secrets sealed', async () => {
    const owner = await account();
    const endpoint = await armedEndpoint(owner);

    const row = storedRow(endpoint.id);
    const key = unseal(row.subscribeKeyEncrypted);
    expect(row.pathToken).toBe(createHash('sha256').update(key, 'utf8').digest('hex'));
    expect(row.subscribeKeyEncrypted).not.toContain(key);
    expect(row.signingSecretEncrypted).not.toContain(CLIENT_SECRET);
    expect(unseal(row.signingSecretEncrypted)).toBe(CLIENT_SECRET);
  });

  it('refuses the address past the per-account limit', async () => {
    const owner = await account();
    for (let made = 0; made < ENDPOINT_LIMIT; made += 1) await mint(owner);

    expect(await mintLocalEndpoint(io, owner, ENDPOINT_LIMIT)).toEqual({
      success: false,
      error: 'Webhook endpoint limit reached (3 per integration)',
    });
  });

  it('holds the limit when mints overlap', async () => {
    const owner = await account();
    const minted = await Promise.all(
      Array.from({ length: ENDPOINT_LIMIT + 2 }, () =>
        mintLocalEndpoint(io, owner, ENDPOINT_LIMIT),
      ),
    );

    expect(minted.filter((result) => result.success)).toHaveLength(ENDPOINT_LIMIT);
    expect(await listLocalEndpoints(io, owner)).toHaveLength(ENDPOINT_LIMIT);
  });

  it('serialises overlapping rotations so the stored keys are the ones last handed out', async () => {
    const owner = await account();
    const first = await mint(owner);
    const [earlier, later] = await Promise.all([
      rotateLocalEndpoint(io, owner, first.id),
      rotateLocalEndpoint(io, owner, first.id),
    ]);
    if (!earlier.success || !later.success) throw new Error('a rotation was refused');

    expect(earlier.endpoint.webhookPathToken).not.toBe(later.endpoint.webhookPathToken);
    expect(storedRow(first.id).pathToken).toBe(later.endpoint.webhookPathToken);
  });

  it('refuses a mint that lands after its account was forgotten', async () => {
    const owner = await account();
    await deleteLocalIntegration(db, owner.id);

    expect(await mintLocalEndpoint(io, owner, ENDPOINT_LIMIT)).toEqual({
      success: false,
      error: 'Trigger account not found.',
    });
  });

  it('rotates both keys, so the old address is gone and the new one delivers', async () => {
    const owner = await account();
    const first = await armedEndpoint(owner);
    const rotated = await rotateLocalEndpoint(io, owner, first.id);
    if (!rotated.success) throw new Error(rotated.error);

    expect(rotated.endpoint.webhookPathToken).not.toBe(first.webhookPathToken);
    expect(rotated.endpoint.webhookSecret).not.toBe(CLIENT_SECRET);
    const body = JSON.stringify({ action: 'resolved' });
    const stale = await sentryPost(`http://127.0.0.1:${loopback.port}`, first, body);
    expect(stale.status).toBe(404);
    expect(forwarded).toEqual([]);

    // Rotation drops the imported key with the address it was bound to, so setup runs once more.
    expect((await importLocalVendorSecret(io, owner, first.id, CLIENT_SECRET)).success).toBe(true);
    const fresh = await sentryPost(`http://127.0.0.1:${loopback.port}`, rotated.endpoint, body);

    expect(fresh.status).toBe(202);
    expect(forwarded).toHaveLength(1);
  });

  it('stops delivery on the loopback door and the relay once the address is deactivated', async () => {
    const owner = await account();
    startClient(owner);
    const endpoint = await armedEndpoint(owner);
    await claimed(endpoint.webhookPathToken);

    expect((await deactivateLocalEndpoint(io, owner, endpoint.id)).success).toBe(true);

    const body = JSON.stringify({ action: 'resolved' });
    expect((await sentryPost(`http://127.0.0.1:${loopback.port}`, endpoint, body)).status).toBe(
      404,
    );
    // The relay still answers the sender; this machine is what stops acting on the delivery.
    expect((await sentryPost(`http://127.0.0.1:${relayPort}`, endpoint, body)).status).toBe(202);
    await vi.waitFor(() => {
      expect(endpointRow(db, endpoint.id)?.isActive).toBe(false);
    });
    expect(forwarded).toEqual([]);
  }, 30_000);

  it('refuses an address for a class this machine does not serve', async () => {
    for (const provider of ['webflow', 'atlassian']) {
      const owner = { id: await insertIntegration(db, { provider }), provider };
      const name = getProviderById(provider)?.display_name;

      expect(await mintLocalEndpoint(io, owner, ENDPOINT_LIMIT)).toEqual({
        success: false,
        error: `Frink can't make a ${name} address on this machine yet.`,
      });
      expect(await listLocalEndpoints(io, owner)).toEqual([]);
    }
  });

  it('serves exactly the available paste_url providers that name a signature scheme', () => {
    expect(
      PROVIDERS.filter(mintsLocally)
        .map((p) => p.id)
        .sort(),
    ).toEqual(['generic_webhook', 'linear', 'notion', 'sentry', 'shortcut', 'square', 'vercel']);
    // A launch flag that is not on hides the provider's minting too, so the card and the class agree.
    const shortcut = getProviderById('shortcut');
    // SAFETY: 'retired' is deliberately not a LAUNCH_FLAGS key; every real flag is on today.
    expect(shortcut && mintsLocally({ ...shortcut, enabled_when: ['retired' as never] })).toBe(
      false,
    );
  });
});
