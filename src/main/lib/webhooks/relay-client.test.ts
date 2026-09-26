import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import log from 'electron-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRelay, type Relay } from '../../../../relay/src/index';
import { WEBHOOK_BODY_MAX_BYTES } from '../../../shared/webhooks/content-limits';
import { buildGithubSignature } from '../../../shared/webhooks/github-hmac';
import type { WebhookReceiverDeps } from '../../../shared/webhooks/receiver';
import * as database from '../db';
import { insertIntegration, insertWebhookEndpoint } from '../db/repos/webhook-ingress';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import { ingressBaseUrl, loadRelayMoveRecord, mintedAgainstBaseUrl } from './base-url';
import { createLocalWebhookDeps, listSubscribeKeys } from './deps';
import type { LocalEndpointIo } from './local-endpoints';
import * as localRegistrars from './local-registrars';
import {
  remintIfRelayMoved,
  startWebhookIngress,
  startWebhookRelayClient,
  triggerRelayStatus,
} from './index';
import { type RelayClient, startRelayClient } from './relay-client';
import { endpointRow, seal, sealedWebhookIo } from './test-utils';

type ForwardedWebhookEvent = Parameters<WebhookReceiverDeps['forwardWebhookEvent']>[0];
type Endpoint = { id: string; key: string; address: string; secret: string };

const PROVIDER = 'generic_webhook';
const OVER_HEADER_LIMIT = 65;
const MOVED_RELAY = 'https://moved.example.com';

let relay: Relay;
let port: number;
let db: TestDb;
let io: LocalEndpointIo;
let claims: number;
let mintedKeys: number;
let deps: WebhookReceiverDeps;
let forwarded: ForwardedWebhookEvent[];
let captured: unknown[];
let lookups: number;
/** A rig-owned home, so a move record never writes the operator's own `~/.frink`. */
let home: string;
const clients: RelayClient[] = [];

function hex32(): string {
  return randomBytes(32).toString('hex');
}

function addressOf(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

function listen(server: Server, on: number): Promise<number> {
  return new Promise((resolve) => {
    server.listen(on, () => {
      const address = server.address();
      if (!(address instanceof Object)) throw new Error('the server bound no TCP port');
      resolve(address.port);
    });
  });
}

async function seedEndpoint(integrationId: string, vendorRef?: string): Promise<Endpoint> {
  const key = hex32();
  const secret = hex32();
  const address = addressOf(key);
  const id = await insertWebhookEndpoint(db, {
    integrationId,
    provider: PROVIDER,
    pathToken: address,
    subscribeKeyEncrypted: seal(key),
    signingSecretEncrypted: seal(secret),
    vendorRef,
  });
  return { id, key, address, secret };
}

function startClient(): RelayClient | null {
  const client = startRelayClient({ subscribeKeys: () => listSubscribeKeys(io), deps });
  if (client) clients.push(client);
  return client;
}

/** A boot leaves its relay leg in module state; configured local-only, starting closes it. */
function stopModuleRelayClient(): void {
  vi.stubEnv('FRINK_WEBHOOK_BASE_URL', '');
  startWebhookRelayClient(io);
}

function claimed(address: string): Promise<void> {
  return vi.waitFor(
    () => {
      expect(relay.io.sockets.adapter.rooms.has(address)).toBe(true);
    },
    { timeout: 10_000 },
  );
}

function post(address: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${port}/api/triggers/${PROVIDER}/${address}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-frink-delivery-id': 'delivery-1',
      ...headers,
    },
    body,
  });
}

function signedPost(endpoint: Endpoint, body: string) {
  return post(endpoint.address, body, {
    'x-frink-signature': buildGithubSignature(endpoint.secret, body),
  });
}

