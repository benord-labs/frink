/** One bearer-authenticated JSON call to a vendor API, parsed at the boundary and refused in the words the card shows. */
import type { z } from 'zod';
import { beforeTriggerVendorRequest } from './operation';
import type { JsonValue } from '../../../../shared/types/permissions';

const VENDOR_TIMEOUT_MS = 15_000;

/** A vendor refusal or outage: `reason` is for the user, `message` is the raw detail for Sentry. */
export class VendorRequestError extends Error {
  constructor(
    readonly reason: string,
    detail: string,
    readonly status?: number,
  ) {
    super(detail);
    this.name = 'VendorRequestError';
  }
}

type VendorRequest = {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  token: string;
  authScheme?: 'bearer' | 'raw';
  json?: JsonValue;
};

/** A 404 is `null` so callers can treat "already gone" as done; every other refusal throws. */
export async function vendorJson<T>(
  vendor: string,
  url: string,
  request: VendorRequest,
  schema: z.ZodType<T>,
): Promise<T | null> {
  await beforeTriggerVendorRequest();
  const headers = new Headers({
    Authorization: request.authScheme === 'raw' ? request.token : `Bearer ${request.token}`,
  });
  if (request.json !== undefined) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method,
      headers,
      body: request.json === undefined ? undefined : JSON.stringify(request.json),
      signal: AbortSignal.timeout(VENDOR_TIMEOUT_MS),
    });
  } catch (error) {
    throw new VendorRequestError(`Frink couldn't reach ${vendor}.`, String(error));
  }
  if (response.status === 404) return null;
  if (response.status === 401 || response.status === 403) {
    throw new VendorRequestError(
      `${vendor} didn't accept Frink's access. Reconnect ${vendor} and try again.`,
      `${request.method} ${url} → ${response.status}`,
      response.status,
    );
  }
  if (!response.ok) {
    throw new VendorRequestError(
      `${vendor} returned an error (HTTP ${response.status}).`,
      `${request.method} ${url} → ${response.status} ${await response.text().catch(() => '')}`,
      response.status,
    );
  }
  return schema.parse(await response.json());
}
