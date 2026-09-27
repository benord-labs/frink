// Reason: Expo dependencies are installed in mobile; isolated types and iOS export verify this import.
// fallow-ignore-next-line unresolved-import
import { z } from 'zod';
import { MOBILE_API_VERSION, mobilePairingSchema } from '../../../src/shared/types/remote/mobile';
import type { MobileRequest, MobileResponses } from '../../../src/shared/types/remote/mobile';

export const connectionSchema = z.object({
  url: mobilePairingSchema.shape.url,
  token: z.string().min(32),
  deviceId: z.string().min(1),
  machineName: z.string().min(1),
});
export type Connection = z.infer<typeof connectionSchema>;
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function post(url: string, body: unknown, token?: string, signal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort);
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, 20000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok)
      throw new ApiError(
        typeof result.error === 'string'
          ? result.error
          : 'Your computer could not complete this request.',
        response.status,
      );
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      'Cannot reach your computer. Check Tailscale and keep Frink open. If you sent an action, refresh before trying again; it may have reached your computer.',
      0,
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export function parsePairing(text: string) {
  try {
    return mobilePairingSchema.parse(JSON.parse(text.trim()));
  } catch {
    throw new Error('Paste or scan the full pairing code from Settings → Mobile in Frink.');
  }
}

export async function pairComputer(text: string, name: string): Promise<Connection> {
  const pairing = parsePairing(text);
  const result = await post(`${pairing.url.replace(/\/$/, '')}/pair`, { code: pairing.code, name });
  if (result.apiVersion !== MOBILE_API_VERSION)
    throw new Error('Update Frink on your computer and phone to compatible versions.');
  return connectionSchema.parse({ ...result, url: pairing.url });
}

export async function requestMobile<T extends MobileRequest>(
  connection: Connection,
  request: T,
  signal?: AbortSignal,
): Promise<MobileResponses[T['type']]> {
  const result = await post(
    `${connection.url.replace(/\/$/, '')}/api`,
    request,
    connection.token,
    signal,
  );
  return result.data;
}
