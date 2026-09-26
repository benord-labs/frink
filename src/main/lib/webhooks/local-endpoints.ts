/** Minting, listing, rotating and testing the addresses this machine owns outright. Everything here
 * is local: the keys are this machine's, and so is the verdict on a delivery. */

import crypto from 'node:crypto';
import type { ProviderId } from '../../../shared/integrations/providers';
import { getProviderById, servedLocally } from '../../../shared/integrations/selectors';
import { TRIGGER_SAMPLES } from '../../../shared/integrations/trigger-samples';
import type { Provider, WebhookPayloadSpec } from '../../../shared/integrations/types';
import { importedWebhookUrl } from '../../../shared/integrations/webhook-secret';
import type { WebhookHeaders } from '../../../shared/webhooks/extractors/types';
import { buildGithubSignature } from '../../../shared/webhooks/github-hmac';
import { receiveWebhook } from '../../../shared/webhooks/receiver';
import { signHexHmac } from '../../../shared/webhooks/signatures/hex-hmac';
import { standardWebhooksHeaders } from '../../../shared/webhooks/signatures/standard-webhooks';
import {
  isVendorSignature,
  vendorSignatureHeaders,
} from '../../../shared/webhooks/signatures/vendor-hmac';
import {
  confirmNotionWebhook,
  countWebhookEndpoints,
  deactivateWebhookEndpoint,
  findLocalIntegration,
  findWebhookEndpoint,
  insertIntegration,
  insertWebhookEndpoint,
  listLocalIntegrations,
  listWebhookEndpointsForIntegration,
  type LocalIntegrationRow,
  type LocalWebhookRow,
  type MintedKeys,
  restartNotionWebhook,
  rotateWebhookEndpointKeys,
  setWebhookEndpointVendor,
} from '../db/repos/webhook-ingress';
import { withConnectionLifecycleOperation } from '../integrations/connection-lifecycle-operation';
import { webhookUrlOn } from '../integrations/trigger-registrars/webhook-url';
import { localIngressBaseUrl } from './base-url';
import { createLocalWebhookDeps, type LocalWebhookIo, readSealedSecret } from './deps';
import { receiverRequest } from './request';
import { recordingResponder } from './responder';

/** The receiver's own io plus the one thing minting adds: a new address has to be claimed on the
 * relay now rather than at the next reconnect, or it takes no delivery until then. */
export type LocalEndpointIo = LocalWebhookIo & { claimAddresses(): void };

/** Max addresses per account before new ones are refused; env-configurable, default 10. */
// SAFETY: electron-vite types only the env keys it knows; the cast reads this one as an optional string.
const parsedEndpointLimit = Number.parseInt(
  (import.meta.env as Record<string, string | undefined>)
    .MAIN_VITE_MAX_WEBHOOK_ENDPOINTS_PER_INTEGRATION ??
    process.env.MAIN_VITE_MAX_WEBHOOK_ENDPOINTS_PER_INTEGRATION ??
    process.env.MAX_WEBHOOK_ENDPOINTS_PER_INTEGRATION ??
    '10',
  10,
);
export const WEBHOOK_ENDPOINT_LIMIT =
  Number.isFinite(parsedEndpointLimit) && parsedEndpointLimit > 0 ? parsedEndpointLimit : 10;

/** The endpoint fields the trigger card reads, in the shape the hosted path already returns. */
export type LocalEndpointView = {
  id: string;
  integrationId: string;
  provider: string;
  webhookPathToken: string;
  webhookSecret: string;
  isActive: boolean;
  lastReceivedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  vendorRef: string | null;
  webhookUrl: string;
};

/** The account an endpoint hangs off: its id, and the provider whose class decides every path. */
export type LocalTriggerAccount = Pick<LocalIntegrationRow, 'id' | 'provider'>;

export type LocalResult<T> = ({ success: true } & T) | { success: false; error: string };
export type LocalOutcome = LocalResult<Record<never, never>>;

