/** The launch gate of docs/decisions/public-private-repo-split.md over the webhook boot path: with
 * no Frink host, a signed generic_webhook delivery still becomes a Flow run. */

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { Server, Socket } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRelay, type Relay } from '../../../../relay/src/index';
import { buildGithubSignature } from '../../../shared/webhooks/github-hmac';
import * as tokenCrypto from '../credentials/token-crypto';
import * as database from '../db';
import { createFlowVersion } from '../db/repos/flow-versions';
import { createFlow } from '../db/repos/flows';
import { flowRuns } from '../db/schema';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import { localIngressBaseUrl } from './base-url';
import {
  createLocalTriggerAccount,
  localEndpointIo,
  type LocalEndpointView,
  mintLocalEndpoint,
  startWebhookIngress,
  startWebhookRelayClient,
  WEBHOOK_ENDPOINT_LIMIT,
} from './index';
import type { RelayClient } from './relay-client';
import { seal, unseal } from './test-utils';

const PROVIDER = 'generic_webhook';
const DELIVERY_ID = 'delivery-1';

let db: TestDb;
let port: number;
/** What the boot itself did, recorded while it ran rather than inferred from a return value: the
 * hosts it bound, and every outbound request or socket it opened — one number, which must be zero. */
let bootBindHosts: unknown[];
let bootOutboundCount: number;
let relay: Relay | null = null;
let relayClient: RelayClient | null = null;

/** A trigger account, its minted address and a Flow bound to it — all of it built the way the app
 * builds it with nobody signed in, so no row here could have come from a Frink account. */
async function boundFlow(): Promise<{ versionId: string; endpoint: LocalEndpointView }> {
  const io = localEndpointIo();
  const integrationId = await createLocalTriggerAccount(io, PROVIDER);
  const minted = await mintLocalEndpoint(
    io,
    { id: integrationId, provider: PROVIDER },
    WEBHOOK_ENDPOINT_LIMIT,
  );
  if (!minted.success) throw new Error(minted.error);
  const flow = await createFlow(db, { name: 'Gate', description: null, projectId: null });
  const version = await createFlowVersion(db, {
    flowId: flow.id,
    graph: {
      nodes: [
        {
          id: 'trigger',
          blockType: 'webhook_trigger',
          config: { integrationId, eventType: 'received', conditions: {} },
        },
      ],
      edges: [],
    },
  });
  return { versionId: version.id, endpoint: minted.endpoint };
}

/** Deliveries go to the address the app minted, which is the only one a user is ever handed. */
function post(url: string, body: string, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-frink-delivery-id': DELIVERY_ID, ...headers },
    body,
  });
}

function signedPost(endpoint: LocalEndpointView, body: string) {
  return post(endpoint.webhookUrl, body, {
    'x-frink-signature': buildGithubSignature(endpoint.webhookSecret, body),
  });
}

function runsOf(versionId: string) {
  return db.select().from(flowRuns).where(eq(flowRuns.flowVersionId, versionId)).all();
}

function bodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

async function startRelayOnEphemeralPort(): Promise<number> {
  relay = createRelay();
  relay.httpServer.listen(0);
  await once(relay.httpServer, 'listening');
  const bound = relay.httpServer.address();
  return bound instanceof Object ? bound.port : 0;
}

beforeAll(async () => {
  // Configured local-only, in any build: the blank webhook base — not the build mode — is what keeps
  // the ingress off Frink's relay.
  vi.stubEnv('MODE', 'production');
  vi.stubEnv('DEV', false);
  vi.stubEnv('FRINK_WEBHOOK_BASE_URL', '');
  db = freshDb();
  // getDatabase() opens the operator's own agents.db — initDatabase refuses to under Vitest for
  // that reason — and safeStorage is an Electron host API no test process has.
  vi.spyOn(database, 'getDatabase').mockReturnValue(db);
  vi.spyOn(tokenCrypto, 'encryptToken').mockImplementation(seal);
  vi.spyOn(tokenCrypto, 'decryptToken').mockImplementation((sealed) =>
    sealed ? unseal(sealed) : null,
  );
  // Node's own boundaries: `fetch` covers an HTTP call to a host, `connect` a raw socket to one.
  const binds = vi.spyOn(Server.prototype, 'listen');
  const dials = vi.spyOn(Socket.prototype, 'connect');
  const requests = vi.spyOn(globalThis, 'fetch');

  // The boot step itself (flows/startup/index.ts:119-127), not a listener a test wired up by hand.
  port = await startWebhookIngress();

  bootBindHosts = binds.mock.calls.map(([, host]) => host);
  bootOutboundCount = dials.mock.calls.length + requests.mock.calls.length;
});

