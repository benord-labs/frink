/**
 * The typed replies a resumed session has never seen: user messages AFTER the sub-chat's
 * last delivery boundary — its newest assistant message OR persisted hidden-wake send,
 * whichever is later. A terminal run's declined sends land exactly there (persisted by
 * the send pipeline, never streamed), so the continuation turn delivers them — the
 * user's own words and pasted images — instead of the synthetic nudge. Reading the
 * transcript at claim time (rather than pinning a message id through the admission
 * intent) also makes multiple pre-admission sends ride together and needs no
 * intent-contract change.
 */

import { isHiddenWakeMessage } from '../../../shared/lib/message-markers/hidden-wake-marker';
import type { TaskChatImageAttachment } from '../../../shared/types/task-chat-ready';
import type { Message } from '../db/repos/sub-chats';
import type { MessagePart } from '../socket/client';
import { dataImagePart, isImageMime } from '../socket/streaming/image-parts';

export type TrailingReply = { text: string; images: TaskChatImageAttachment[] };

function partText(part: unknown): string | null {
  const p = part as { type?: unknown; text?: unknown } | null;
  return p?.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0
    ? p.text
    : null;
}

/**
 * Reuses the sibling reader's encoding validation (socket/streaming/image-parts.ts): inline
 * base64 is the only shape a chat image ever has (decision chat-image-transport).
 */
function partImage(part: unknown): TaskChatImageAttachment | null {
  const p = part as MessagePart | null;
  if (!p) return null;
  if (p.type === 'file' && isImageMime(p.mimeType) && typeof p.data === 'string' && p.data) {
    return { base64Data: p.data, mediaType: p.mimeType };
  }
  if (p.type === 'data-image') {
    const resolved = dataImagePart(p);
    const filename = (p.data as { filename?: unknown } | undefined)?.filename;
    return resolved ? { ...resolved, ...(typeof filename === 'string' ? { filename } : {}) } : null;
  }
  return null;
}

/**
 * A delivery boundary proves everything before it already reached a session: an
 * assistant message (the session responded) or a persisted hidden-wake send (a prior
 * continuation dispatch carried every reply before it as its prompt). Without the wake
 * half, a continuation round that crashes pre-stream would leave its reply looking
 * un-delivered, and the NEXT round would resend it verbatim alongside the new one.
 * The marker is trustworthy as a classifier because typed input can never carry it —
 * every human intake strips a leading marker before send (the composer's useMessageSend,
 * FlowReplyBox, and ParkAnswerSurface's structured answers).
 */
function isDeliveryBoundary(message: Message): boolean {
  if (message.role === 'assistant') return true;
  if (message.role !== 'user') return false;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts.map(partText).some((t) => t !== null && isHiddenWakeMessage(t));
}

export function extractTrailingUserReply(messages: Message[]): TrailingReply | null {
  let lastBoundary = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isDeliveryBoundary(messages[i])) {
      lastBoundary = i;
      break;
    }
  }
  // No boundary at all = a first-turn crash after session init, before any assistant
  // token or dispatched wake. The transcript's FIRST user message is then the turn's own
  // kick-off prompt — already held by the resumed session, NOT a typed reply — but a
  // user message typed AFTER it is genuine and must ride.
  const boundary = lastBoundary >= 0 ? lastBoundary : 0;
  const texts: string[] = [];
  const images: TaskChatImageAttachment[] = [];
  for (const message of messages.slice(boundary + 1)) {
    if (message.role !== 'user') continue;
    const parts = Array.isArray(message.parts) ? message.parts : [];
    texts.push(...parts.map(partText).filter((t): t is string => t !== null));
    for (const part of parts) {
      const image = partImage(part);
      if (image) images.push(image);
    }
  }
  const text = texts.join('\n\n').trim();
  if (text.length === 0 && images.length === 0) return null;
  // An image-only reply still needs a textual turn — a neutral line, never the generic
  // error nudge (the user DID reply; their attachment is the content).
  return {
    text: text.length > 0 ? text : 'Continue this run with the attached image(s) in mind.',
    images,
  };
}