beforeEach(async () => {
  relay = createRelay();
  port = await listen(relay.httpServer, 0);
  vi.stubEnv('FRINK_WEBHOOK_BASE_URL', `http://127.0.0.1:${port}`);
  home = mkdtempSync(join(tmpdir(), 'frink-relay-'));
  vi.stubEnv('FRINK_HOME', home);
  await loadRelayMoveRecord();
  db = freshDb();
  forwarded = [];
  captured = [];
  lookups = 0;
  claims = 0;
  mintedKeys = 0;
  io = {
    ...sealedWebhookIo(
      db,
      async (event) => {
        forwarded.push(event);
      },
      (cause) => captured.push(cause),
    ),
    // Two keys are sealed per address minted, which is what a re-mint costs the user in re-pastes.
    encryptSecret: (plaintext) => {
      mintedKeys += 1;
      return seal(plaintext);
    },
    // A move restarts the relay client, which claims every address again on connect.
    claimAddresses: () => {
      claims += 1;
    },
  };
  const base = createLocalWebhookDeps(io);
  deps = {
    ...base,
    getWebhookEndpointByPathToken: (pathToken, provider) => {
      lookups += 1;
      return base.getWebhookEndpointByPathToken(pathToken, provider);
    },
  };
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await relay.close();
  db.$client.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe('relay webhook ingress', () => {
  it('turns a signed delivery through the relay into a flow-start event', async () => {
    const integrationId = await insertIntegration(db, {
      provider: PROVIDER,
      externalUserId: 'owner-1',
    });
    const endpoint = await seedEndpoint(integrationId);
    startClient();
    await claimed(endpoint.address);

    const body = JSON.stringify({ order: 'o-1' });

    const response = await signedPost(endpoint, body);

    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(forwarded).toHaveLength(1);
    });
    const event = forwarded[0];
    // The parts `handleVerifiedWebhookEvent` builds the idempotency key from, and the key it
    // must not carry: a machine with nobody signed in names no user.
    expect(event.integrationId).toBe(integrationId);
    expect(event.eventType).toBe('received');
    expect(event.deliveryId).toBe(createHash('sha256').update(body).digest('hex'));
    expect('userId' in event).toBe(false);
    expect(event.rawPayload).toEqual({ order: 'o-1' });
    expect(endpointRow(db, endpoint.id)?.lastReceivedAt).toBeInstanceOf(Date);
    expect(captured).toEqual([]);
  });

  it('starts nothing for a body whose signature does not verify, and says so on the endpoint', async () => {
    const integrationId = await insertIntegration(db, { provider: PROVIDER });
    const endpoint = await seedEndpoint(integrationId);
    startClient();
    await claimed(endpoint.address);
    const body = JSON.stringify({ order: 'o-1' });

    const response = await post(endpoint.address, body, {
      'x-frink-signature': buildGithubSignature(hex32(), body),
    });

    // The relay answered before any verdict existed; the refusal shows up only on the row.
    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(endpointRow(db, endpoint.id)?.lastError).toBe(
        'Invalid webhook signature - secret mismatch',
      );
    });
    expect(forwarded).toEqual([]);
  });

  it('claims one address per endpoint, and each takes only its own deliveries', async () => {
    const integrationId = await insertIntegration(db, { provider: PROVIDER });
    const first = await seedEndpoint(integrationId);
    const second = await seedEndpoint(integrationId);
    startClient();
    await claimed(first.address);
    await claimed(second.address);

    await signedPost(first, JSON.stringify({ to: 'first' }));

    await vi.waitFor(() => {
      expect(forwarded).toHaveLength(1);
    });
    expect(forwarded[0].rawPayload).toEqual({ to: 'first' });
    expect(endpointRow(db, first.id)?.lastReceivedAt).toBeInstanceOf(Date);
    expect(endpointRow(db, second.id)?.lastReceivedAt).toBeNull();
  });

  it('claims its addresses again after the relay restarts, and the next delivery still fires', async () => {
    const integrationId = await insertIntegration(db, { provider: PROVIDER });
    const endpoint = await seedEndpoint(integrationId);
    startClient();
    await claimed(endpoint.address);

    await relay.close();
    relay = createRelay();
    await listen(relay.httpServer, port);
    await claimed(endpoint.address);

    await signedPost(endpoint, JSON.stringify({ after: 'restart' }));

    await vi.waitFor(() => {
      expect(forwarded).toHaveLength(1);
    });
    expect(forwarded[0].rawPayload).toEqual({ after: 'restart' });
  }, 30_000);

  it('drops a malformed frame without looking any endpoint up', async () => {
    const integrationId = await insertIntegration(db, { provider: PROVIDER });
    const endpoint = await seedEndpoint(integrationId);
    const client = startClient();
    await claimed(endpoint.address);
    const bodyB64 = Buffer.from('{}').toString('base64');
    const malformed = [
      { t: 'not-hex', provider: PROVIDER, headers: {}, bodyB64 },
      {
        t: endpoint.address,
        provider: PROVIDER,
        headers: {},
        bodyB64: Buffer.alloc(WEBHOOK_BODY_MAX_BYTES + 1).toString('base64'),
      },
      {
        t: endpoint.address,
        provider: PROVIDER,
        headers: Object.fromEntries(
          Array.from({ length: OVER_HEADER_LIMIT }, (_, index) => [`h${index}`, 'v']),
        ),
        bodyB64,
      },
    ];

    for (const frame of malformed) relay.io.to(endpoint.address).emit('inbound', frame);

    await vi.waitFor(() => {
      expect(client?.droppedFrames()).toBe(malformed.length);
    });
    expect(lookups).toBe(0);
    expect(forwarded).toEqual([]);
  });

  it('keeps a delivery whose headers repeat a name, as the loopback door does', async () => {
    const integrationId = await insertIntegration(db, { provider: PROVIDER });
    const endpoint = await seedEndpoint(integrationId);
    const client = startClient();
    await claimed(endpoint.address);
    const body = JSON.stringify({ order: 'o-2' });

    relay.io.to(endpoint.address).emit('inbound', {
      t: endpoint.address,
      provider: PROVIDER,
      headers: {
        'x-frink-signature': buildGithubSignature(endpoint.secret, body),
        'x-frink-delivery-id': 'delivery-2',
        'set-cookie': ['first=1', 'second=2'],
      },
      bodyB64: Buffer.from(body).toString('base64'),
    });

    await vi.waitFor(() => {
      expect(forwarded).toHaveLength(1);
    });
    expect(client?.droppedFrames()).toBe(0);
  });

  it('calls the relay unreachable once a connection it had is gone, and not before', async () => {
    const integrationId = await insertIntegration(db, { provider: PROVIDER });
    const endpoint = await seedEndpoint(integrationId);
    const client = startClient();
    await claimed(endpoint.address);
    expect(client?.reachable()).toBe(true);

    await relay.close();

    await vi.waitFor(() => {
      expect(client?.reachable()).toBe(false);
    });
    // The rig closes `relay` again after each case; hand it one that is still open.
    relay = createRelay();
    await listen(relay.httpServer, 0);
  }, 30_000);

  it('leaves a tunnel that never speaks socket.io reachable, since it forwards to the local door', async () => {
    let handshakes = 0;
    const tunnel = createServer();
    tunnel.on('upgrade', (_request, socket) => {
      handshakes += 1;
      socket.destroy();
    });
    const tunnelPort = await listen(tunnel, 0);
    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', `http://127.0.0.1:${tunnelPort}`);

    const client = startClient();

    // A bring-your-own tunnel answers deliveries and never completes a claim, so a card that read
    // a failed handshake as "down" would carry a permanent false warning on a working setup.
    await vi.waitFor(() => {
      expect(handshakes).toBeGreaterThan(0);
    });
    expect(client?.reachable()).toBe(true);
    tunnel.close();
  });

  it('re-mints every address when a boot resolves a relay the rows were not minted against', async () => {
    const integrationId = await insertIntegration(db, { provider: PROVIDER });
    const endpoint = await seedEndpoint(integrationId);

    await remintIfRelayMoved(io);
    const onFirst = endpointRow(db, endpoint.id)?.pathToken;
    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', MOVED_RELAY);
    await remintIfRelayMoved(io);
    const onMoved = endpointRow(db, endpoint.id)?.pathToken;
    // The move record is read back from disk, as the next boot reads it.
    await loadRelayMoveRecord();
    await remintIfRelayMoved(io);

    expect(onFirst).not.toBe(endpoint.address);
    expect(onMoved).not.toBe(onFirst);
    expect(mintedAgainstBaseUrl()).toBe(MOVED_RELAY);
    // A boot on the base the rows already hang off must not cost the user a re-paste.
    expect(endpointRow(db, endpoint.id)?.pathToken).toBe(onMoved);
  });

  it('never re-mints on a refused or absent base, only once a real one resolves again', async () => {
    const integrationId = await insertIntegration(db, { provider: PROVIDER });
    const endpoint = await seedEndpoint(integrationId);
    const BASE_A = 'https://base-a.example.com';
    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', BASE_A);
    await remintIfRelayMoved(io);
    const onA = endpointRow(db, endpoint.id)?.pathToken;
    expect(mintedAgainstBaseUrl()).toBe(BASE_A);
    mintedKeys = 0;

    // Plaintext to a host that is not this machine is refused, so ingressBaseUrl() is null.
    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', 'http://not-loopback.example.com');
    await remintIfRelayMoved(io);

    expect(ingressBaseUrl()).toBeNull();
    expect(mintedKeys).toBe(0);
    expect(endpointRow(db, endpoint.id)?.pathToken).toBe(onA);
    expect(mintedAgainstBaseUrl()).toBe(BASE_A);

    const BASE_B = 'https://base-b.example.com';
    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', BASE_B);
    await remintIfRelayMoved(io);

    expect(endpointRow(db, endpoint.id)?.pathToken).not.toBe(onA);
    expect(mintedAgainstBaseUrl()).toBe(BASE_B);
  });

  it('opens the loopback door before the move, so a move that throws leaves one answering', async () => {
    // The door's io is built first, so the move's read of the database is the one that fails here,
    // as a vendor refusal or an unwritable home would once the move is under way.
    vi.spyOn(database, 'getDatabase')
      .mockReturnValueOnce(db)
      .mockImplementation(() => {
        throw new Error('the move could not read the database');
      });

    const bound = await startWebhookIngress();

    // Awaiting the move first cost the session its front door for good — boot's step swallowed the
    // throw and nothing listened until a restart — and every later boot repeated the whole move.
    const response = await fetch(
      `http://127.0.0.1:${bound}/api/triggers/${PROVIDER}/${addressOf(hex32())}`,
      { method: 'POST', body: '{}' },
    );
    expect(response.status).toBe(404);
  });

  it('names a refused address at boot, and says nothing about one it can use', async () => {
    vi.spyOn(database, 'getDatabase').mockReturnValue(db);
    const warn = vi.spyOn(log, 'warn');
    const refusals = () =>
      warn.mock.calls.filter(([message]) => String(message).includes('FRINK_WEBHOOK_BASE_URL'));

    await startWebhookIngress();
    await remintIfRelayMoved(io);

    expect(refusals()).toEqual([]);

    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', 'http://relay.example.com');
    await startWebhookIngress();

    // Nothing in the app asks for an address now, so a refused variable left unsaid reads as a
    // machine that simply cannot receive events, with nowhere to find out why.
    expect(refusals()).toEqual([[expect.any(String), { value: 'http://relay.example.com' }]]);
  });

  it('answers on its door while the move is still under way, and claims once the move lands', async () => {
    vi.spyOn(database, 'getDatabase').mockReturnValue(db);
    let land: () => void = () => {};
    const move = vi.spyOn(localRegistrars, 'remintForRelayMove').mockReturnValue(
      new Promise((resolve) => {
        land = () => resolve([]);
      }),
    );
    const client = startWebhookRelayClient(io);
    if (!client) throw new Error('the rig configured no relay address');
    const refresh = vi.spyOn(client, 'refresh');

    const bound = await startWebhookIngress();

    // A move talks to every vendor in turn, so boot waiting on one holds first paint for as long
    // as they take — and nothing on this machine answers until they are done.
    await vi.waitFor(() => expect(move).toHaveBeenCalled());
    expect(refresh).not.toHaveBeenCalled();
    const answered = await fetch(
      `http://127.0.0.1:${bound}/api/triggers/${PROVIDER}/${addressOf(hex32())}`,
      { method: 'POST', body: '{}' },
    );
    expect(answered.status).toBe(404);

    land();
    // The relay is holding the keys the move replaced until it is handed the new ones.
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    stopModuleRelayClient();
  });

  it('reports nothing lost while no relay client is running at all', () => {
    stopModuleRelayClient();

    // There is none between boot's door and the relay client's start. "Frink lost its connection"
    // there names a loss that never happened.
    expect(triggerRelayStatus()).toMatchObject({ reachable: true });
  });

  it('never connects when configured local-only', async () => {
    const integrationId = await insertIntegration(db, { provider: PROVIDER });
    const endpoint = await seedEndpoint(integrationId);
    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', '');

    const client = startClient();

    expect(client).toBeNull();
    expect(relay.io.engine.clientsCount).toBe(0);
    expect(relay.io.sockets.adapter.rooms.has(endpoint.address)).toBe(false);
  });
});
