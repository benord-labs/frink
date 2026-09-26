import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MessagePart } from '../client';

export type ExtractedImagePart = {
  base64Data: string;
  mediaType: string;
};

export const isImageMime = (mime: unknown): mime is string =>
  typeof mime === 'string' && mime.startsWith('image/');

/** The inline base64 image for one `file` part, or null — empty data is malformed, not an image. */
function fileImagePart(p: MessagePart): ExtractedImagePart | null {
  if (!isImageMime(p.mimeType)) return null;
  const mediaType = p.mimeType;
  if (typeof p.data === 'string' && p.data.length > 0) {
    return { base64Data: p.data, mediaType };
  }
  return null;
}

/** The already-resolved image for one `data-image` part, or null. Also used for a
 * persisted-transcript part of the same shape (e.g. task-executor/trailing-reply.ts). */
export function dataImagePart(p: MessagePart): ExtractedImagePart | null {
  if (!p.data || typeof p.data !== 'object') return null;
  const d = p.data as { base64Data?: string; mediaType?: string };
  return d.base64Data && isImageMime(d.mediaType)
    ? { base64Data: d.base64Data, mediaType: d.mediaType }
    : null;
}

/**
 * Extract image parts from userMessageParts (type 'file' or 'data-image')
 * so we can send them to the Claude SDK.
 */
export function extractImagePartsFromMessage(
  parts: MessagePart[] | undefined,
): ExtractedImagePart[] {
  if (!parts?.length) return [];
  const images: ExtractedImagePart[] = [];
  for (const p of parts) {
    if (p.type === 'file') {
      const filePart = fileImagePart(p);
      if (filePart) images.push(filePart);
    } else if (p.type === 'data-image') {
      const dataPart = dataImagePart(p);
      if (dataPart) images.push(dataPart);
    }
  }
  return images;
}

/**
 * Write image parts to temp files and return their absolute paths.
 * Used for Codex, which accepts image file paths in the prompt (agent reads via tool calling).
 * Caller should delete the returned paths when done (e.g. in finally).
 */
export function writeImagePartsToTempFiles(imageParts: ExtractedImagePart[]): string[] {
  if (imageParts.length === 0) return [];
  const dir = os.tmpdir();
  const paths: string[] = [];
  for (let i = 0; i < imageParts.length; i++) {
    const img = imageParts[i];
    const ext = img.mediaType === 'image/jpeg' || img.mediaType === 'image/jpg' ? '.jpg' : '.png';
    const name = `frink-upload-${Date.now()}-${i}-${crypto.randomUUID().slice(0, 8)}${ext}`;
    const filePath = path.join(dir, name);
    const buf = Buffer.from(img.base64Data, 'base64');
    fs.writeFileSync(filePath, buf);
    paths.push(filePath);
  }
  return paths;
}
