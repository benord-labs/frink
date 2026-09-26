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

import { TRPCError } from '@trpc/server';
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_URL_LENGTH,
  MAX_ATTACHMENTS_PER_RUN,
  type RunAttachment,
} from '../../../shared/types/run-attachment';
import { getDatabase } from '../db';
import { getBatchStageRun, setStageRunStatus } from '../db/repos/batch-stage-runs';
import { MAX_IMAGE_BYTES, deleteAttachmentFile, writeAttachment } from './attachments-storage';

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

const isAllowedMime = (m: string): m is (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number] =>
  (ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(m);

export async function uploadAttachmentToStageRun(input: UploadInput): Promise<UploadResult> {
  if (!isAllowedMime(input.mimeType)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `mimeType must be one of ${ALLOWED_ATTACHMENT_MIME_TYPES.join(', ')}`,
    });
  }

  const db = getDatabase();
  const stageRun = await getBatchStageRun(db, input.runId);
  if (!stageRun) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Stage run not found' });
  }

  // Existing attachments cap (matches cloud).
  const triggerContext: Record<string, unknown> =
    (stageRun.triggerContext as Record<string, unknown> | null) ?? {};
  const existing = Array.isArray(triggerContext.attachments)
    ? (triggerContext.attachments as RunAttachment[])
    : [];
  if (existing.length >= MAX_ATTACHMENTS_PER_RUN) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `Stage run already has ${MAX_ATTACHMENTS_PER_RUN} attachments`,
    });
  }

  // Approximate decoded size from base64 length (overshoots by up to 2 bytes).
  const approxBytes = Math.floor((input.data.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) {
    throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: 'Image must be 5MB or smaller' });
  }

  const written = await writeAttachment(input.runId, input.filename, input.data);
  // Post-decode validation. Roll back the on-disk file before throwing — orphan
  // sweep operates at directory granularity and would never reclaim this file
  // alone if the run still exists.
  if (written.byteLength > MAX_IMAGE_BYTES) {
    await deleteAttachmentFile(input.runId, input.filename).catch(() => {});
    throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: 'Image must be 5MB or smaller' });
  }
  if (written.url.length > MAX_ATTACHMENT_URL_LENGTH) {
    await deleteAttachmentFile(input.runId, input.filename).catch(() => {});
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Attachment URL too long' });
  }

  const attachment: RunAttachment = {
    url: written.url,
    type: input.mimeType,
    label: input.filename,
    mimeType: input.mimeType,
  };
  const nextTriggerContext: Record<string, unknown> = {
    ...triggerContext,
    attachments: [...existing, attachment],
  };

  // Persist updated trigger_context. setStageRunStatus only updates status; reuse
  // it with the existing status to avoid adding a new repo function for a single
  // partial-update path.
  const nextStatus = stageRun.status as Parameters<typeof setStageRunStatus>[2];
  await setStageRunStatus(db, input.runId, nextStatus, stageRun.flowRunId ?? undefined);
  // Direct trigger_context patch via raw update — repo doesn't expose it yet; small inline.
  const { batchStageRuns } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');
  await db
    .update(batchStageRuns)
    .set({ triggerContext: nextTriggerContext })
    .where(eq(batchStageRuns.id, input.runId));

  return {
    url: written.url,
    filename: written.filename,
    run: { id: input.runId, trigger_context: nextTriggerContext },
  };
}
