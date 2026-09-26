/**
 * Trigger-context attachment images for a task prompt: read at claim time from the
 * run's attachment store and converted to base64 for the provider send.
 */

import { ALLOWED_ATTACHMENT_MIME_TYPES } from '../../../shared/types/run-attachment';
import type { TaskChatImageAttachment } from '../../../shared/types/task-chat-ready';
import { readAttachmentImage } from '../flows/attachments-storage';

const ALLOWED_IMAGE_CONTENT_TYPES = new Set<string>(ALLOWED_ATTACHMENT_MIME_TYPES);

type AttachmentFetchOutcome =
  | { ok: true; image: TaskChatImageAttachment }
  | { ok: false; warning: string };

/**
 * Read a single image attachment and convert to base64. Returns a discriminated union so
 * callers can separate successes from warnings without throwing.
 */
async function loadSingleAttachmentImage(
  a: Record<string, unknown>,
): Promise<AttachmentFetchOutcome> {
  const label = typeof a.label === 'string' && a.label.length > 0 ? a.label : (a.url as string);

  // SAFETY: fetchAttachmentImages only forwards items whose `url` is a string.
  const read = await readAttachmentImage(a.url as string);
  if (!read.ok) {
    return { ok: false, warning: `⚠️ Attached image "${label}" was not sent: ${read.message}.` };
  }

  // The type recorded at upload wins over the one guessed from the extension: a JPEG
  // named .jfif is still a JPEG. Gate and send the same value.
  const contentType = read.mime;
  const mediaType =
    typeof a.mimeType === 'string' && a.mimeType.length > 0 ? a.mimeType : contentType;
  if (!ALLOWED_IMAGE_CONTENT_TYPES.has(mediaType)) {
    return {
      ok: false,
      warning: `⚠️ Attached image "${label}" is not a supported image type (${mediaType}). Skipped.`,
    };
  }

  return {
    ok: true,
    image: {
      base64Data: read.base64,
      mediaType,
      ...(typeof a.label === 'string' && a.label.length > 0 ? { filename: a.label } : {}),
    },
  };
}

/**
 * Read all image attachments from trigger_context.attachments concurrently and convert to base64.
 * One slow or failed item does not block others. On failure, appends a warning to promptWarnings.
 */
export async function fetchAttachmentImages(
  attachments: unknown,
  promptWarnings: string[],
): Promise<TaskChatImageAttachment[]> {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];

  const items = attachments.filter((item): item is Record<string, unknown> => {
    if (typeof item !== 'object' || item === null) return false;
    const a = item as Record<string, unknown>;
    return typeof a.url === 'string';
  });

  if (items.length === 0) return [];

  const outcomes = await Promise.all(items.map(loadSingleAttachmentImage));

  const results: TaskChatImageAttachment[] = [];
  for (const outcome of outcomes) {
    if (outcome.ok) {
      results.push(outcome.image);
    } else {
      promptWarnings.push(outcome.warning);
    }
  }
  return results;
}
