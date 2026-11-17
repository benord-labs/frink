import { z } from 'zod';
import { PROVIDERS } from '../../integrations/providers';
import { isPayloadDrivenWebhookProvider } from '../../integrations/selectors';
import type { PayloadDrivenWebhookProvider } from '../../integrations/types';
import type { PayloadExtractor, WebhookEventData } from './types';

/** The one extractor behind every webhook-only row. Nothing here knows a vendor: the row's
 * `webhook_payload` names the body paths and its events map vendor strings to user intents. */

/** A parsed JSON body as the receiver hands it over. */
type JsonValue = string | number | boolean | null | ReadonlyArray<JsonValue> | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);
/** What `JSON.parse` yields for an object body; the receiver narrows its parse through it. */
export const jsonObject: z.ZodType<JsonObject> = z.record(z.string(), jsonValue);

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value instanceof Object && !Array.isArray(value);
}

/** Read a dot path (lodash `get` semantics): any missing segment is undefined. */
function readPath(body: JsonObject, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = body;
  for (const segment of path.split('.')) {
    if (!isJsonObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** The string at a path, or undefined when the path is absent or names anything else. */
export function readPathString(body: JsonObject, path: string | undefined): string | undefined {
  const value = path === undefined ? undefined : z.string().safeParse(readPath(body, path));
  return value?.success ? value.data : undefined;
}

const ownerId = z.union([z.string().trim().min(1), z.number().transform(String)]);

/** The ids an assignee event names, as the strings the machine-side matcher compares: vendors send
 * numbers or strings, and an item without an id (a removal) names nobody. */
function readOwnerIds(
  body: JsonObject,
  spec: NonNullable<PayloadDrivenWebhookProvider['webhook_payload']['owner_ids']>,
): string[] {
  const list = readPath(body, spec.list_path);
  if (!Array.isArray(list)) return [];
  const ids = list.flatMap((item: JsonValue) => {
    const id = ownerId.safeParse(isJsonObject(item) ? readPath(item, spec.id_path) : undefined);
    return id.success ? [id.data] : [];
  });
  return [...new Set(ids)];
}

/** The row behind an endpoint's provider id, when the shared receiver owns it. */
export function webhookOnlyProvider(providerId: string): PayloadDrivenWebhookProvider | undefined {
  return PROVIDERS.filter(isPayloadDrivenWebhookProvider).find(
    (provider) => provider.id === providerId,
  );
}

export function pasteUrlExtractor(provider: PayloadDrivenWebhookProvider): PayloadExtractor {
  const { events, filter_fields: filters, webhook_payload: spec } = provider;
  const catchAll = events.find((event) => event.vendor_events === undefined);
  return {
    detectEventType(payload) {
      const body = jsonObject.safeParse(payload);
      if (!body.success) return null;
      const vendor = readPathString(body.data, spec.event_type_path);
      const named =
        vendor === undefined
          ? undefined
          : events.find((event) => event.vendor_events?.includes(vendor));
      return (named ?? catchAll)?.id ?? null;
    },
    async buildEventData(payload, ctx): Promise<WebhookEventData> {
      const body = jsonObject.safeParse(payload);
      const flat = body.success ? body.data : {};
      // Filter ids ARE the keys the machine-side matcher reads, so a declared path lands under
      // its id; spread the body first so every reserved key wins over a colliding body key.
      const fromPaths = filters.flatMap((field) =>
        field.path === undefined ? [] : [[field.id, readPath(flat, field.path)] as const],
      );
      // Only an event the row marks as carrying assignees names them: the same list holds other
      // changes on other events, whose ids are not people.
      const assignee = events.find((event) => event.id === ctx.eventType)?.assignee === true;
      const ownerIds = assignee && spec.owner_ids ? readOwnerIds(flat, spec.owner_ids) : undefined;
      // Both spellings, because the matcher reads the snake_case one first and the body is spread.
      const owners = ownerIds ? { owner_ids: ownerIds, ownerIds } : {};
      return {
        ...flat,
        ...Object.fromEntries(fromPaths),
        ...owners,
        eventType: ctx.eventType,
        provider: provider.id,
        externalUserId: ctx.externalUserId,
      };
    },
  };
}

const GENERIC_WEBHOOK = webhookOnlyProvider('generic_webhook');
if (!GENERIC_WEBHOOK) throw new Error('The provider catalog has no generic_webhook row.');
/** The registry's `generic` slot: the row with no vendor at all. */
export const genericExtractor = pasteUrlExtractor(GENERIC_WEBHOOK);
