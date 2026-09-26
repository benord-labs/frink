import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '.';
import { isPayloadDrivenWebhookProvider } from '../selectors';
import type { JsonValue } from '../../types/permissions';
import { TRIGGER_SAMPLES } from '../trigger-samples';
import type { Provider, TriggerSample, PayloadDrivenWebhookProvider } from '../types';
import { TRIGGER_SOURCES } from '../../types/trigger-context';

function providerById(id: string): Provider {
  const provider = PROVIDERS.find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`No ${id} row in the provider catalog.`);
  return provider;
}

describe('provider catalog', () => {
  it('names how every provider subscribes to its triggers', () => {
    expect(PROVIDERS.map((provider) => [provider.id, provider.subscription])).toEqual([
      ['shortcut', 'paste_url'],
      ['clickup', 'auto'],
      ['linear', 'paste_url'],
      ['atlassian', 'paste_url'],
      ['huggingface', 'auto'],
      ['webflow', 'auto'],
      ['notion', 'paste_url'],
      ['posthog', 'auto'],
      ['sentry', 'paste_url'],
      ['cloudflare', 'auto'],
      ['vercel', 'paste_url'],
      ['supabase', 'paste_url'],
      ['square', 'paste_url'],
      ['paypal', 'paste_url'],
      ['generic_webhook', 'paste_url'],
    ]);
  });

  it('serves Shortcut from the shared receiver, reading its body with a curated extractor', () => {
    const shortcut = providerById('shortcut');
    expect(shortcut.payload_extractor).toBe('shortcut');
    expect(shortcut.webhook_payload).toEqual({
      event_id_path: 'id',
      owner_path: 'member_id',
      signature: { hex_hmac_header: 'payload-signature' },
    });
    expect(shortcut).not.toHaveProperty('enrichment_endpoints');
    expect(shortcut.events[0]).toMatchObject({ id: 'story_assigned', label: 'Story assigned' });
    expect(
      shortcut.filter_fields
        .filter((field) => field.value_source === 'text')
        .map((field) => field.id),
    ).toEqual(['labels', 'projectId', 'epicId']);
  });

  it('declares ClickUp raw signed events and optional automatic API-token setup', () => {
    const clickup = providerById('clickup');
    expect(clickup.payload_extractor).toBe('generic');
    expect(clickup.registrar).toEqual({
      adapter: 'clickup',
      credential: 'api_token',
      setup: 'api_token',
      tokenSetup: expect.objectContaining({ label: 'API key', resourceLabel: 'workspace' }),
    });
    expect(clickup.webhook_payload).toEqual({
      event_type_path: 'event',
      signature: { hex_hmac_header: 'x-signature' },
    });
    expect(clickup.events.map((event) => event.vendor_events?.[0])).toEqual([
      undefined,
      'taskCreated',
      'taskStatusUpdated',
      'taskAssigneeUpdated',
      'taskCommentPosted',
    ]);
    expect(clickup.filter_fields).toEqual([]);
  });

  it('describes PostHog as a webhook-only row the shared receiver reads from data', () => {
    const posthog = providerById('posthog');
    expect(posthog.payload_extractor).toBe('generic');
    expect(posthog.webhook_setup?.url).toBe('https://app.posthog.com/data-management/destinations');
    // The destination signs every delivery (Standard Webhooks), so the receiver requires it.
    expect(posthog.webhook_payload).toEqual({
      event_type_path: 'event.event',
      event_id_path: 'event.uuid',
      signature: 'standard_webhooks',
    });
    expect(posthog.webhook_setup?.steps).toContain('Paste the Secret into "Signing secret"');
    expect(posthog.events.map((event) => [event.id, event.vendor_events])).toEqual([
      ['event_matched', undefined],
      ['error_captured', ['$exception']],
    ]);
    // Ungated like Shortcut: the trigger kill switch hides the card, never the chat plugin.
    expect(posthog.enabled_when).toBeUndefined();
  });

  it('gives every paste_url provider with one vendor page its setup steps', () => {
    expect(providerById('shortcut').webhook_setup).toMatchObject({
      url: 'https://app.shortcut.com/settings/integrations/incoming-webhooks',
    });
    expect(providerById('shortcut').webhook_setup?.steps.length).toBeGreaterThan(0);
  });

  it('leaves Shortcut ungated, so the trigger kill switch hides its card and never the plugin', () => {
    expect(providerById('shortcut').enabled_when).toBeUndefined();
  });

  it('reads a Linear delivery from the row, so no receiver knows the vendor', () => {
    expect(providerById('linear').webhook_payload).toEqual({
      signature: { hex_hmac_header: 'linear-signature' },
    });
  });

  it('offers no webhook the receiver cannot authenticate', () => {
    // The receiver 401s a row that names no scheme, so an available row without one is a dead tile.
    const unsigned = PROVIDERS.filter(
      (provider) =>
        provider.status === 'available' &&
        provider.webhook_payload !== undefined &&
        provider.webhook_payload.signature === undefined,
    ).map((provider) => provider.id);
    expect(unsigned).toEqual([]);
  });

  it('keeps every provider id unique and known to trigger_context', () => {
    const ids = PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    // A row whose id the union rejects produces a trigger_context nothing downstream validates.
    expect(ids.filter((id) => !TRIGGER_SOURCES.some((source) => source === id))).toEqual([]);
  });
});

