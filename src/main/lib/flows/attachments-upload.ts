/**
 * uploadAndAttachImage runtime — decodes base64 bytes, persists under
 * userData/flow-attachments/<runId>/, appends a RunAttachment entry to the
 * batch_stage_run.trigger_context.attachments[] array, returns the cloud-shape
 * `{ url, filename, run: { id, trigger_context } }` the renderer expects.
 *
 * Validation:
 * - mimeType must be in ALLOWED_ATTACHMENT_MIME_TYPES.
 * - Decoded bytes <= MAX_IMAGE_BYTES (5MB).
 * - Existing attachments array length < MAX_ATTACHMENTS_PER_RUN (10).
 */

import { randomBytes } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_URL_LENGTH,
  MAX_ATTACHMENTS_PER_RUN,
  type RunAttachment,
} from '../../../shared/types/run-attachment';
import { getDatabase } from '../db';
import {
  appendStageRunAttachment,
  getBatchStageRun,
  type StageRunTriggerContext,
  stageRunTriggerContextSchema,
} from '../db/repos/batch-stage-runs';
import { MAX_IMAGE_BYTES, deleteAttachmentFile, writeAttachment } from './attachments-storage';

export type UploadDeps = {
  db: ReturnType<typeof getDatabase>;
  writeAttachment: typeof writeAttachment;
  deleteAttachmentFile: typeof deleteAttachmentFile;
};

const defaultDeps = (): UploadDeps => ({
  db: getDatabase(),
  writeAttachment,
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

  const { db } = deps;
  const stageRun = await getBatchStageRun(db, input.runId);
  if (!stageRun) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Stage run not found' });
  }

  // Fast-fail before touching disk; the authoritative cap check is the
  // transactional append below.
  const current = stageRunTriggerContextSchema.safeParse(stageRun.triggerContext);
  if (current.success && current.data.attachments.length >= MAX_ATTACHMENTS_PER_RUN) {
    throw capExceeded();
  }

  // Approximate decoded size from base64 length (overshoots by up to 2 bytes).
  const approxBytes = Math.floor((input.data.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) {
    throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: 'Image must be 5MB or smaller' });
  }

  const storedName = storedNameFor(input.filename);
  const written = await deps.writeAttachment(input.runId, storedName, input.data);
  const rollback = () => deps.deleteAttachmentFile(input.runId, storedName).catch(() => {});
  // Post-decode validation. Roll back the on-disk file before throwing — orphan
  // sweep operates at directory granularity and would never reclaim this file
  // alone if the run still exists.
  if (written.byteLength > MAX_IMAGE_BYTES) {
    await rollback();
    throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: 'Image must be 5MB or smaller' });
  }
  if (written.url.length > MAX_ATTACHMENT_URL_LENGTH) {
    await rollback();
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Attachment URL too long' });
  }

  const attachment: RunAttachment = {
    url: written.url,
    type: input.mimeType,
    label: input.filename,
    mimeType: input.mimeType,
  };
  // A crash before this commit strands the file until the run is deleted and swept.
  const appended = appendStageRunAttachment(db, input.runId, attachment, MAX_ATTACHMENTS_PER_RUN);
  if (!appended.ok) {
    await rollback();
    if (appended.reason === 'cap') throw capExceeded();
    if (appended.reason === 'invalid') {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Stage run attachments could not be read',
      });
    }
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Stage run not found' });
  }

  return {
    url: written.url,
    filename: written.filename,
    run: { id: input.runId, trigger_context: appended.triggerContext },
  };
}
