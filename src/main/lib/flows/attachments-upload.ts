/**
 * uploadAndAttachImage runtime — decodes base64 bytes, persists under
 * userData/flow-attachments/<runId>/, appends a RunAttachment entry to the
 * batch_stage_run.trigger_context.attachments[] array, returns the cloud-shape
 * `{ url, filename, run: { id, trigger_context } }` the renderer expects.
 *
 * Validation:
 * - mimeType must be in ALLOWED_ATTACHMENT_MIME_TYPES.
 * - Decoded bytes <= MAX_IMAGE_BYTES (5MB).
 * - The run is still pending (dispatch copies trigger_context only once).
 * - Existing attachments array length < MAX_ATTACHMENTS_PER_RUN (10).
 */

import { TRPCError } from '@trpc/server';
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_URL_LENGTH,
  MAX_ATTACHMENTS_PER_RUN,
  type RunAttachment,
} from '../../../shared/types/run-attachment';
import { getDatabase } from '../db';
import {
  type AppendRunAttachmentResult,
  appendRunAttachment,
  getBatchStageRun,
  parseRunTriggerContext,
} from '../db/repos/batch-stage-runs';
import {
  MAX_IMAGE_BYTES,
  deleteAttachmentFile,
  storedAttachmentFilename,
  writeAttachment,
} from './attachments-storage';

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
  run: { id: string; trigger_context: Record<string, unknown> };
};

export type UploadDeps = {
  db: ReturnType<typeof getDatabase>;
  /** Attachments root; storage defaults to userData when omitted. */
  root?: string;
  write: typeof writeAttachment;
  append: typeof appendRunAttachment;
};

const CAP_MESSAGE = `Stage run already has ${MAX_ATTACHMENTS_PER_RUN} attachments`;
const NOT_PENDING_MESSAGE = 'Attachments can only be added before the run starts';

const isAllowedMime = (m: string): m is (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number] =>
  (ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(m);

export async function uploadAttachmentToStageRun(
  input: UploadInput,
  deps: UploadDeps = { db: getDatabase(), write: writeAttachment, append: appendRunAttachment },
): Promise<UploadResult> {
  if (!isAllowedMime(input.mimeType)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `mimeType must be one of ${ALLOWED_ATTACHMENT_MIME_TYPES.join(', ')}`,
    });
  }

  const { db, root } = deps;
  const stageRun = await getBatchStageRun(db, input.runId);
  if (!stageRun) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Stage run not found' });
  }

  // Fast-path rejections; appendRunAttachment re-checks both atomically.
  if (stageRun.status !== 'pending') {
    throw new TRPCError({ code: 'CONFLICT', message: NOT_PENDING_MESSAGE });
  }
  const existingCount = parseRunTriggerContext(stageRun.triggerContext).attachments?.length ?? 0;
  if (existingCount >= MAX_ATTACHMENTS_PER_RUN) {
    throw new TRPCError({ code: 'CONFLICT', message: CAP_MESSAGE });
  }

  // Approximate decoded size from base64 length (overshoots by up to 2 bytes).
  const approxBytes = Math.floor((input.data.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) {
    throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: 'Image must be 5MB or smaller' });
  }

  // Unique per request, so every rollback below deletes only this request's file.
  const storedName = storedAttachmentFilename(input.mimeType);
  const written = await deps.write(input.runId, storedName, input.data, root);
  const rollback = () => deleteAttachmentFile(input.runId, storedName, root).catch(() => {});

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

  let result: AppendRunAttachmentResult;
  try {
    result = deps.append(db, input.runId, attachment, MAX_ATTACHMENTS_PER_RUN);
  } catch (err) {
    await rollback();
    throw err;
  }
  if (result.kind !== 'ok') {
    await rollback();
    if (result.kind === 'not_found') {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Stage run not found' });
    }
    throw new TRPCError({
      code: 'CONFLICT',
      message: result.kind === 'not_pending' ? NOT_PENDING_MESSAGE : CAP_MESSAGE,
    });
  }

  return {
    url: written.url,
    filename: written.filename,
    run: { id: input.runId, trigger_context: result.triggerContext },
  };
}
