/** The one tokenized receiver, `POST /api/triggers/<provider>/<token>`, serving every catalog row that
 * declares `webhook_payload`: every delivery must carry a signature that verifies, or nothing is forwarded. */

import crypto from 'node:crypto';
import { z } from 'zod';
import { getProviderById } from '../integrations/selectors';
import type { WebhookPayloadSpec } from '../integrations/types';
import { importedWebhookUrl } from '../integrations/webhook-secret';
import { extractorFor } from './extractors';
import { jsonObject, readPathString } from './extractors/generic';
import type { JsonObject } from './extractors/generic';
import type { WebhookEventData, WebhookHeaders } from './extractors/types';
import { getWebhookHeader } from './extractors/utils';
import { verifyGithubSignatureHeader } from './github-hmac';
import { BodyTooLargeError, readRawBodyCapped } from './raw-body';
import { verifyHexHmacHeader } from './signatures/hex-hmac';
import { notionChallenge, verifyNotionSignature, verifySecretHeader } from './signatures/notion';
import { type SignatureVerdict, verifyStandardWebhooks } from './signatures/standard-webhooks';
import { isVendorSignature, verifyVendorWebhook } from './signatures/vendor-hmac';

const SIGNATURE_HEADER = 'x-frink-signature';
const NOT_FOUND = {
  status: 'ignored',
  reason: 'webhook_not_found_or_inactive',
};

/** The vercel.json rewrite maps /api/triggers/<provider>/<token> onto these two query params. */
const routeParams = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
});

/** What the endpoint row records, and what the sender is told, for each way a signature can fail. */
const SIGNATURE_FAILURES = {
  missing: {
    mark: 'Missing required webhook signature',
    error: 'Signature required',
  },
  invalid: {
    mark: 'Invalid webhook signature - secret mismatch',
    error: 'Invalid signature',
  },
} satisfies Record<Exclude<SignatureVerdict, 'ok'>, { mark: string; error: string }>;

/** The slice of the request the receiver reads; a test can hand over a plain object. */
type WebhookRequest = {
  method?: string;
  query: Record<string, string | string[] | undefined>;
  headers: WebhookHeaders;
  rawBody?: Buffer | string;
  /** An in-process sender's own id for the delivery it is simulating. Every front door builds this
   * object through `receiverRequest`, so nothing off the wire can name its own id here. */
  deliveryId?: string;
};

/** Everything the receiver answers with: a refusal, or the outcome of a delivery it accepted. */
type ReceiverBody = { error: string } | { status: string; reason?: string; eventType?: string };

/** The slice of the reply the receiver writes; Vercel's response satisfies it. */
type WebhookResponder = {
  status(code: number): { json(body: ReceiverBody): void };
};

/** The endpoint row, narrowed to the fields the receiver reads. A host with no account has no user. */
type EndpointLookup = {
  user?: { id: string };
  integration: { id: string; external_user_id: string | null };
  endpoint: {
    id: string;
    webhook_path_token: string;
    webhook_secret: string;
    vendor_ref?: string | null;
  };
};

/** The generation a write must still match, so a restarted endpoint ignores an in-flight delivery. */
type WebhookGeneration = { generation: string; vendorRef: string };

/** The normalized event the host relays onward. A host without accounts names no user. */
type ForwardedWebhookEvent = {
  userId?: string;
  integrationId: string;
  eventType: string;
  eventData: WebhookEventData;
  ownerExternalId: string | null;
  deliveryId: string;
  rawPayload?: unknown;
};

/** The calls the receiver reaches for, so a test can stand in for them without mocking modules. */
export type WebhookReceiverDeps = {
  getWebhookEndpointByPathToken(
    webhookPathToken: string,
    provider: string,
  ): Promise<EndpointLookup | null>;
  markIntegrationWebhookError(
    endpointId: string,
    errorMessage: string,
    expected?: WebhookGeneration,
  ): Promise<void>;
  markIntegrationWebhookReceived(
    endpointId: string,
    expected?: WebhookGeneration,
    recordReceipt?: boolean,
  ): Promise<boolean>;
  forwardWebhookEvent(event: ForwardedWebhookEvent): Promise<void>;
  captureNotionChallenge(endpointId: string, generation: string, token: string): Promise<boolean>;
  captureException(cause: unknown, tags?: Record<string, string>): void;
  /** Synthetic delivery still checks the active generation, without claiming vendor receipt. */
  recordNotionReceipt?: boolean;
};

/** One policy for every scheme a row can name: the sender's signature must verify, or nothing is forwarded. */
// Reason: one branch per signature scheme the catalog can name; a table would hide which verifier runs.
// fallow-ignore-next-line complexity
async function signatureVerdict(
  spec: WebhookPayloadSpec,
  headers: WebhookHeaders,
  secret: string,
  rawBody: string,
  vendorRef?: string | null,
): Promise<SignatureVerdict> {
  if (spec.signature === undefined) return 'missing';
  if (isVendorSignature(spec.signature)) {
    const url = importedWebhookUrl(spec.signature, vendorRef);
    return url ? verifyVendorWebhook(spec.signature, headers, secret, url, rawBody) : 'invalid';
  }
  if (spec.signature === 'standard_webhooks')
    return verifyStandardWebhooks(headers, secret, rawBody);
  if (spec.signature === 'frink_hmac') {
    const header = getWebhookHeader(headers, SIGNATURE_HEADER);
    if (header === null) return 'missing';
    return verifyGithubSignatureHeader(header, secret, rawBody) ? 'ok' : 'invalid';
  }
  if (spec.signature === 'notion') return verifyNotionSignature(headers, secret, rawBody);
  if ('secret_header' in spec.signature)
    return verifySecretHeader(headers, spec.signature.secret_header, secret);
  return verifyHexHmacHeader(headers, spec.signature.hex_hmac_header, secret, rawBody);
}

