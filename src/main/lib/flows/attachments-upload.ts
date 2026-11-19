/**
 * Run attachments. attachFileToStageRun copies a file from disk by path (any type, 20MB; a real
 * png/jpeg/webp under 5MB is still sent inline). uploadAndAttachImage runtime — decodes base64 bytes, persists under
 * userData/flow-attachments/<runId>/, appends a RunAttachment entry to the
 * batch_stage_run.trigger_context.attachments[] array, returns the cloud-shape
 * `{ url, filename, attachment, run: { id, trigger_context } }`; `attachment.type` comes from the bytes.
 *
 * Validation:
 * - mimeType must be in ALLOWED_ATTACHMENT_MIME_TYPES.
 * - Decoded bytes <= MAX_IMAGE_BYTES (5MB).
 * - The run is still pending (dispatch copies trigger_context only once).
 * - Existing attachments array length < MAX_ATTACHMENTS_PER_RUN (10).
 */

import { randomBytes } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { TRPCError } from '@trpc/server';
import { PASTED_FILE_MAX_BYTES, PASTED_FILE_TOO_LARGE } from '../../../shared/pasted-file-limits';
import { decodedBytes } from '../../../shared/utils/base64';
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_URL_LENGTH,
  MAX_ATTACHMENTS_PER_RUN,
  RUN_ATTACHMENT_FILE_TYPE,
  type RunAttachment,
} from '../../../shared/types/run-attachment';
import { IMAGE_SIGNATURE_BYTES, detectImage } from '../claude/pasted-files/image-signature';
import { getDatabase } from '../db';
import type { BatchStageRun } from '../db/schema';
import {
  type AppendAttachmentResult,
  appendStageRunAttachment,
  getBatchStageRun,
  type StageRunTriggerContext,
  stageRunTriggerContextSchema,
} from '../db/repos/batch-stage-runs';
import {
  MAX_IMAGE_BYTES,
  copyAttachment,
  deleteAttachmentFile,
  writeAttachment,
} from './attachments-storage';

export type UploadDeps = {
  db: ReturnType<typeof getDatabase>;
  writeAttachment: typeof writeAttachment;
  copyAttachment: typeof copyAttachment;
  deleteAttachmentFile: typeof deleteAttachmentFile;
};

const defaultDeps = (): UploadDeps => ({
  db: getDatabase(),
  writeAttachment,
  copyAttachment,
  deleteAttachmentFile,
});

type UploadInput = {
  flowId: string;
  runId: string;
  data: string;
  filename: string;
  mimeType: string;
};

type UploadResult = {
  url: string;
  filename: string;
  /** What was stored; `type` is the file kind read from the bytes, not the declared type. */
  attachment: RunAttachment;
  run: { id: string; trigger_context: StageRunTriggerContext };
};

const isAllowedMime = (m: string): m is (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number] =>
  (ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(m);

const UNSAFE_NAME_CHARS_RE = /[^A-Za-z0-9._-]/g;
const MAX_STORED_NAME_LENGTH = 128;
const MAX_EXTENSION_LENGTH = 16;

// Unique so same-named concurrent uploads (pasted `image.png`) never share a file.
// Sanitised and capped so real names fit; the extension drives the served MIME type.
function storedNameFor(filename: string): string {
  const safe = filename.replace(UNSAFE_NAME_CHARS_RE, '_');
  const dot = safe.lastIndexOf('.');
  const ext = dot > 0 ? safe.slice(dot).slice(0, MAX_EXTENSION_LENGTH) : '';
  const base = dot > 0 ? safe.slice(0, dot) : safe;
  const prefix = `${randomBytes(4).toString('hex')}-`;
  return `${prefix}${base.slice(0, MAX_STORED_NAME_LENGTH - prefix.length - ext.length)}${ext}`;
}

const capExceeded = () =>
  new TRPCError({
    code: 'CONFLICT',
    message: `Stage run already has ${MAX_ATTACHMENTS_PER_RUN} attachments`,
  });

const notPending = () =>
  new TRPCError({
    code: 'CONFLICT',
    message: 'Attachments can only be added before the run starts',
  });

const tooLarge = () =>
  new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: 'Image must be 5MB or smaller' });

/** Fast-fail before touching disk; the authoritative checks are in the transactional append. */
function rejectBeforeWrite(stageRun: BatchStageRun): void {
  if (stageRun.status !== 'pending') throw notPending();
  const current = stageRunTriggerContextSchema.safeParse(stageRun.triggerContext);
  if (current.success && current.data.attachments.length >= MAX_ATTACHMENTS_PER_RUN) {
    throw capExceeded();
  }
}

async function requireStageRun(db: UploadDeps['db'], runId: string): Promise<BatchStageRun> {
  const stageRun = await getBatchStageRun(db, runId);
  if (!stageRun) throw new TRPCError({ code: 'NOT_FOUND', message: 'Stage run not found' });
  rejectBeforeWrite(stageRun);
  return stageRun;
}

function appendRefusal(reason: Exclude<AppendAttachmentResult, { ok: true }>['reason']) {
  if (reason === 'cap') return capExceeded();
  if (reason === 'not_pending') return notPending();
  if (reason === 'invalid') {
    return new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Stage run attachments could not be read',
    });
  }
  return new TRPCError({ code: 'NOT_FOUND', message: 'Stage run not found' });
}