const SECRET_UNREADABLE = 'The saved secret for this address cannot be read on this machine';
const ENDPOINT_MISSING = 'Trigger not found.';
const CHANGED = 'Trigger setup changed. Refresh and try again.';
const NOT_NOTION = 'Only a Notion trigger is set up this way.';

function refuse(error: string) {
  return { success: false as const, error };
}

/** A fresh subscribe key, the public address that is its hash, and a fresh signing secret. */
export function mintEndpointKeys(io: LocalWebhookIo): MintedKeys {
  const subscribeKey = crypto.randomBytes(32).toString('hex');
  return {
    pathToken: crypto.createHash('sha256').update(subscribeKey, 'utf8').digest('hex'),
    subscribeKeyEncrypted: io.encryptSecret(subscribeKey),
    signingSecretEncrypted: io.encryptSecret(crypto.randomBytes(32).toString('hex')),
  };
}

function endpointView(row: LocalWebhookRow, secret: string): LocalEndpointView {
  return {
    id: row.id,
    integrationId: row.integrationId,
    provider: row.provider,
    webhookPathToken: row.pathToken,
    webhookSecret: secret,
    isActive: row.isActive,
    lastReceivedAt: row.lastReceivedAt?.toISOString() ?? null,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
    vendorRef: row.vendorRef,
    webhookUrl: webhookUrlOn(localIngressBaseUrl(), row.provider, row.pathToken),
  };
}

/** A row whose secret this keyring cannot open is shown without one rather than hidden: the
 * address is still the user's, and the card's own error line says what to do about it. */
function viewOf(io: LocalEndpointIo, row: LocalWebhookRow): LocalEndpointView {
  return endpointView(row, readSealedSecret(io, row.signingSecretEncrypted) ?? '');
}

/** A local account carries no label of its own: it is named after its provider, on every read. */
export function localAccountIdentifier(provider: string): string {
  return getProviderById(provider)?.display_name ?? provider;
}