afterAll(async () => {
  relayClient?.close();
  await relay?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  db.$client.close();
});

describe('open-source launch gate', () => {
  it('serves the tokenized address on 127.0.0.1 and starts the Flow a signed delivery matches', async () => {
    const { versionId, endpoint } = await boundFlow();
    expect(endpoint.webhookUrl).toBe(
      `http://127.0.0.1:${port}/api/triggers/${PROVIDER}/${endpoint.webhookPathToken}`,
    );
    const body = JSON.stringify({ order: 'o-1' });

    const response = await signedPost(endpoint, body);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: 'relayed', eventType: 'received' });
    const runs = runsOf(versionId);
    expect(runs).toHaveLength(1);
    // The run reached its terminal state, so a Flow that never dispatched cannot pass as started.
    expect(runs[0].status).toBe('completed');
    expect(runs[0].triggerContext).toMatchObject({
      _frinkTrigger: 'webhook_trigger',
      deliveryId: bodyHash(body),
      fullContent: { order: 'o-1' },
    });
  });

  it('starts nothing for a delivery that is unsigned or signed with another secret', async () => {
    const { versionId, endpoint } = await boundFlow();
    const body = JSON.stringify({ order: 'o-2' });

    const unsigned = await post(endpoint.webhookUrl, body);
    const wrongSecret = await post(endpoint.webhookUrl, body, {
      'x-frink-signature': buildGithubSignature('f'.repeat(64), body),
    });

    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toEqual({ error: 'Signature required' });
    expect(wrongSecret.status).toBe(401);
    expect(await wrongSecret.json()).toEqual({ error: 'Invalid signature' });
    expect(runsOf(versionId)).toEqual([]);
  });

  it("names no relay when configured local-only, opening only this machine's own door", async () => {
    expect(startWebhookRelayClient()).toBeNull();

    const { endpoint } = await boundFlow();

    expect([...new Set(bootBindHosts)]).toEqual(['127.0.0.1']);
    expect(bootOutboundCount).toBe(0);
    expect(localIngressBaseUrl()).toBe(`http://127.0.0.1:${port}`);
    expect(endpoint.webhookUrl.startsWith(`http://127.0.0.1:${port}/`)).toBe(true);
  });

  it('starts one run for one signed body, however many delivery ids it is replayed under', async () => {
    const { versionId, endpoint } = await boundFlow();
    const body = JSON.stringify({ order: 'o-4' });
    const signature = buildGithubSignature(endpoint.webhookSecret, body);

    const replays = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      replays.push(
        await post(endpoint.webhookUrl, body, {
          'x-frink-signature': signature,
          'x-frink-delivery-id': `r-${attempt}`,
        }),
      );
    }

    // Every replay is acked, so a relay learns nothing from the answer; only the first became a run.
    expect(replays.map((replay) => replay.status)).toEqual(Array(10).fill(202));
    expect(runsOf(versionId)).toHaveLength(1);
  });

  it('starts a run per distinct signed body, even under one repeated delivery id', async () => {
    const { versionId, endpoint } = await boundFlow();

    await signedPost(endpoint, JSON.stringify({ order: 'o-5' }));
    await signedPost(endpoint, JSON.stringify({ order: 'o-6' }));

    expect(runsOf(versionId)).toHaveLength(2);
  });

  it("starts the Flow through this repo's own relay when one is named", async () => {
    const relayPort = await startRelayOnEphemeralPort();
    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', `http://127.0.0.1:${relayPort}`);
    relayClient = startWebhookRelayClient();
    const { versionId, endpoint } = await boundFlow();
    expect(endpoint.webhookUrl).toBe(
      `http://127.0.0.1:${relayPort}/api/triggers/${PROVIDER}/${endpoint.webhookPathToken}`,
    );
    await vi.waitFor(() => {
      expect(relay?.io.sockets.adapter.rooms.has(endpoint.webhookPathToken)).toBe(true);
    });

    const response = await signedPost(endpoint, JSON.stringify({ order: 'o-3' }));

    // The relay answers before any verdict exists; the run is the only proof the delivery landed.
    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(runsOf(versionId).map((run) => run.status)).toEqual(['completed']);
    });
  });
});
