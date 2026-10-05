/**
 * Local file storage for flow run attachments.
 *
 * Replaces the cloud blob upload + proxy URL — locally we store base64 image
 * bytes under `userData/flow-attachments/<runId>/<filename>` and surface them
 * via the `frink-attachment://<runId>/<filename>` custom protocol (registered
 * in attachments-protocol.ts).
 *
 * Path safety:
 * - runId / filename are validated to ensure no path traversal escapes the
 *   attachments root. Filenames containing `..`, `/`, or `\` are rejected.
 * - Reads resolve through `getAttachmentPath` which re-validates and ensures
 *   the resolved absolute path stays under the attachments root.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { app } from 'electron';

export const ATTACHMENT_PROTOCOL = 'frink-attachment';

const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;
const LEADING_SLASH_RE = /^\//;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const MIME_BY_EXT = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
]);

export class AttachmentPathError extends Error {
  constructor(detail: string) {
    super(`Invalid attachment path: ${detail}`);
    this.name = 'AttachmentPathError';
  }
}

/** Root of every run's attachment directory; callers may pass another root (tests). */
export function attachmentsRoot(): string {
  return join(app.getPath('userData'), 'flow-attachments');
}

function assertSafeSegment(segment: string, label: 'runId' | 'filename'): void {
  if (!segment || !SAFE_NAME_RE.test(segment)) {
    throw new AttachmentPathError(
      `${label} must match ${SAFE_NAME_RE} (got ${JSON.stringify(segment)})`,
    );
  }
}

function getAttachmentPath(runId: string, filename: string, root: string): string {
  assertSafeSegment(runId, 'runId');
  assertSafeSegment(filename, 'filename');
  const full = resolve(join(root, runId, filename));
  if (!isAbsolute(full) || !full.startsWith(`${resolve(root)}${sep}`)) {
    throw new AttachmentPathError(`resolved path escapes attachments root: ${full}`);
  }
  return full;
}

function buildAttachmentUrl(runId: string, filename: string): string {
  assertSafeSegment(runId, 'runId');
  assertSafeSegment(filename, 'filename');
  return `${ATTACHMENT_PROTOCOL}://${runId}/${filename}`;
}

const EXT_BY_MIME = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
]);

/** Unique on-disk name per upload; the client's filename is kept only as the label. */
export function storedAttachmentFilename(mimeType: string): string {
  const ext = EXT_BY_MIME.get(mimeType);
  return ext ? `${randomUUID()}.${ext}` : randomUUID();
}

/** Split a `frink-attachment://<runId>/<filename>` URL; null for foreign or unsafe URLs. */
export function parseAttachmentUrl(url: string): { runId: string; filename: string } | null {
  const prefix = `${ATTACHMENT_PROTOCOL}://`;
  if (!url.startsWith(prefix)) return null;
  const [runId, filename, ...rest] = url.slice(prefix.length).split('/');
  if (rest.length > 0 || !runId || !filename) return null;
  if (!SAFE_NAME_RE.test(runId) || !SAFE_NAME_RE.test(filename)) return null;
  return { runId, filename };
}

export type WriteAttachmentResult = {
  url: string;
  filename: string;
  byteLength: number;
};

export async function writeAttachment(
  runId: string,
  filename: string,
  base64Data: string,
  root = attachmentsRoot(),
): Promise<WriteAttachmentResult> {
  const target = getAttachmentPath(runId, filename, root);
  const buffer = Buffer.from(base64Data, 'base64');
  await mkdir(join(root, runId), { recursive: true });
  await writeFile(target, buffer);
  return { url: buildAttachmentUrl(runId, filename), filename, byteLength: buffer.byteLength };
}

export async function readAttachment(
  runId: string,
  filename: string,
  root = attachmentsRoot(),
): Promise<Buffer> {
  const target = getAttachmentPath(runId, filename, root);
  return readFile(target);
}

/** Media type of a stored attachment, from its filename extension. */
export function attachmentMimeType(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME_BY_EXT.get(filename.slice(dot + 1).toLowerCase()) ?? 'application/octet-stream';
}

export type ReadAttachmentImageResult =
  | { ok: true; mime: string; base64: string }
  | { ok: false; message: string };

/**
 * Read a `frink-attachment://<runId>/<filename>` URL as base64, capped at 5MB.
 * `message` is shown to the user as-is, so it is a whole sentence in plain words.
 */
export async function readAttachmentImage(
  rawUrl: string,
  root = attachmentsRoot(),
): Promise<ReadAttachmentImageResult> {
  let parsed: URL | undefined;
  try {
    parsed = new URL(rawUrl);
  } catch {
    parsed = undefined;
  }
  if (parsed?.protocol !== `${ATTACHMENT_PROTOCOL}:`) {
    return {
      ok: false,
      message: 'This is a link, not an image uploaded to the run — upload the image file instead',
    };
  }

  const filename = parsed.pathname.replace(LEADING_SLASH_RE, '');
  let buffer: Buffer;
  try {
    buffer = await readAttachment(parsed.hostname, filename, root);
  } catch {
    return {
      ok: false,
      message: 'Frink could not read this image on this computer — upload it again',
    };
  }
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    return { ok: false, message: 'This image is bigger than the 5MB limit' };
  }
  return { ok: true, mime: attachmentMimeType(filename), base64: buffer.toString('base64') };
}

/**
 * Delete a single attachment file (rollback on post-write validation failure).
 * No-op if file doesn't exist.
 */
export async function deleteAttachmentFile(
  runId: string,
  filename: string,
  root = attachmentsRoot(),
): Promise<void> {
  const target = getAttachmentPath(runId, filename, root);
  await rm(target, { force: true });
}