/** One trigger account as every picker reads it, already in the shape the renderer receives. */
export type TriggerAccount = {
  id: string;
  provider: ProviderId;
  accountName: string | null;
  accountIdentifier: string;
  externalUserId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

/** The integration accounts this machine holds; a Flow is wired to a locally minted address. */
export async function localIntegrationRows(db: LocalEndpointIo['db']): Promise<TriggerAccount[]> {
  return (await listLocalIntegrations(db)).map((row) => ({
    id: row.id,
    // SAFETY: the local table only ever holds catalog provider ids; the class gate refuses any other.
    provider: row.provider as ProviderId,
    accountName: null,
    accountIdentifier: localAccountIdentifier(row.provider),
    externalUserId: row.externalUserId,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/**
 * The account this id names on this machine. Only the classes Frink serves locally ever get a row
 * here, so finding one is the class decision; a hosted-class account is not in this table at all.
 */
export async function localTriggerAccount(
  io: LocalEndpointIo,
  integrationId: string,
): Promise<LocalIntegrationRow | null> {
  return (await findLocalIntegration(io.db, integrationId)) ?? null;
}

/** The class gate, stated once: an available row this machine serves, pasted or self-registered. */
function localProvider(integration: LocalTriggerAccount): Provider | undefined {
  const provider = getProviderById(integration.provider);
  return servedLocally(provider) ? provider : undefined;
}

function notServedHere(integration: LocalTriggerAccount) {
  const name = getProviderById(integration.provider)?.display_name ?? integration.provider;
  return refuse(`Frink can't make a ${name} address on this machine yet.`);
}

export async function createLocalTriggerAccount(
  io: LocalEndpointIo,
  provider: string,
): Promise<string> {
  return insertIntegration(io.db, { provider });
}

export async function listLocalEndpoints(
  io: LocalEndpointIo,
  integration: LocalTriggerAccount,
): Promise<LocalEndpointView[]> {
  const rows = await listWebhookEndpointsForIntegration(io.db, integration.id);
  return rows.map((row) => viewOf(io, row));
}

/** Mint and rotate are read-then-write pairs; one account's run serially, as the hosted path's did. */
export async function mintLocalEndpoint(
  io: LocalEndpointIo,
  integration: LocalTriggerAccount,
  limit: number,
): Promise<LocalResult<{ endpoint: LocalEndpointView }>> {
  if (!localProvider(integration)) return notServedHere(integration);
  return withConnectionLifecycleOperation(integration.id, async () => {
    // Re-read under the lock: a Remove that queued ahead of this mint has already taken the account.
    if (!(await findLocalIntegration(io.db, integration.id)))
      return refuse('Trigger account not found.');
    if ((await countWebhookEndpoints(io.db, integration.id)) >= limit)
      return refuse(`Webhook endpoint limit reached (${limit} per integration)`);
    const id = await insertWebhookEndpoint(io.db, {
      integrationId: integration.id,
      provider: integration.provider,
      ...mintEndpointKeys(io),
    });
    io.claimAddresses();
    const row = await findWebhookEndpoint(io.db, integration.id, id);
    if (!row) return refuse(ENDPOINT_MISSING);
    return { success: true as const, endpoint: viewOf(io, row) };
  });
}

/** One row as the card reads it, after an action somewhere else wrote it. */
export async function localEndpointView(
  io: LocalEndpointIo,
  integration: LocalTriggerAccount,
  endpointId: string,
): Promise<LocalResult<{ endpoint: LocalEndpointView }>> {
  const row = await findWebhookEndpoint(io.db, integration.id, endpointId);
  return row ? { success: true as const, endpoint: viewOf(io, row) } : refuse(ENDPOINT_MISSING);
}

export async function rotateLocalEndpoint(
  io: LocalEndpointIo,
  integration: LocalTriggerAccount,
  endpointId: string,
): Promise<LocalResult<{ endpoint: LocalEndpointView }>> {
  if (!localProvider(integration)) return notServedHere(integration);
  return withConnectionLifecycleOperation(integration.id, async () => {
    const current = await findWebhookEndpoint(io.db, integration.id, endpointId);
    if (!current) return refuse(ENDPOINT_MISSING);
    const row = await rotateWebhookEndpointKeys(
      io.db,
      endpointId,
      current.pathToken,
      mintEndpointKeys(io),
    );
    if (!row) return refuse(CHANGED);
    io.claimAddresses();
    return { success: true as const, endpoint: viewOf(io, row) };
  });
}

export async function deactivateLocalEndpoint(
  io: LocalEndpointIo,
  integration: LocalTriggerAccount,
  endpointId: string,
): Promise<LocalResult<{ endpoint: LocalEndpointView }>> {
  if (!(await findWebhookEndpoint(io.db, integration.id, endpointId)))
    return refuse(ENDPOINT_MISSING);
  const row = await deactivateWebhookEndpoint(io.db, endpointId);
  if (!row) return refuse(ENDPOINT_MISSING);
  return { success: true as const, endpoint: viewOf(io, row) };
}

/** The vendor's key and the exact address it was configured against land in one write: Square
 * signs the notification URL, so a secret stored without its URL refuses every delivery. */
export async function importLocalVendorSecret(
  io: LocalEndpointIo,
  integration: LocalTriggerAccount,
  endpointId: string,
  secret: string,
): Promise<LocalOutcome> {
  const provider = localProvider(integration);
  if (!provider?.webhook_setup?.secret) return notServedHere(integration);
  const row = await findWebhookEndpoint(io.db, integration.id, endpointId);
  if (!row?.isActive) return refuse(ENDPOINT_MISSING);
  const url = webhookUrlOn(localIngressBaseUrl(), provider.id, row.pathToken);
  const saved = await setWebhookEndpointVendor(
    io.db,
    endpointId,
    `manual:${provider.id}:${url}`,
    io.encryptSecret(secret),
    row.pathToken,
  );
  return saved ? { success: true as const } : refuse(CHANGED);
}

export async function confirmLocalNotion(
  io: LocalEndpointIo,
  integration: LocalTriggerAccount,
  endpointId: string,
  generation: string,
  candidate: string,
): Promise<LocalOutcome> {
  if (!localProvider(integration)) return notServedHere(integration);
  if (integration.provider !== 'notion') return refuse(NOT_NOTION);
  const saved = await confirmNotionWebhook(io.db, endpointId, generation, candidate);
  return saved ? { success: true as const } : refuse(CHANGED);
}

export async function restartLocalNotion(
  io: LocalEndpointIo,
  integration: LocalTriggerAccount,
  endpointId: string,
  generation: string,
  candidate: string | null,
): Promise<LocalOutcome> {
  if (!localProvider(integration)) return notServedHere(integration);
  if (integration.provider !== 'notion') return refuse(NOT_NOTION);
  const restarted = await restartNotionWebhook(
    io.db,
    endpointId,
    generation,
    candidate,
    mintEndpointKeys(io),
  );
  if (!restarted) return refuse(CHANGED);
  io.claimAddresses();
  return { success: true as const };
}

/** Sign the catalog's own sample exactly the way the row says the vendor would, so the receiver's
 * check is real. A scheme with no signer here belongs to a class this machine does not serve. */
function sampleSignature(
  spec: WebhookPayloadSpec,
  secret: string,
  rawBody: string,
  vendorRef: string | null,
): WebhookHeaders | null {
  const scheme = spec.signature;
  if (scheme === undefined) return null;
  if (scheme === 'standard_webhooks')
    return standardWebhooksHeaders(secret, crypto.randomUUID(), rawBody);
  if (scheme === 'frink_hmac')
    return { 'x-frink-signature': buildGithubSignature(secret, rawBody) };
  if (scheme === 'notion') return { 'x-notion-signature': buildGithubSignature(secret, rawBody) };
  if (isVendorSignature(scheme))
    return vendorSignatureHeaders(
      scheme,
      secret,
      importedWebhookUrl(scheme, vendorRef) ?? '',
      rawBody,
    );
  if ('secret_header' in scheme) return { [scheme.secret_header.toLowerCase()]: secret };
  return { [scheme.hex_hmac_header.toLowerCase()]: signHexHmac(secret, rawBody) };
}

/** The sample re-enters the same receiver an inbound delivery does, over the same local deps: a
 * pass means the whole path works, network down included. */
export async function sendLocalTestEvent(
  io: LocalEndpointIo,
  integration: LocalTriggerAccount,
  endpointId: string,
  eventId: string,
): Promise<LocalResult<{ eventType: string }>> {
  const provider = localProvider(integration);
  const spec = provider?.webhook_payload;
  if (!provider || !spec) return notServedHere(integration);
  const row = await findWebhookEndpoint(io.db, integration.id, endpointId);
  if (!row?.isActive) return refuse(ENDPOINT_MISSING);
  const secret = readSealedSecret(io, row.signingSecretEncrypted);
  if (!secret) return refuse(SECRET_UNREADABLE);
  // A vendor-key row verifies nothing until its key is imported, so the sample cannot pass yet.
  if (isVendorSignature(spec.signature) && !importedWebhookUrl(spec.signature, row.vendorRef))
    return refuse(`Save ${provider.display_name}'s signing secret under Advanced first.`);
  const sample = TRIGGER_SAMPLES[provider.id]?.[eventId];
  if (!sample) return refuse('No sample event to send');
  const rawBody = JSON.stringify(sample);
  const headers = sampleSignature(spec, secret, rawBody, row.vendorRef);
  if (!headers) return notServedHere(integration);

  const responder = recordingResponder();
  await receiveWebhook(
    {
      ...receiverRequest(provider.id, row.pathToken, headers, 'POST'),
      rawBody,
      // Each press is its own delivery, so it must not replay the last one's run.
      deliveryId: crypto.randomUUID(),
    },
    responder,
    { ...createLocalWebhookDeps(io), recordNotionReceipt: false },
  );
  const answer = responder.body();
  if (answer && 'eventType' in answer && answer.eventType)
    return { success: true as const, eventType: answer.eventType };
  return refuse(answer && 'error' in answer ? answer.error : 'The test event did not start a Flow');
}