/** Append in one transaction; any refusal or error deletes this request's file first. */
async function appendOrRollback(
  db: UploadDeps['db'],
  runId: string,
  attachment: RunAttachment,
  rollback: () => Promise<void>,
): Promise<StageRunTriggerContext> {
  let appended: AppendAttachmentResult;
  try {
    appended = appendStageRunAttachment(db, runId, attachment, MAX_ATTACHMENTS_PER_RUN);
  } catch (err) {
    await rollback();
    throw err;
  }
  if (appended.ok) return appended.triggerContext;
  await rollback();
  throw appendRefusal(appended.reason);
}

export async function uploadAttachmentToStageRun(
  input: UploadInput,
  deps: UploadDeps = defaultDeps(),
): Promise<UploadResult> {
  if (!isAllowedMime(input.mimeType)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `mimeType must be one of ${ALLOWED_ATTACHMENT_MIME_TYPES.join(', ')}`,
    });
  }

  await requireStageRun(deps.db, input.runId);
  // Exact for well-formed base64; the post-decode check stays authoritative.
  if (decodedBytes(input.data) > MAX_IMAGE_BYTES) throw tooLarge();

  const storedName = storedNameFor(input.filename);
  const written = await deps.writeAttachment(input.runId, storedName, input.data);
  const rollback = () => deps.deleteAttachmentFile(input.runId, storedName).catch(() => {});
  // Post-decode validation. Roll back the on-disk file before throwing — orphan
  // sweep operates at directory granularity and would never reclaim this file
  // alone if the run still exists.
  if (written.byteLength > MAX_IMAGE_BYTES) {
    await rollback();
    throw tooLarge();
  }
  if (written.url.length > MAX_ATTACHMENT_URL_LENGTH) {
    await rollback();
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Attachment URL too long' });
  }

  // The bytes decide, not the declared type: anything that is not a real image is read by path.
  const head = Buffer.from(input.data.slice(0, BASE64_HEAD_CHARS), 'base64');
  const kind = kindFromImageType(detectImage(head));
  const attachment: RunAttachment = { url: written.url, label: input.filename, ...kind };
  // A crash before this commit leaves an unreferenced file for the startup sweep.
  const triggerContext = await appendOrRollback(deps.db, input.runId, attachment, rollback);
  return {
    url: written.url,
    filename: written.filename,
    attachment,
    run: { id: input.runId, trigger_context: triggerContext },
  };
}

/** Base64 characters that decode to the bytes every image signature needs (4 chars per 3 bytes). */
const BASE64_HEAD_CHARS = Math.ceil(IMAGE_SIGNATURE_BYTES / 3) * 4;

const badFile = (message: string) => new TRPCError({ code: 'BAD_REQUEST', message });
const UNREADABLE_FILE = "Frink couldn't open this file. Check it still exists and try again.";

/** Refuses anything at `sourcePath` that is not a readable file under the cap. */
async function rejectUnattachable(sourcePath: string): Promise<void> {
  if (!isAbsolute(sourcePath)) throw badFile('The file path must be absolute.');
  const source = await stat(sourcePath).catch(() => {
    throw badFile(UNREADABLE_FILE);
  });
  if (!source.isFile()) throw badFile("Folders can't be attached.");
  if (source.size > PASTED_FILE_MAX_BYTES) {
    throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: PASTED_FILE_TOO_LARGE });
  }
}

async function imageTypeOf(path: string): Promise<string | null> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(IMAGE_SIGNATURE_BYTES);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return detectImage(head.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

type AttachmentKind = Omit<RunAttachment, 'url' | 'label'>;

function kindFromImageType(image: string | null): AttachmentKind {
  if (image && isAllowedMime(image)) return { type: image, mimeType: image };
  return { type: RUN_ATTACHMENT_FILE_TYPE };
}

/** A real image small enough to send inline keeps going inline; anything else is read by path. */
async function kindOf(path: string, size: number): Promise<AttachmentKind> {
  return kindFromImageType(size <= MAX_IMAGE_BYTES ? await imageTypeOf(path) : null);
}

type AttachFileInput = { flowId: string; runId: string; sourcePath: string };

/** Copies a file from disk into the run, so its agent nodes can read it (CSV, PDF, text, …). */
export async function attachFileToStageRun(
  input: AttachFileInput,
  deps: UploadDeps = defaultDeps(),
): Promise<{ attachment: RunAttachment; run: UploadResult['run'] }> {
  await rejectUnattachable(input.sourcePath);
  await requireStageRun(deps.db, input.runId);

  const label = basename(input.sourcePath);
  const storedName = storedNameFor(label);
  const rollback = () => deps.deleteAttachmentFile(input.runId, storedName).catch(() => {});
  const written = await deps
    .copyAttachment(input.runId, storedName, input.sourcePath)
    .catch(async () => {
      await rollback();
      throw badFile(UNREADABLE_FILE);
    });
  if (written.byteLength > PASTED_FILE_MAX_BYTES) {
    await rollback();
    throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: PASTED_FILE_TOO_LARGE });
  }

  // Judged from the stored copy, so a file changed during the copy is classified as stored.
  const kind = await kindOf(written.path, written.byteLength).catch(async () => {
    await rollback();
    throw badFile(UNREADABLE_FILE);
  });
  const attachment: RunAttachment = { url: written.url, label, ...kind };
  const triggerContext = await appendOrRollback(deps.db, input.runId, attachment, rollback);
  return { attachment, run: { id: input.runId, trigger_context: triggerContext } };
}
