import type { Provider } from './types';

/** An endpoint secret is 64 hex chars. A Standard Webhooks vendor takes it as `whsec_` + base64 of
 * the same bytes, and both sides decode the hex here, so they can never disagree on the key. */
export function standardWebhooksKey(hexSecret: string): Uint8Array {
  return Uint8Array.from({ length: hexSecret.length / 2 }, (_, index) =>
    Number.parseInt(hexSecret.slice(2 * index, 2 * index + 2), 16),
  );
}

/** The endpoint secret as a vendor's "Signing secret" field takes it. */
export function standardWebhooksSecret(hexSecret: string): string {
  return `whsec_${btoa(String.fromCharCode(...standardWebhooksKey(hexSecret)))}`;
}

/** Imported vendor keys retain the exact configured URL, needed by Square's signature. A machine
 * that answers on its own loopback door has an `http` address and is no less its owner's. */
export function importedWebhookUrl(
  providerId: string,
  vendorRef: string | null | undefined,
): string | undefined {
  const url = vendorRef?.startsWith(`manual:${providerId}:`)
    ? vendorRef.slice(`manual:${providerId}:`.length)
    : '';
  return /^https?:\/\//.test(url) ? url : undefined;
}

export function isImportedWebhookSecret(
  provider: Provider,
  vendorRef: string | null | undefined,
): boolean {
  return Boolean(provider.webhook_setup?.secret && importedWebhookUrl(provider.id, vendorRef));
}
