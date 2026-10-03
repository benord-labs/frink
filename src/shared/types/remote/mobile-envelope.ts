import { z } from 'zod';

/** Decoded body bytes per part, so a part's JSON stays well under the relay's 256 KiB frame cap. */
export const MOBILE_ENVELOPE_PART_BYTES = 128 * 1024;
export const MOBILE_ENVELOPE_PATHS = [
  '/pair',
  '/api',
  '/api/notifications',
  '/api/attachments',
] as const;

const id = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Bytes a base64 string decodes to, from its length and padding alone. */
function decodedBytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}
const body = z
  .base64()
  .max(Math.ceil(MOBILE_ENVELOPE_PART_BYTES / 3) * 4)
  .refine((value) => decodedBytes(value) <= MOBILE_ENVELOPE_PART_BYTES);

/**
 * One HTTP exchange travels as parts inside the encrypted channel. The first request part names
 * the path and headers, the first response part the status; `end` marks the last part.
 */
export const mobileEnvelopeSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('req'),
    id,
    path: z.enum(MOBILE_ENVELOPE_PATHS).optional(),
    headers: z
      .record(z.string().max(64), z.string().max(1024))
      .refine((headers) => Object.keys(headers).length <= 16)
      .optional(),
    body,
    end: z.boolean(),
  }),
  z.object({
    t: z.literal('res'),
    id,
    status: z.number().int().min(100).max(599).optional(),
    body,
    end: z.boolean(),
  }),
  z.object({ t: z.literal('cancel'), id }),
]);

export type MobileEnvelope = z.infer<typeof mobileEnvelopeSchema>;
type BodyPart = { body: string; end: boolean };

/** Splits a body into base64 parts of at most MOBILE_ENVELOPE_PART_BYTES; empty bodies are one part. */
export function envelopeBodyParts(bytes: Uint8Array): BodyPart[] {
  if (bytes.length === 0) return [{ body: '', end: true }];
  const parts: BodyPart[] = [];
  for (let offset = 0; offset < bytes.length; offset += MOBILE_ENVELOPE_PART_BYTES) {
    const next = Math.min(offset + MOBILE_ENVELOPE_PART_BYTES, bytes.length);
    parts.push({ body: toBase64(bytes.subarray(offset, next)), end: next === bytes.length });
  }
  return parts;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
