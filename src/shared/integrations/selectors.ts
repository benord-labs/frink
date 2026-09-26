import type { PluginMcpServer, PluginNativeExtension } from './plugins';
import { LAUNCH_FLAGS } from '../launch-flags';
import { PROVIDERS } from './providers';
import type { EventSpec, FilterField, PayloadDrivenWebhookProvider, Provider } from './types';

/** A row with no vendor code: the shared receiver reads its body from `webhook_payload` alone. */
export function isPayloadDrivenWebhookProvider(p: Provider): p is PayloadDrivenWebhookProvider {
  return p.payload_extractor === 'generic';
}

type ProviderConnection = Extract<PluginNativeExtension, { kind: 'frink_provider' }>['connection'];

/** The account grant a provider's plugin declares. A webhook-secret account beside chat tools or
 * skills is optional: its endpoint row is minted on demand from the plugin page. */
export function providerConnection(
  mcpServers: ReadonlyArray<PluginMcpServer>,
  hasSkills: boolean,
): ProviderConnection {
  return { required: mcpServers.length === 0 && !hasSkills };
}

export function getProviderById(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** The class this machine mints, signs and verifies entirely on its own: an available row the user
 * points at an address by hand, whose spec names a signature scheme. */
export function mintsLocally(provider: Provider | undefined): boolean {
  return (
    provider?.status === 'available' &&
    !provider.enabled_when?.some((flag) => LAUNCH_FLAGS[flag] !== true) &&
    provider.subscription === 'paste_url' &&
    provider.webhook_payload?.signature !== undefined
  );
}

/** The class this machine arms at the vendor itself: an available `auto` row whose registrar runs
 * in main with a credential the user already holds, and whose spec names a signature scheme. */
export function registersLocally(provider: Provider | undefined): boolean {
  return (
    provider?.status === 'available' &&
    !provider.enabled_when?.some((flag) => LAUNCH_FLAGS[flag] !== true) &&
    provider.subscription === 'auto' &&
    provider.registrar !== undefined &&
    provider.webhook_payload?.signature !== undefined
  );
}

/** Every class this machine serves end to end, however the subscription is established. */
export function servedLocally(provider: Provider | undefined): boolean {
  return mintsLocally(provider) || registersLocally(provider);
}

/** Multi-subscription adapters save cleanup scope before mutating; pending work is not listening. */
export function isTriggerRegistrationComplete(vendorRef: string | null | undefined): boolean {
  return Boolean(vendorRef && !/(^|:)pending:/.test(vendorRef));
}

export function getEventTypes(providerId: string): ReadonlyArray<EventSpec> {
  return getProviderById(providerId)?.events ?? [];
}

/** Whether an event carries assignee ids — what offers the editor's Assignee section and stores its condition. */
export function eventSupportsAssignee(providerId: string, eventTypeId: string): boolean {
  return (
    getProviderById(providerId)?.events.find((event) => event.id === eventTypeId)?.assignee === true
  );
}

export function getFilterFields(
  providerId: string,
  eventTypeId?: string,
): ReadonlyArray<FilterField> {
  const provider = getProviderById(providerId);
  if (!provider) return [];
  if (!eventTypeId) return provider.filter_fields;
  const event = provider.events.find((e) => e.id === eventTypeId);
  if (!event) return provider.filter_fields;
  const allowedIds = new Set(event.filter_field_ids);
  return provider.filter_fields.filter((f) => allowedIds.has(f.id));
}
