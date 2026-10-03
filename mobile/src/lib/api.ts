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

import { closeMobileRelay, relayRequest, type RelayTarget } from './relay/client';
import { ApiError, unreachable } from './relay/error';
export { ApiError } from './relay/error';

export const connectionSchema = mobilePairingSchema
  .pick({ relay: true, route: true, key: true })
  .extend({
    token: z.string().min(32),
    deviceId: z.string().min(1),
    machineName: z.string().min(1),
  });
export type Connection = z.infer<typeof connectionSchema>;

/** A reply that isn't JSON is reported like any other failed round trip, never as a SyntaxError. */
function parseResponse(body: Uint8Array) {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw unreachable();
  }
}

async function post(
  target: RelayTarget,
  path: '/pair' | '/api' | '/api/notifications' | '/api/attachments',
  body: Uint8Array,
  headers: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs?: number,
) {
  const response = await relayRequest(target, path, headers, body, signal, timeoutMs);
  const result = parseResponse(response.body);
  if (response.status < 200 || response.status >= 300)
    throw new ApiError(
      typeof result.error === 'string' ? result.error : 'Frink on your Mac couldn’t complete this.',
      response.status,
    );
  return result;
}

function jsonPost(
  target: RelayTarget,
  path: '/pair' | '/api' | '/api/notifications',
  body: unknown,
  token?: string,
  signal?: AbortSignal,
) {
  return post(
    target,
    path,
    new TextEncoder().encode(JSON.stringify(body)),
    {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal,
  );
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
  closeMobileRelay();
  const result = await jsonPost(pairing, '/pair', { code: pairing.code, name });
  if (result.apiVersion !== MOBILE_API_VERSION)
    throw new Error('Update Frink on your Mac and this iPhone so they match.');
  return connectionSchema.parse({ ...pairing, ...result });
}

export async function requestMobile<T extends MobileRequest>(
  connection: Connection,
  request: T,
  signal?: AbortSignal,
): Promise<MobileResponses[T['type']]> {
  const result = await jsonPost(connection, '/api', request, connection.token, signal);
  return result.data;
}

/** Reads this iPhone's alert registration on the Mac; a `token` registers it, `null` removes it. */
export async function requestNotifications(
  connection: Connection,
  input: NotificationRegistration,
  signal?: AbortSignal,
): Promise<NotificationStatus> {
  return (await jsonPost(connection, '/api/notifications', input, connection.token, signal)).data;
}

/** Reads a local file, then sends bounded encrypted chunks to the desktop. */
export async function uploadAttachment(
  connection: Connection,
  target: { chatId: string; subChatId: string },
  file: { uri: string; name: string; mimeType?: string | null },
  signal?: AbortSignal,
): Promise<MobileAttachment> {
  try {
    const response = await fetch(file.uri, { signal });
    const blob = await response.blob();
    if (blob.size > 20 * 1024 * 1024) throw new ApiError('Choose a file smaller than 20 MB.', 413);
    const body = new Uint8Array(await new Response(blob).arrayBuffer());
    return (
      await post(
        connection,
        '/api/attachments',
        body,
        {
          'Content-Type': file.mimeType || 'application/octet-stream',
          Authorization: `Bearer ${connection.token}`,
          'X-Frink-Chat': target.chatId,
          'X-Frink-Sub-Chat': target.subChatId,
          'X-Frink-Filename': encodeURIComponent(file.name),
        },
        signal,
        90_000,
      )
    ).data as MobileAttachment;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unreachable();
  }
}
