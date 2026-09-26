import { describe, expect, it } from 'vitest';
import type { PayloadDrivenWebhookProvider } from '../../integrations/types';
import {
  genericExtractor,
  pasteUrlExtractor,
  readPathString,
  webhookOnlyProvider,
} from './generic';
import type { ExtractorContext } from './types';

const baseCtx: ExtractorContext = {
  integrationId: 'int-generic-1',
  userId: 'user-1',
  eventType: 'received',
  externalUserId: '',
};

describe('genericExtractor', () => {
  it('detectEventType always returns "received"', () => {
    expect(genericExtractor.detectEventType({}, undefined)).toBe('received');
    expect(genericExtractor.detectEventType({ type: 'invoice.paid' }, {})).toBe('received');
  });

  it('buildEventData spreads top-level body keys and sets canonical fields', async () => {
    const data = await genericExtractor.buildEventData(
      { type: 'invoice.paid', amount: 4200, nested: { deep: true } },
      { ...baseCtx, externalUserId: 'ext-7' },
    );

    expect(data).toEqual({
      type: 'invoice.paid',
      amount: 4200,
      nested: { deep: true },
      eventType: 'received',
      provider: 'generic_webhook',
      externalUserId: 'ext-7',
    });
  });

  it('canonical fields win over colliding reserved keys in the body', async () => {
    const data = await genericExtractor.buildEventData(
      { provider: 'spoofed_provider', eventType: 'spoofed_event', keep: 'me' },
      baseCtx,
    );

    expect(data.provider).toBe('generic_webhook');
    expect(data.eventType).toBe('received');
    expect(data.keep).toBe('me');
  });

  it('treats a non-object payload (array / primitive) as an empty body', async () => {
    const fromArray = await genericExtractor.buildEventData([1, 2, 3], baseCtx);
    expect(fromArray).toEqual({
      eventType: 'received',
      provider: 'generic_webhook',
      externalUserId: '',
    });

    const fromPrimitive = await genericExtractor.buildEventData('not-an-object', baseCtx);
    expect(fromPrimitive).toEqual({
      eventType: 'received',
      provider: 'generic_webhook',
      externalUserId: '',
    });
  });
});

describe('pasteUrlExtractor — a vendor row is data', () => {
  const posthog = webhookOnlyProvider('posthog');
  if (!posthog) throw new Error('posthog row missing');
  const extractor = pasteUrlExtractor(posthog);
  const body = {
    event: { uuid: 'u1', event: 'checkout_completed', distinct_id: 'user_42' },
    person: { id: 'p1' },
  };

  it('resolves the vendor string at event_type_path to the intent naming it, else the catch-all', () => {
    expect(extractor.detectEventType(body)).toBe('event_matched');
    expect(
      extractor.detectEventType({ ...body, event: { ...body.event, event: '$exception' } }),
    ).toBe('error_captured');
    expect(extractor.detectEventType({ event: { event: 42 } })).toBe('event_matched');
    expect(extractor.detectEventType({ unrelated: true })).toBe('event_matched');
    expect(extractor.detectEventType('not an object')).toBeNull();
  });

  it('flattens each declared filter path under its filter id, over the spread body', async () => {
    const data = await extractor.buildEventData(body, { ...baseCtx, eventType: 'event_matched' });
    expect(data).toEqual({
      ...body,
      event: 'checkout_completed',
      distinctId: 'user_42',
      eventType: 'event_matched',
      provider: 'posthog',
      externalUserId: '',
    });
  });

  it('returns null for a row with no catch-all when nothing names the vendor event', () => {
    const strict: PayloadDrivenWebhookProvider = {
      ...posthog,
      events: posthog.events.filter((event) => event.vendor_events !== undefined),
    };
    expect(pasteUrlExtractor(strict).detectEventType(body)).toBeNull();
    expect(pasteUrlExtractor(strict).detectEventType({ event: { event: '$exception' } })).toBe(
      'error_captured',
    );
  });

  it('readPathString walks dot paths and yields only strings', () => {
    expect(readPathString(body, 'event.distinct_id')).toBe('user_42');
    expect(readPathString(body, 'event.uuid')).toBe('u1');
    expect(readPathString(body, 'person.id')).toBe('p1');
    expect(readPathString(body, 'event.missing.deeper')).toBeUndefined();
    expect(readPathString(body, 'person')).toBeUndefined();
    expect(readPathString(body, undefined)).toBeUndefined();
  });
});
