// Normalized event a provider extractor produces. Forwarded to the machine
// (over the socket) where it is matched against local flow graphs — keep in sync
// with `src/shared/lib/webhook-match.ts`'s `WebhookEventData`.
export type WebhookEventData = {
  eventType: string;
  provider: string;
  externalUserId: string;
  // Event-specific fields for condition matching (storyName, owner_ids, …).
  [key: string]: unknown;
};

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface ExtractorContext {
  integrationId: string;
  // Absent on a host that has no accounts; no extractor reads it.
  userId?: string;
  // Resolved event type from detectEventType. Caller MUST run detectEventType first
  // and pass its non-null result here. buildEventData branches on this.
  eventType: string;
  // External (provider-side) user id for this integration. WebhookEventData requires it.
  externalUserId: string;
  apiToken?: string;
  // Some providers' event-type detection requires HTTP headers, not payload shape.
  // GitHub reads X-GitHub-Event header. Caller passes the request headers through to
  // detectEventType — not used by buildEventData.
  headers?: WebhookHeaders;
}

export interface PayloadExtractor {
  // Headers passed when the provider's detection lives in HTTP metadata (e.g. GitHub's
  // X-GitHub-Event). Providers that detect from payload alone (Shortcut/Slack)
  // ignore the param. Returning null = unsupported event for this provider.
  detectEventType(payload: unknown, headers?: WebhookHeaders): string | null;
  // Gmail extractor convention: handler resolves Pub/Sub notification → fetches
  // gmail_v1.Schema$Message via Gmail API → passes the resolved message as `payload`.
  // Other providers receive the raw webhook body as `payload`.
  buildEventData(payload: unknown, ctx: ExtractorContext): Promise<WebhookEventData>;
}
