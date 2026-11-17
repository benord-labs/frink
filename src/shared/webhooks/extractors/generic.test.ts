import { describe, expect, it } from 'vitest';
import type { PayloadDrivenWebhookProvider } from '../../integrations/types';
import { matchesConditions } from '../../lib/webhook-match';
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

describe('pasteUrlExtractor — who an assignee event names', () => {
  const clickup = webhookOnlyProvider('clickup');
  if (!clickup) throw new Error('clickup row missing');
  const extractor = pasteUrlExtractor(clickup);
  const ctx = { ...baseCtx, eventType: 'task_assignee_changed' };
  const added = (id: number | string) => ({ field: 'assignee_add', before: null, after: { id } });
  const removed = (id: number) => ({ field: 'assignee_rem', before: { id }, after: null });
  const delivery = (...history_items: object[]) => ({
    event: 'taskAssigneeUpdated',
    task_id: '86a123',
    history_items,
  });

  it('names each added assignee once, as a string, and nobody a removal took off', async () => {
    const data = await extractor.buildEventData(
      delivery(removed(7), added(183), added('abc'), added(183)),
      ctx,
    );
    expect(data.ownerIds).toEqual(['183', 'abc']);
  });

  it('names nobody when the list is absent or the delivery only removes', async () => {
    expect((await extractor.buildEventData(delivery(removed(183)), ctx)).ownerIds).toEqual([]);
    expect(
      (await extractor.buildEventData({ event: 'taskAssigneeUpdated' }, ctx)).ownerIds,
    ).toEqual([]);
  });

  it('reads ids only on the event that carries assignees, and overrides a body key', async () => {
    const moved = {
      event: 'taskUpdated',
      history_items: [{ field: 'section_moved', after: { id: 9 } }],
    };
    const other = await extractor.buildEventData(moved, {
      ...baseCtx,
      eventType: 'event_received',
    });
    expect('ownerIds' in other).toBe(false);
    const spoofed = await extractor.buildEventData(
      { ...delivery(added(183)), ownerIds: ['999'] },
      ctx,
    );
    expect(spoofed.ownerIds).toEqual(['183']);
  });

  // The matcher reads the snake_case key first, so a body carrying one must not outrank the row.
  it('lets no key in the body stand in for the people the row names', async () => {
    const data = await extractor.buildEventData(
      { ...delivery(added(42)), owner_ids: ['183'], ownerIds: ['183'] },
      ctx,
    );
    expect(data.owner_ids).toEqual(['42']);
    expect(matchesConditions({ assignee: 'me' }, data, '183')).toBe(false);
    const emptied = await extractor.buildEventData(
      { ...delivery(removed(42)), owner_ids: ['183'] },
      ctx,
    );
    expect(matchesConditions({ assignee: 'anyone' }, emptied, '183')).toBe(false);
  });

  it('keeps a real delivery shape apart: a member id, a group id and a history item with no after', async () => {
    const data = await extractor.buildEventData(
      {
        event: 'taskAssigneeUpdated',
        task_id: '86a123',
        webhook_id: 'hook-1',
        history_items: [
          {
            id: '2800773800802162647',
            type: 1,
            date: '1642736652800',
            field: 'assignee_add',
            parent_id: '162641285',
            user: { id: 183, username: 'Alex', email: 'alex@example.com' },
            before: null,
            after: { id: 93748974, username: 'Sam', email: 'sam@example.com', initials: 'S' },
          },
          { id: 'h2', field: 'assignee_rem', before: { id: 183 } },
          { id: 'h3', field: 'assignee_add', after: { id: true } },
          { id: 'h4', field: 'assignee_add', after: { id: '  ' } },
          'not-an-item',
          null,
        ],
      },
      ctx,
    );
    // The actor (`user.id`) changed the task; only `after` gained it.
    expect(data.ownerIds).toEqual(['93748974']);
  });

  it('names nobody when the list is not a list', async () => {
    const data = await extractor.buildEventData(
      { event: 'taskAssigneeUpdated', history_items: { after: { id: 183 } } },
      ctx,
    );
    expect(data.ownerIds).toEqual([]);
  });

  it('fires "me" for the connected member only, and never on a removal', async () => {
    const mine = await extractor.buildEventData(delivery(added(183)), ctx);
    const theirs = await extractor.buildEventData(delivery(added(42)), ctx);
    const gone = await extractor.buildEventData(delivery(removed(183)), ctx);
    expect(matchesConditions({ assignee: 'me' }, mine, '183')).toBe(true);
    expect(matchesConditions({ assignee: 'me' }, theirs, '183')).toBe(false);
    expect(matchesConditions({ assignee: 'me' }, mine, undefined)).toBe(false);
    expect(matchesConditions({ assignee: 'me' }, gone, '183')).toBe(false);
    expect(matchesConditions({ assignee: 'anyone' }, theirs, '183')).toBe(true);
    expect(matchesConditions({ assignee: 'anyone' }, gone, '183')).toBe(false);
    expect(matchesConditions({}, gone, '183')).toBe(true);
  });
});
