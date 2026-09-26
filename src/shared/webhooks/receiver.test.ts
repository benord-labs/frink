import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRIGGER_SAMPLES } from '../integrations/trigger-samples';
import { standardWebhooksSecret } from '../integrations/webhook-secret';
import { jsonObject } from './extractors/generic';
import type { WebhookHeaders } from './extractors/types';
import { WEBHOOK_BODY_MAX_BYTES } from './content-limits';
import { receiveWebhook, type WebhookReceiverDeps } from './receiver';

type EndpointLookup = NonNullable<
  Awaited<ReturnType<WebhookReceiverDeps['getWebhookEndpointByPathToken']>>
>;

/** The row as the host stores it: what the receiver reads, plus the stamps it must leave alone. */
type EndpointRow = EndpointLookup & {
  endpoint: { provider: string; last_received_at: string | null; last_error: string | null };
};

/** The calls the receiver reaches for, as typed fakes the extractor still runs beside. */
const deps = {
  getWebhookEndpointByPathToken: vi.fn<WebhookReceiverDeps['getWebhookEndpointByPathToken']>(),
  markIntegrationWebhookError: vi.fn<WebhookReceiverDeps['markIntegrationWebhookError']>(),
  markIntegrationWebhookReceived: vi.fn<WebhookReceiverDeps['markIntegrationWebhookReceived']>(),
  forwardWebhookEvent: vi.fn<WebhookReceiverDeps['forwardWebhookEvent']>(),
  captureNotionChallenge: vi.fn<WebhookReceiverDeps['captureNotionChallenge']>(),
  captureException: vi.fn<WebhookReceiverDeps['captureException']>(),
};

const SECRET = 'endpoint-secret';
/** What the cloud mints for every endpoint: 32 random bytes as hex. */
const HEX_SECRET = crypto.randomBytes(32).toString('hex');
const AT = '2026-09-07T00:00:00.000Z';

const EVENT_DATA = {
  type: 'invoice.paid',
  eventType: 'received',
  provider: 'generic_webhook',
  externalUserId: '',
};

const NOT_FOUND = {
  status: 'ignored',
  reason: 'webhook_not_found_or_inactive',
};

function makeRes() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { status, json };
}

function call(req: Parameters<typeof receiveWebhook>[0], res: ReturnType<typeof makeRes>) {
  return receiveWebhook(req, res, deps);
}

