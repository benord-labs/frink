import type { WebhookHeaders } from './types';

/**
 * Read a single value out of an HTTP webhook headers map. GitHub webhooks reach the
 * extractor via this path (X-GitHub-Event), and Node normalizes header keys to
 * lowercase per HTTP convention. Multi-valued headers (array form) collapse to the
 * first element — GitHub never multi-valued the event header, but the shape leaks in
 * from Node's `IncomingMessage.headers` typing.
 */
export function getWebhookHeader(headers: WebhookHeaders | undefined, name: string): string | null {
  if (!headers) return null;
  const value = headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}
