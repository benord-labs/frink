// Reason: Expo dependencies are installed in mobile; isolated types and iOS export verify this import.
// fallow-ignore-next-line unresolved-import
import { z } from 'zod';
import {
  MOBILE_API_VERSION,
  mobilePairingFields,
  mobilePairingSchema,
} from '@frink/shared/types/remote/mobile';
import type {
  MobileAttachment,
  MobileRequest,
  MobileResponses,
} from '@frink/shared/types/remote/mobile';
import type {
  NotificationRegistration,
  NotificationStatus,
} from '@frink/shared/types/remote/notifications';

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
          : 'Frink on your Mac couldn’t complete this. Try again in a moment.',
        response.status,
      );
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      'Can’t reach your Mac. Check Tailscale is on and Frink is open. If you just sent something, refresh before trying again — it may have arrived.',
      0,
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export function parsePairing(text: string) {
  try {
    return mobilePairingSchema.parse(mobilePairingFields(text.trim()));
  } catch {
    throw new Error('Paste or scan the full pairing code from Settings → Mobile in Frink.');
  }
}

export async function pairComputer(text: string, name: string): Promise<Connection> {
  const pairing = parsePairing(text);
  const result = await post(`${pairing.url.replace(/\/$/, '')}/pair`, { code: pairing.code, name });
  if (result.apiVersion !== MOBILE_API_VERSION)
    throw new Error('Update Frink on your Mac and this iPhone so they match.');
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

/** Reads this iPhone's alert registration on the Mac; a `token` registers it, `null` removes it. */
export async function requestNotifications(
  connection: Connection,
  input: NotificationRegistration,
  signal?: AbortSignal,
): Promise<NotificationStatus> {
  const url = `${connection.url.replace(/\/$/, '')}/api/notifications`;
  return (await post(url, input, connection.token, signal)).data;
}

/** Uploads over a cellular link can be slow; the Mac allows up to two minutes. */
const UPLOAD_TIMEOUT_MS = 90_000;

/**
 * Sends one picked file as a raw body (no base64), returning the id `sendMessage` references.
 * `uri` is a local file (native) or blob URL (web); either is read with fetch.
 */
export async function uploadAttachment(
  connection: Connection,
  target: { chatId: string; subChatId: string },
  file: { uri: string; name: string; mimeType?: string | null },
  signal?: AbortSignal,
): Promise<MobileAttachment> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort);
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, UPLOAD_TIMEOUT_MS);
  try {
    const body = await (await fetch(file.uri)).blob();
    const response = await fetch(`${connection.url.replace(/\/$/, '')}/api/attachments`, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'Content-Type': file.mimeType || 'application/octet-stream',
        Authorization: `Bearer ${connection.token}`,
        'X-Frink-Chat': target.chatId,
        'X-Frink-Sub-Chat': target.subChatId,
        'X-Frink-Filename': encodeURIComponent(file.name),
      },
      body,
    });
    const result = await response.json();
    if (!response.ok)
      throw new ApiError(
        typeof result.error === 'string' ? result.error : 'Frink on your Mac couldn’t save this file.',
        response.status,
      );
    return result.data as MobileAttachment;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('Could not upload. Check your connection and try again.', 0);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