/**
 * Data-driven rows are read by ONE receiver (the machine's own listener), so a malformed row is
 * a trigger that silently never fires rather than a compile error.
 */
describe('webhook-only rows', () => {
  const webhookOnly = PROVIDERS.filter(isPayloadDrivenWebhookProvider);

  it.each(webhookOnly.map((provider) => [provider.id, provider] as const))(
    '%s names exactly one catch-all intent',
    (_id, provider) => {
      const catchAll = provider.events.filter((event) => event.vendor_events === undefined);
      expect(catchAll).toHaveLength(1);
    },
  );

  it.each(webhookOnly.map((provider) => [provider.id, provider] as const))(
    '%s reads its vendor event from a declared path whenever it offers more than the catch-all',
    (_id, provider) => {
      if (provider.events.length === 1) return;
      expect(provider.webhook_payload.event_type_path).toBeDefined();
    },
  );

  it.each(webhookOnly.map((provider) => [provider.id, provider] as const))(
    '%s gives every named intent at least one vendor string, listed only once across the row',
    (_id, provider) => {
      const named = provider.events.flatMap((event) => event.vendor_events ?? []);
      expect(named.length).toBe(new Set(named).size);
      for (const event of provider.events) {
        if (event.vendor_events) expect(event.vendor_events.length).toBeGreaterThan(0);
      }
    },
  );
});

describe('paste_url setup guides', () => {
  const withGuide = PROVIDERS.filter((provider) => provider.webhook_setup !== undefined);

  it.each(withGuide.map((provider) => [provider.id, provider] as const))(
    '%s opens a real https page and walks the user through it',
    (_id, provider) => {
      // The guide is the whole of the paste step for a non-developer: a stub of one or two
      // lines leaves them on a vendor page with nothing telling them what to click.
      expect(provider.webhook_setup?.url.startsWith('https://')).toBe(true);
      expect(provider.webhook_setup?.steps.length).toBeGreaterThanOrEqual(3);
    },
  );
});

describe('auto subscriptions', () => {
  it('names a registrar for exactly the rows Frink subscribes on the user’s behalf', () => {
    // Without a registrar an `auto` row has nobody to call the vendor; with one, a `paste_url`
    // row would carry a subscriber nothing ever runs.
    for (const provider of PROVIDERS) {
      expect([provider.id, provider.registrar !== undefined]).toEqual([
        provider.id,
        provider.subscription === 'auto',
      ]);
    }
  });

  it('registers PostHog from the machine with the grant the user already holds', () => {
    expect(providerById('posthog').registrar).toEqual({
      adapter: 'posthog',
      credential: 'mcp',
    });
  });
});

/** The row's own rule, as the receiver applies it: the intent naming `event_type_path`, else the catch-all. */
function resolveByRow(
  provider: PayloadDrivenWebhookProvider,
  sample: TriggerSample | undefined,
): string {
  let vendor: JsonValue | undefined = sample;
  for (const segment of provider.webhook_payload.event_type_path?.split('.') ?? []) {
    vendor = vendor instanceof Object && !Array.isArray(vendor) ? vendor[segment] : undefined;
  }
  const named = provider.events.find((event) =>
    event.vendor_events?.some((candidate) => candidate === vendor),
  );
  const catchAll = provider.events.find((event) => event.vendor_events === undefined);
  return (named ?? catchAll)?.id ?? 'unresolved';
}

describe('trigger samples', () => {
  it('gives every catalog event a sample, and files no sample under an event that is gone', () => {
    const missing = PROVIDERS.flatMap((provider) =>
      provider.events
        .filter((event) => TRIGGER_SAMPLES[provider.id]?.[event.id] === undefined)
        .map((event) => `${provider.id}.${event.id}`),
    );
    expect(missing).toEqual([]);
    const orphaned = Object.entries(TRIGGER_SAMPLES).flatMap(([providerId, samples]) =>
      Object.keys(samples)
        .filter((eventId) => !providerById(providerId).events.some((e) => e.id === eventId))
        .map((eventId) => `${providerId}.${eventId}`),
    );
    expect(orphaned).toEqual([]);
  });

  it.each(PROVIDERS.filter(isPayloadDrivenWebhookProvider).map((p) => [p.id, p] as const))(
    '%s samples each resolve to the event they are filed under',
    (_id, provider) => {
      const resolved = provider.events.map((event) => [
        event.id,
        resolveByRow(provider, TRIGGER_SAMPLES[provider.id]?.[event.id]),
      ]);
      expect(resolved).toEqual(provider.events.map((event) => [event.id, event.id]));
    },
  );
});