function sign(secret: string, rawBody: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/**
 * Signs the way a PostHog destination does with the secret pasted from the card: base64-decode
 * the `whsec_` value and HMAC `${id}.${timestamp}.${body}` (Standard Webhooks).
 */
function standardWebhooksHeaders(pastedSecret: string, rawBody: string, id = 'msg_1') {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(pastedSecret.slice('whsec_'.length), 'base64');
  const digest = crypto
    .createHmac('sha256', key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64');
  return {
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${digest}`,
  };
}

function makeEndpoint(
  externalUserId: string | null = 'owner-1',
  provider = 'generic_webhook',
  secret = SECRET,
): EndpointRow {
  return {
    user: { id: 'user-1' },
    integration: {
      id: 'integration-1',
      external_user_id: externalUserId,
    },
    endpoint: {
      id: 'endpoint-1',
      provider,
      webhook_path_token: 'token-1',
      webhook_secret: secret,
      last_received_at: null,
      last_error: null,
    },
  };
}

/** The production-shape fixture the extractor parity gate pins, as the raw bytes PostHog signs. */
const POSTHOG_EVENT_RAW = readFileSync(
  path.join(__dirname, 'extractors/__fixtures__/posthog/event.json'),
  'utf8',
);
const POSTHOG_EVENT = jsonObject.parse(JSON.parse(POSTHOG_EVENT_RAW));

/** PostHog's default HTTP Webhook body: `{ event: {event}, person: {person} }`. */
const POSTHOG_BODY = {
  event: {
    uuid: 'evt-uuid-1',
    event: 'checkout_completed',
    distinct_id: 'user-42',
    properties: { plan: 'pro' },
    timestamp: '2026-09-07T10:00:00.000Z',
  },
  person: { id: 'person-1', properties: { email: 'a@b.c' } },
};

type ReqOptions = {
  method?: string;
  rawBody?: string;
  provider?: string;
  token?: string | string[];
  signature?: string | null; // null = omit the X-Frink-Signature header
  headers?: WebhookHeaders;
};

function makeReq(opts: ReqOptions = {}) {
  const rawBody = opts.rawBody ?? JSON.stringify({ type: 'invoice.paid' });
  const headers = { ...opts.headers };
  if (opts.signature !== null) {
    headers['x-frink-signature'] = opts.signature ?? sign(SECRET, rawBody);
  }
  return {
    method: opts.method ?? 'POST',
    query: {
      provider: opts.provider ?? 'generic_webhook',
      id: opts.token ?? 'token-1',
    },
    headers,
    rawBody,
  };
}

/** A signed PostHog request over `rawBody`, addressed to the posthog route. */
function makePosthogReq(rawBody: string, pastedSecret = standardWebhooksSecret(HEX_SECRET)) {
  return makeReq({
    provider: 'posthog',
    rawBody,
    signature: null,
    headers: standardWebhooksHeaders(pastedSecret, rawBody),
  });
}

describe('paste_url webhook handler — forward to machine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deps.getWebhookEndpointByPathToken.mockResolvedValue(makeEndpoint());
  });

  it('returns 401 and forwards nothing for a row whose spec names no signature scheme', async () => {
    deps.getWebhookEndpointByPathToken.mockResolvedValue(makeEndpoint(null, 'webflow'));
    const rawBody = JSON.stringify({
      triggerType: 'collection_item_changed',
      payload: { id: 'same-item' },
    });
    const res = makeRes();
    await call(makeReq({ provider: 'webflow', rawBody, signature: null }), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Signature required' });
    expect(deps.markIntegrationWebhookError).toHaveBeenCalledWith(
      'endpoint-1',
      'Missing required webhook signature',
      undefined,
    );
    expect(deps.markIntegrationWebhookReceived).not.toHaveBeenCalled();
    expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
  });

  it('rejects non-POST methods with 405', async () => {
    const res = makeRes();
    await call(makeReq({ method: 'GET' }), res);
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({ error: 'Method not allowed' });
  });

  it('looks the token up under the provider the path names', async () => {
    await call(makeReq(), makeRes());
    expect(deps.getWebhookEndpointByPathToken).toHaveBeenCalledWith('token-1', 'generic_webhook');
  });

  it('returns 404 when the path segments are not both single strings', async () => {
    const res = makeRes();
    await call(makeReq({ token: ['token-1', 'token-2'] }), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(NOT_FOUND);
    expect(deps.getWebhookEndpointByPathToken).not.toHaveBeenCalled();
  });

  it('returns 413 when the raw body exceeds WEBHOOK_BODY_MAX_BYTES', async () => {
    const rawBody = 'x'.repeat(WEBHOOK_BODY_MAX_BYTES + 1);
    const res = makeRes();
    await call(makeReq({ rawBody }), res);
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({ error: 'Payload too large' });
    expect(deps.getWebhookEndpointByPathToken).not.toHaveBeenCalled();
  });

  it('returns 404 when no active endpoint of that provider carries the token', async () => {
    deps.getWebhookEndpointByPathToken.mockResolvedValue(null);
    const res = makeRes();
    await call(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(NOT_FOUND);
    expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
  });

  it('returns 404 without a lookup when the path names a provider a curated receiver owns', async () => {
    const res = makeRes();
    await call(makeReq({ provider: 'github' }), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(NOT_FOUND);
    expect(deps.getWebhookEndpointByPathToken).not.toHaveBeenCalled();
    expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
  });

  it('returns 401 when a signature is present but invalid (no fall-through)', async () => {
    const res = makeRes();
    await call(makeReq({ signature: 'sha256=deadbeef' }), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid signature' });
    expect(deps.markIntegrationWebhookError).toHaveBeenCalledWith(
      'endpoint-1',
      'Invalid webhook signature - secret mismatch',
      undefined,
    );
    expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
  });

  it('returns 401 when the signature is absent (signed-only, no unsigned opt-out)', async () => {
    const res = makeRes();
    await call(makeReq({ signature: null }), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Signature required' });
    expect(deps.markIntegrationWebhookError).toHaveBeenCalledWith(
      'endpoint-1',
      'Missing required webhook signature',
      undefined,
    );
    expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
  });

  it('returns 400 when the body is valid JSON but an array', async () => {
    const rawBody = JSON.stringify([1, 2, 3]);
    const res = makeRes();
    await call(makeReq({ rawBody, signature: sign(SECRET, rawBody) }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Body must be a JSON object',
    });
    expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-JSON body', async () => {
    const rawBody = '{ not json';
    const res = makeRes();
    await call(makeReq({ rawBody, signature: sign(SECRET, rawBody) }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid JSON payload' });
    expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
  });

  it('forwards the normalized event to the machine and returns 202 for a valid signature', async () => {
    const rawBody = JSON.stringify({ type: 'invoice.paid' });
    const res = makeRes();
    await call(makeReq({ rawBody }), res);

    expect(deps.markIntegrationWebhookReceived).toHaveBeenCalledWith('endpoint-1', undefined, true);
    expect(deps.forwardWebhookEvent).toHaveBeenCalledTimes(1);
    expect(deps.forwardWebhookEvent).toHaveBeenCalledWith({
      userId: 'user-1',
      integrationId: 'integration-1',
      eventType: 'received',
      eventData: EVENT_DATA,
      ownerExternalId: 'owner-1',
      deliveryId: crypto.createHash('sha256').update(rawBody).digest('hex'),
      rawPayload: { type: 'invoice.paid' },
    });
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({
      status: 'relayed',
      eventType: 'received',
    });
  });

  it('forwards ownerExternalId null when the integration has no external_user_id', async () => {
    deps.getWebhookEndpointByPathToken.mockResolvedValue(makeEndpoint(null));
    await call(makeReq(), makeRes());
    expect(deps.forwardWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ ownerExternalId: null }),
    );
  });

  it('forwards no userId key at all when the lookup names no user', async () => {
    const { user, ...ownerless } = makeEndpoint();
    expect(user).toBeDefined();
    deps.getWebhookEndpointByPathToken.mockResolvedValue(ownerless);
    const res = makeRes();
    await call(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(deps.forwardWebhookEvent).toHaveBeenCalledOnce();
    expect(deps.forwardWebhookEvent.mock.calls[0]?.[0]).not.toHaveProperty('userId');
  });

  it('hashes the signed body for the deliveryId, whatever delivery id the sender claims', async () => {
    const rawBody = JSON.stringify({ type: 'invoice.paid', n: 1 });
    const signature = sign(SECRET, rawBody);
    for (const claimed of ['r-1', 'r-2']) {
      await call(
        makeReq({ rawBody, signature, headers: { 'x-frink-delivery-id': claimed } }),
        makeRes(),
      );
    }
    const hash = crypto.createHash('sha256').update(rawBody).digest('hex');
    expect(deps.forwardWebhookEvent.mock.calls.map(([event]) => event.deliveryId)).toEqual([
      hash,
      hash,
    ]);
  });

  it("takes an in-process caller's own delivery id, which no header can reach", async () => {
    await call(
      {
        ...makeReq({ headers: { 'x-frink-delivery-id': 'from-the-wire' } }),
        deliveryId: 'sample-1',
      },
      makeRes(),
    );
    expect(deps.forwardWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: 'sample-1' }),
    );
  });
});

describe('paste_url webhook handler — a data-driven vendor row (PostHog)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deps.getWebhookEndpointByPathToken.mockResolvedValue(makeEndpoint(null, 'posthog', HEX_SECRET));
  });

  it('relays the production-shape fixture when PostHog signs it with the secret the card shows', async () => {
    const res = makeRes();
    await call(makePosthogReq(POSTHOG_EVENT_RAW), res);

    expect(deps.getWebhookEndpointByPathToken).toHaveBeenCalledWith('token-1', 'posthog');
    expect(deps.markIntegrationWebhookReceived).toHaveBeenCalledWith('endpoint-1', undefined, true);
    expect(deps.forwardWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'event_matched',
        deliveryId: '0192b1f4-6c2a-7c1e-9a3b-8d2f1e4c5a6b',
        rawPayload: POSTHOG_EVENT,
      }),
    );
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({
      status: 'relayed',
      eventType: 'event_matched',
    });
  });

  it('returns 401 and never starts a Flow for an unsigned delivery', async () => {
    const res = makeRes();
    await call(
      makeReq({
        provider: 'posthog',
        rawBody: POSTHOG_EVENT_RAW,
        signature: null,
      }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Signature required' });
    expect(deps.markIntegrationWebhookError).toHaveBeenCalledWith(
      'endpoint-1',
      'Missing required webhook signature',
      undefined,
    );
    expect(deps.markIntegrationWebhookReceived).not.toHaveBeenCalled();
    expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
  });

  it('returns 401 and never starts a Flow for a delivery signed with another secret', async () => {
    const res = makeRes();
    const otherSecret = standardWebhooksSecret(crypto.randomBytes(32).toString('hex'));
    await call(makePosthogReq(POSTHOG_EVENT_RAW, otherSecret), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid signature' });
    expect(deps.markIntegrationWebhookError).toHaveBeenCalledWith(
      'endpoint-1',
      'Invalid webhook signature - secret mismatch',
      undefined,
    );
    expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
  });

  it('maps the vendor event string to the intent that names it and flattens the row filters', async () => {
    const rawBody = JSON.stringify({
      ...POSTHOG_BODY,
      event: { ...POSTHOG_BODY.event, event: '$exception' },
    });
    await call(makePosthogReq(rawBody), makeRes());
    expect(deps.forwardWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'error_captured',
        eventData: expect.objectContaining({
          event: '$exception',
          distinctId: 'user-42',
          provider: 'posthog',
          externalUserId: '',
        }),
        ownerExternalId: null,
        deliveryId: 'evt-uuid-1',
      }),
    );
  });

  it('resolves a body without the event name to the catch-all intent and hashes the body for its id', async () => {
    const rawBody = JSON.stringify({ hello: 'world' });
    await call(makePosthogReq(rawBody), makeRes());
    expect(deps.forwardWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'event_matched',
        deliveryId: crypto.createHash('sha256').update(rawBody).digest('hex'),
      }),
    );
  });

  it('still rejects a malformed body before anything runs', async () => {
    const res = makeRes();
    await call(makePosthogReq('[1]'), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(deps.markIntegrationWebhookReceived).not.toHaveBeenCalled();
    expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
  });
});

describe('paste_url webhook handler — a row Frink registered at the vendor (Linear)', () => {
  /** Linear's own delivery: the raw body, a hex HMAC header, and its own delivery id. */
  const LINEAR_BODY = JSON.stringify(TRIGGER_SAMPLES.linear?.issue_created);

  function makeLinearReq(rawBody: string, secret = SECRET) {
    return makeReq({
      provider: 'linear',
      rawBody,
      signature: null,
      headers: {
        'linear-signature': crypto.createHmac('sha256', secret).update(rawBody).digest('hex'),
        'linear-delivery': 'linear-delivery-1',
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    deps.getWebhookEndpointByPathToken.mockResolvedValue(makeEndpoint('owner-1', 'linear'));
  });

  it('relays a signed Linear delivery through the curated extractor', async () => {
    const res = makeRes();
    await call(makeLinearReq(LINEAR_BODY), res);

    expect(deps.getWebhookEndpointByPathToken).toHaveBeenCalledWith('token-1', 'linear');
    expect(deps.markIntegrationWebhookReceived).toHaveBeenCalledWith('endpoint-1', undefined, true);
    expect(deps.forwardWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'issue_created',
        // Linear's header id is outside its signature, so the signed bytes decide the delivery.
        deliveryId: crypto.createHash('sha256').update(LINEAR_BODY).digest('hex'),
        eventData: expect.objectContaining({
          provider: 'linear',
          identifier: 'ENG-412',
        }),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('returns 401 and never starts a Flow for an unsigned delivery', async () => {
    const res = makeRes();
    await call(makeReq({ provider: 'linear', rawBody: LINEAR_BODY, signature: null }), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Signature required' });
    expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
  });

  it('returns 401 for a delivery signed with another secret', async () => {
    const res = makeRes();
    await call(makeLinearReq(LINEAR_BODY, 'someone-elses-secret'), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid signature' });
    expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
  });
});

describe('paste_url webhook handler — a pasted-URL row with a curated extractor (Shortcut)', () => {
  /** Shortcut's own delivery: the raw body, a bare hex HMAC in `Payload-Signature`, and its `id`. */
  const SHORTCUT_BODY = JSON.stringify({
    id: 'shortcut-delivery-1',
    ...TRIGGER_SAMPLES.shortcut?.story_moved,
  });

  function makeShortcutReq(rawBody: string, secret = SECRET) {
    return makeReq({
      provider: 'shortcut',
      rawBody,
      signature: null,
      headers: {
        'payload-signature': crypto.createHmac('sha256', secret).update(rawBody).digest('hex'),
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    deps.getWebhookEndpointByPathToken.mockResolvedValue(makeEndpoint('owner-1', 'shortcut'));
  });

  it('relays a signed delivery through the curated extractor, workflow-state names and all', async () => {
    const res = makeRes();
    await call(makeShortcutReq(SHORTCUT_BODY), res);

    expect(deps.getWebhookEndpointByPathToken).toHaveBeenCalledWith('token-1', 'shortcut');
    expect(deps.markIntegrationWebhookReceived).toHaveBeenCalledWith('endpoint-1', undefined, true);
    expect(deps.forwardWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'story_moved',
        // Shortcut's own delivery id, so its redelivery replays instead of re-running.
        deliveryId: 'shortcut-delivery-1',
        eventData: expect.objectContaining({
          provider: 'shortcut',
          storyId: 4821,
          oldStatus: 'Ready for Dev',
          newStatus: 'In Progress',
        }),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('returns 401 and never starts a Flow when the signature header is absent', async () => {
    const res = makeRes();
    await call(makeReq({ provider: 'shortcut', rawBody: SHORTCUT_BODY, signature: null }), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Signature required' });
    expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
  });

  it('returns 401 for a delivery signed with another secret', async () => {
    const res = makeRes();
    await call(makeShortcutReq(SHORTCUT_BODY, 'someone-elses-secret'), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid signature' });
    expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
  });

  it('carries one delivery id across a replay, and a fresh one for a distinct delivery', async () => {
    const other = JSON.stringify({
      id: 'shortcut-delivery-2',
      ...TRIGGER_SAMPLES.shortcut?.story_moved,
    });
    await call(makeShortcutReq(SHORTCUT_BODY), makeRes());
    await call(makeShortcutReq(SHORTCUT_BODY), makeRes());
    await call(makeShortcutReq(other), makeRes());

    // The machine dedupes on this id, so a redelivery of the same bytes must not mint a new one.
    expect(deps.forwardWebhookEvent.mock.calls.map(([event]) => event.deliveryId)).toEqual([
      'shortcut-delivery-1',
      'shortcut-delivery-1',
      'shortcut-delivery-2',
    ]);
  });
});

describe('Notion verified subscription delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deps.markIntegrationWebhookReceived.mockReset().mockResolvedValue(true);
    deps.markIntegrationWebhookError.mockReset();
  });
  it.each([true, false])(
    'leaves a restarted endpoint untouched when an old delivery finishes (valid signature: %s)',
    async (valid) => {
      const live = makeEndpoint(null, 'notion');
      live.endpoint.vendor_ref = 'notion:verified:old';
      deps.getWebhookEndpointByPathToken.mockImplementationOnce(async () => {
        const snapshot = structuredClone(live);
        // The owner restarts after this lookup, before the receiver verifies its snapshot.
        live.endpoint.webhook_path_token = 'new-generation';
        live.endpoint.vendor_ref = null;
        return snapshot;
      });
      deps.markIntegrationWebhookReceived.mockImplementationOnce(async (_id, expected) => {
        if (
          expected &&
          (expected.generation !== live.endpoint.webhook_path_token ||
            expected.vendorRef !== live.endpoint.vendor_ref)
        )
          return false;
        live.endpoint.last_received_at = AT;
        return true;
      });
      deps.markIntegrationWebhookError.mockImplementationOnce(async (_id, message, expected) => {
        if (
          expected &&
          (expected.generation !== live.endpoint.webhook_path_token ||
            expected.vendorRef !== live.endpoint.vendor_ref)
        )
          return;
        live.endpoint.last_error = message;
      });
      const body = JSON.stringify({ id: 'old-event', type: 'page.created' });
      const res = makeRes();
      await call(
        makeReq({
          provider: 'notion',
          rawBody: body,
          headers: {
            'x-notion-signature': sign(valid ? SECRET : 'wrong-secret', body),
          },
        }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(valid ? 409 : 401);
      expect(live.endpoint.last_received_at).toBeNull();
      expect(live.endpoint.last_error).toBeNull();
      expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
    },
  );
  it('captures a first challenge without treating it as an event or confirming it', async () => {
    deps.getWebhookEndpointByPathToken.mockResolvedValue(makeEndpoint(null, 'notion'));
    const capture = vi.fn().mockResolvedValue(true);
    const res = makeRes();
    await receiveWebhook(
      makeReq({
        provider: 'notion',
        rawBody: JSON.stringify({
          verification_token: 'secret_verification_token_from_notion',
        }),
        signature: null,
      }),
      res,
      { ...deps, captureNotionChallenge: capture },
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(capture).toHaveBeenCalledWith(
      'endpoint-1',
      'token-1',
      'secret_verification_token_from_notion',
    );
    expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
    expect(deps.markIntegrationWebhookReceived).not.toHaveBeenCalled();
  });
  it('cannot replace a pending or confirmed challenge', async () => {
    const lookup = makeEndpoint(null, 'notion');
    lookup.endpoint.vendor_ref = 'notion:pending:already-received';
    deps.getWebhookEndpointByPathToken.mockResolvedValue(lookup);
    const capture = vi.fn();
    const res = makeRes();
    await receiveWebhook(
      makeReq({
        provider: 'notion',
        rawBody: JSON.stringify({
          verification_token: 'secret_replacement_token',
        }),
        signature: null,
      }),
      res,
      { ...deps, captureNotionChallenge: capture },
    );
    expect(res.status).toHaveBeenCalledWith(409);
    expect(capture).not.toHaveBeenCalled();
  });
  it('rejects a correctly signed event before owner confirmation', async () => {
    const lookup = makeEndpoint(null, 'notion');
    lookup.endpoint.vendor_ref = 'notion:pending:unconfirmed';
    deps.getWebhookEndpointByPathToken.mockResolvedValue(lookup);
    const body = JSON.stringify({
      id: 'event-1',
      type: 'page.created',
      entity: { id: 'page-1' },
    });
    const res = makeRes();
    await call(
      makeReq({
        provider: 'notion',
        rawBody: body,
        headers: { 'x-notion-signature': sign(SECRET, body) },
      }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
  });
  it('relays confirmed signed events with the vendor delivery ID and refuses tampered bytes', async () => {
    const lookup = makeEndpoint(null, 'notion');
    lookup.endpoint.vendor_ref = 'notion:verified:confirmed';
    deps.getWebhookEndpointByPathToken.mockResolvedValue(lookup);
    const body = JSON.stringify({
      id: 'event-1',
      type: 'page.created',
      entity: { id: 'page-1' },
    });
    const res = makeRes();
    await call(
      makeReq({
        provider: 'notion',
        rawBody: body,
        headers: { 'x-notion-signature': sign(SECRET, body) },
      }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(202);
    expect(deps.forwardWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'page_created',
        deliveryId: 'event-1',
      }),
    );
    deps.forwardWebhookEvent.mockClear();
    const invalid = makeRes();
    await call(
      makeReq({
        provider: 'notion',
        rawBody: `${body}\n`,
        headers: { 'x-notion-signature': sign(SECRET, body) },
      }),
      invalid,
    );
    expect(invalid.status).toHaveBeenCalledWith(401);
    expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
  });
});

describe('Hugging Face shared secret-header receiver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deps.getWebhookEndpointByPathToken.mockResolvedValue(makeEndpoint('owner-1', 'huggingface'));
  });
  it.each([undefined, 'wrong-secret'])(
    'rejects missing or incorrect webhook secrets: %s',
    async (secret) => {
      const res = makeRes();
      await call(
        makeReq({
          provider: 'huggingface',
          signature: null,
          rawBody: JSON.stringify({
            event: { scope: 'repo.content', action: 'update' },
          }),
          headers: secret ? { 'x-webhook-secret': secret } : {},
        }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(401);
      expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
    },
  );
  it('accepts the configured secret and names the delivery by its body, not its headers', async () => {
    const rawBody = JSON.stringify({ event: { scope: 'repo.content', action: 'update' } });
    const res = makeRes();
    await call(
      makeReq({
        provider: 'huggingface',
        signature: null,
        rawBody,
        headers: { 'x-webhook-secret': SECRET, 'webhook-id': 'delivery-1' },
      }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(202);
    expect(deps.forwardWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: crypto.createHash('sha256').update(rawBody).digest('hex'),
        eventType: 'repo_content_changed',
      }),
    );
  });
});

describe('Square signed delivery', () => {
  const url = 'https://frink.example/api/triggers/square/token-1';
  const body = '{"type":"payment.created","event_id":"square-event-1"}';
  beforeEach(() => {
    vi.clearAllMocks();
    const lookup = makeEndpoint(null, 'square');
    lookup.endpoint.vendor_ref = 'manual:square:' + url;
    deps.getWebhookEndpointByPathToken.mockResolvedValue(lookup);
  });
  it('relays a Square signature over the stored notification URL and raw body', async () => {
    const res = makeRes();
    await call(
      makeReq({
        provider: 'square',
        rawBody: body,
        signature: null,
        headers: {
          host: 'untrusted-host.example',
          'x-square-hmacsha256-signature': crypto
            .createHmac('sha256', SECRET)
            .update(url + body)
            .digest('base64'),
        },
      }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(202);
    expect(deps.forwardWebhookEvent).toHaveBeenCalledOnce();
  });
  it.each([undefined, 'invalid'])(
    'rejects an absent or mismatched vendor signature (%s)',
    async (signature) => {
      const res = makeRes();
      await call(
        makeReq({
          provider: 'square',
          rawBody: body,
          signature: null,
          headers: signature ? { 'x-square-hmacsha256-signature': signature } : {},
        }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(401);
      expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
    },
  );
  it('refuses delivery before the vendor key is imported even with a signed endpoint secret', async () => {
    deps.getWebhookEndpointByPathToken.mockResolvedValue(makeEndpoint(null, 'square'));
    const res = makeRes();
    await call(
      makeReq({
        provider: 'square',
        rawBody: body,
        headers: {
          'x-square-hmacsha256-signature': crypto
            .createHmac('sha256', SECRET)
            .update(url + body)
            .digest('base64'),
        },
      }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
  });
});

describe.each([
  ['vercel', 'x-vercel-signature', 'sha1', '{"type":"deployment.succeeded","id":"deployment-1"}'],
  ['sentry', 'sentry-hook-signature', 'sha256', '{"action":"created"}'],
])('%s vendor-issued signing keys', (provider, header, algorithm, body) => {
  beforeEach(() => {
    vi.clearAllMocks();
    const lookup = makeEndpoint(null, provider);
    lookup.endpoint.vendor_ref = `manual:${provider}:https://frink.example/api/triggers/${provider}/token-1`;
    deps.getWebhookEndpointByPathToken.mockResolvedValue(lookup);
  });
  it('accepts a signature from the imported vendor key', async () => {
    const res = makeRes();
    await call(
      makeReq({
        provider,
        rawBody: body,
        signature: null,
        headers: {
          [header]: crypto.createHmac(algorithm, SECRET).update(body).digest('hex'),
        },
      }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(202);
    expect(deps.forwardWebhookEvent).toHaveBeenCalledOnce();
  });
  it.each([undefined, 'invalid'])(
    'rejects absent or mismatched signatures (%s)',
    async (signature) => {
      const res = makeRes();
      await call(
        makeReq({
          provider,
          rawBody: body,
          signature: null,
          headers: signature ? { [header]: signature } : {},
        }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(401);
      expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
    },
  );
  it('requires key import before receiving events', async () => {
    deps.getWebhookEndpointByPathToken.mockResolvedValue(makeEndpoint(null, provider));
    const res = makeRes();
    await call(
      makeReq({
        provider,
        rawBody: body,
        headers: {
          [header]: crypto.createHmac(algorithm, SECRET).update(body).digest('hex'),
        },
      }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(deps.forwardWebhookEvent).not.toHaveBeenCalled();
  });
});
