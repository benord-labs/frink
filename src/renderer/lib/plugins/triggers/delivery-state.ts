import {
  isImportedWebhookSecret,
  standardWebhooksSecret,
} from '../../../../shared/integrations/webhook-secret';
import { isTriggerRegistrationComplete } from '../../../../shared/integrations/selectors';
import type { Provider } from '../../../../shared/integrations/types';
import { formatRelativeTime } from '../../utils/format-time';

/** The endpoint fields the trigger card and Flow editor read. `vendorRef` lands once a registrar has
 * armed the subscription, so on an `auto` row its absence is the incomplete setup state. */
export type TriggerEndpoint = {
  id: string;
  webhookUrl: string;
  webhookPathToken?: string;
  webhookSecret: string;
  isActive: boolean;
  lastReceivedAt: string | null;
  lastError: string | null;
  vendorRef?: string | null;
};

type TriggerDeliveryState = 'not_set_up' | 'paused' | 'listening' | 'last_event';

export type TriggerDelivery = {
  state: TriggerDeliveryState;
  /** The card's one-line answer to "is this working?". */
  headline: string;
  /** What went wrong last, in words a non-developer can act on. */
  problem?: string;
  endpoint?: TriggerEndpoint;
};

function vendorName(provider: Provider | undefined): string {
  return provider?.display_name ?? 'this plugin';
}

/** Vendor and receiver errors are developer-speak; the card names the cause and the fix instead. */
export function plainProblem(
  lastError: string | null | undefined,
  vendor: string,
): string | undefined {
  if (!lastError) return undefined;
  const lower = lastError.toLowerCase();
  if (lower.includes('signature')) {
    if (vendor === 'ClickUp') {
      return 'The last message from ClickUp was signed with a different secret. Copy the signing secret returned by ClickUp into Frink again, or run automatic setup.';
    }
    return `Frink could not verify the last message from ${vendor}. Paste the current signing secret from your ${vendor} webhook settings into Frink again.`;
  }
  if (/\b40[13]\b|unauthorized|forbidden/.test(lower)) {
    if (vendor === 'ClickUp')
      return 'Update your ClickUp API token in trigger setup, then try again.';
    return `Frink is no longer allowed to do this in ${vendor}. Reconnect ${vendor}, then set it up again.`;
  }
  if (/\b404\b|not found/.test(lower)) {
    return `Frink could not find this in ${vendor} any more. Set it up again.`;
  }
  return lastError;
}

/** The front door every vendor knocks on: no address is a problem on its own, and `reachable` is
 * false only once a connection Frink had is gone, so neither line here is a guess. */
export function relayProblem(relay: {
  baseUrl: string | null;
  reachable: boolean;
}): string | undefined {
  if (!relay.baseUrl) return "Frink can't receive events on this computer yet.";
  if (relay.reachable) return undefined;
  return "Frink can't receive events right now. Anything sent before it reconnects will be missed.";
}

/** Only a vendor adapter records a `vendor_ref`, so only an `auto` row has one to wait for. */
function awaitsVendorSubscription(provider: Provider | undefined): boolean {
  return provider?.subscription === 'auto';
}

/** A row on its own receiver always verifies the secret; one on the shared receiver only when it
 * declares a signature — the receiver refuses every other delivery, so no secret is shown unchecked. */
export function verifiesSecret(provider: Provider): boolean {
  return provider.webhook_payload === undefined || provider.webhook_payload.signature !== undefined;
}

/** A Standard Webhooks vendor's Signing secret field takes the endpoint secret base64-encoded; every other verifier takes the hex as stored. */
export function vendorSecret(provider: Provider, secret: string): string {
  return provider.webhook_payload?.signature === 'standard_webhooks'
    ? standardWebhooksSecret(secret)
    : secret;
}

/** The one action that turns a trigger on: Frink arms it, or the user pastes the address. */
export function setupCtaLabel(provider: Provider | undefined): string {
  if (provider?.webhook_verification) return 'Set up events';
  return provider?.subscription === 'paste_url' ? 'Set up events' : 'Set up automatically';
}

/**
 * Whether the vendor can reach Frink for this account, and the line that says so. A pasted row is
 * only "listening" once an event proves the address was pasted; until then Frink is waiting.
 */
export function triggerDelivery(input: {
  provider: Provider | undefined;
  endpoints: ReadonlyArray<TriggerEndpoint>;
  /** False while the plugin is turned off: the vendor still delivers and the machine drops it. */
  enabled?: boolean;
}): TriggerDelivery {
  const { provider, endpoints, enabled } = input;
  const vendor = vendorName(provider);
  const endpoint = endpoints.find((candidate) => candidate.isActive);
  const problem = plainProblem(endpoint?.lastError, vendor);

  if (
    endpoint === undefined ||
    (awaitsVendorSubscription(provider) && !isTriggerRegistrationComplete(endpoint.vendorRef)) ||
    (provider?.webhook_setup?.secret && !isImportedWebhookSecret(provider, endpoint.vendorRef))
  ) {
    return { state: 'not_set_up', headline: 'Not set up', problem, endpoint };
  }
  if (enabled === false) {
    return {
      state: 'paused',
      headline: 'Paused — turn the plugin on to receive events',
      problem,
      endpoint,
    };
  }
  if (
    provider?.webhook_verification === 'notion' &&
    !endpoint.vendorRef?.startsWith('notion:verified:')
  ) {
    return {
      state: 'not_set_up',
      headline: endpoint.vendorRef?.startsWith('notion:pending:')
        ? 'Confirm in Notion'
        : 'Set up Notion events',
      endpoint,
      problem,
    };
  }
  if (endpoint.lastReceivedAt) {
    return {
      state: 'last_event',
      headline: `Last event ${formatRelativeTime(endpoint.lastReceivedAt)}`,
      problem,
      endpoint,
    };
  }
  return {
    state: 'listening',
    headline:
      provider?.subscription === 'paste_url' || endpoint.vendorRef?.startsWith('manual:clickup:')
        ? `Waiting for the first ${vendor} event`
        : `Listening for ${vendor} events`,
    problem,
    endpoint,
  };
}

/** One line for a Flow's webhook trigger: how the vendor reaches Frink for the chosen account. */
export function triggerDeliveryLine(
  provider: Provider | undefined,
  delivery: TriggerDelivery,
): string {
  if (delivery.state === 'not_set_up') {
    return `Not set up — open ${vendorName(provider)} in Settings → Plugins`;
  }
  if (delivery.endpoint?.vendorRef?.startsWith('manual:clickup:')) return delivery.headline;
  if (provider?.subscription === 'auto') {
    return `${vendorName(provider)} notifies Frink automatically · ${delivery.headline}`;
  }
  return delivery.endpoint?.webhookUrl ?? delivery.headline;
}

/** The Advanced panel's pointer at the subscription Frink made; the ref's shape stays registrar-private. */
export function vendorReference(
  provider: Provider | undefined,
  endpoint: TriggerEndpoint | undefined,
): { label: string; url?: string } | undefined {
  if (!provider || !endpoint?.vendorRef) return undefined;
  // A vendor ref is a registrar-private locator, so the panel names the thing, never the id.
  const noun = provider.id === 'posthog' ? 'destination' : 'subscription';
  return { label: `${provider.display_name} ${noun}`, url: provider.webhook_setup?.url };
}