/** A redelivery must replay, so the id has to survive one — and only bytes the signature covers may
 * decide it: a header is the sender's to vary, so one captured body under N ids would be N runs. */
function deliveryIdFor(spec: WebhookPayloadSpec, body: JsonObject, rawBody: string): string {
  return (
    readPathString(body, spec.event_id_path)?.trim() ||
    crypto.createHash('sha256').update(rawBody).digest('hex')
  );
}

// Reason: moved verbatim from the never-audited Vercel route; decomposing it is its own reviewed change.
// fallow-ignore-next-line complexity
export async function receiveWebhook(
  req: WebhookRequest,
  res: WebhookResponder,
  deps: WebhookReceiverDeps,
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const params = routeParams.safeParse(req.query);
  if (!params.success) {
    return res.status(404).json(NOT_FOUND);
  }

  let rawBody: string;
  try {
    rawBody = await readRawBodyCapped(req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return res.status(413).json({ error: 'Payload too large' });
    }
    throw error;
  }

  // The lookup only returns an endpoint of the path's provider, so a token pasted under the wrong
  // vendor's address is nobody's endpoint. A row with no `webhook_payload` is not served here.
  const provider = getProviderById(params.data.provider);
  const spec = provider?.webhook_payload;
  const lookup =
    provider && spec ? await deps.getWebhookEndpointByPathToken(params.data.id, provider.id) : null;
  if (!provider || !spec || !lookup) {
    return res.status(404).json(NOT_FOUND);
  }
  const { user, integration, endpoint } = lookup;

  if (spec.signature === 'notion') {
    let challenge: unknown;
    try {
      challenge = JSON.parse(rawBody);
    } catch {
      /* Invalid JSON is rejected below. */
    }
    const candidate = notionChallenge.safeParse(challenge);
    if (candidate.success) {
      if (endpoint.vendor_ref)
        return res.status(409).json({ error: 'Verification already received' });
      const saved = await deps.captureNotionChallenge(
        endpoint.id,
        endpoint.webhook_path_token,
        candidate.data.verification_token,
      );
      return res.status(saved ? 200 : 409).json({
        status: saved ? 'verification_received' : 'verification_changed',
      });
    }
    if (!endpoint.vendor_ref?.startsWith('notion:verified:')) {
      return res.status(401).json({ error: 'Complete Notion verification first' });
    }
  }
  const expected =
    spec.signature === 'notion' && endpoint.vendor_ref
      ? {
          generation: endpoint.webhook_path_token,
          vendorRef: endpoint.vendor_ref,
        }
      : undefined;
  const verdict = await signatureVerdict(
    spec,
    req.headers,
    endpoint.webhook_secret,
    rawBody,
    endpoint.vendor_ref,
  );
  if (verdict !== 'ok') {
    await deps.markIntegrationWebhookError(endpoint.id, SIGNATURE_FAILURES[verdict].mark, expected);
    return res.status(401).json({ error: SIGNATURE_FAILURES[verdict].error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  const body = jsonObject.safeParse(parsed);
  if (!body.success) {
    return res.status(400).json({ error: 'Body must be a JSON object' });
  }

  try {
    const extractor = extractorFor(provider);
    const eventType = extractor.detectEventType(body.data);
    if (expected) {
      const current = await deps.markIntegrationWebhookReceived(
        endpoint.id,
        expected,
        deps.recordNotionReceipt !== false,
      );
      if (!current) return res.status(409).json({ error: 'Notion verification changed' });
    } else {
      await deps.markIntegrationWebhookReceived(
        endpoint.id,
        undefined,
        deps.recordNotionReceipt !== false,
      );
    }

    if (eventType === null) {
      // No intent on the row stands for this vendor event — ack so the sender doesn't
      // retry-storm, but don't relay a non-event to the machine.
      return res.status(202).json({ status: 'ignored', reason: 'unsupported_event' });
    }

    const eventData = await extractor.buildEventData(body.data, {
      integrationId: integration.id,
      userId: user?.id,
      eventType,
      externalUserId: readPathString(body.data, spec.owner_path) ?? '',
    });

    const deliveryId = req.deliveryId ?? deliveryIdFor(spec, body.data, rawBody);

    // Forward the normalized event to the user's machine, where local flow graphs are matched
    // and started in-process. Signed-only ⇒ always execute (no start-mode downgrade).
    const event: ForwardedWebhookEvent = {
      integrationId: integration.id,
      eventType,
      eventData,
      ownerExternalId: integration.external_user_id ?? null,
      deliveryId,
      rawPayload: body.data,
    };
    if (user) event.userId = user.id;
    await deps.forwardWebhookEvent(event);

    return res.status(202).json({ status: 'relayed', eventType });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.markIntegrationWebhookError(endpoint.id, message, expected);
    deps.captureException(error, { context: 'trigger.paste_url' });
    return res.status(500).json({ error: 'Internal server error' });
  }
}
