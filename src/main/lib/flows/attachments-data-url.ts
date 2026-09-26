/**
 * Data-URL form of a stored attachment, for the renderer's preview thumbnail and
 * lightbox — they receive the bytes over tRPC rather than the custom protocol.
 */

import { readAttachmentImage } from './attachments-storage';

export type ResolveAttachmentResult =
  | { ok: true; dataUrl: string }
  | { ok: false; message: string };

export async function resolveAttachmentToDataUrl(rawUrl: string): Promise<ResolveAttachmentResult> {
  const read = await readAttachmentImage(rawUrl);
  if (!read.ok) return read;
  return { ok: true, dataUrl: `data:${read.mime};base64,${read.base64}` };
}
