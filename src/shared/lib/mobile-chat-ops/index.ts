// What each live chat op means, for both ends: the desktop checks its diff with it, the phone applies it.
import type {
  MobileChatDetail,
  MobileChatOp,
  MobileMessage,
  MobileMessagePart,
} from '../../types/remote/mobile';

type MessageOp = Extract<MobileChatOp, { op: 'append' | 'parts' }>;

/** A message's `text`: its text parts, joined by newlines. */
function withParts(message: MobileMessage, parts: MobileMessagePart[]): MobileMessage {
  const text = parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
  return { ...message, text, parts };
}

/** `message` after an `append` or `parts` op; null when the op does not fit it. */
export function patchMessage(message: MobileMessage, op: MessageOp): MobileMessage | null {
  const parts = message.parts ?? [];
  if (op.op === 'parts')
    return op.from > parts.length
      ? null
      : withParts(message, [...parts.slice(0, op.from), ...op.parts]);
  const part = parts[op.partIndex];
  if (part?.type !== 'text' || part.runs) return null;
  const next = [...parts];
  next[op.partIndex] = { ...part, text: part.text + op.text };
  return withParts(message, next);
}

function applyOp(detail: MobileChatDetail, op: MobileChatOp): MobileChatDetail | 'resync' {
  if (op.op === 'resync') return 'resync';
  if (op.op === 'state') {
    const { op: _, ...state } = op;
    return { ...detail, ...state };
  }
  const id = op.op === 'upsert' ? op.message.id : op.messageId;
  const index = detail.messages.findIndex((message) => message.id === id);
  if (op.op === 'upsert' && index < 0)
    return { ...detail, messages: [...detail.messages, op.message] };
  const message =
    op.op === 'upsert' ? op.message : index >= 0 && patchMessage(detail.messages[index], op);
  if (!message) return 'resync';
  const messages = [...detail.messages];
  messages[index] = message;
  return { ...detail, messages };
}

/** The chat a phone holds after `ops`, applied in order; 'resync' when one says so or does not
 * fit, and the phone should read the chat again. */
export function applyChatOps(
  detail: MobileChatDetail,
  ops: MobileChatOp[],
): MobileChatDetail | 'resync' {
  let held = detail;
  for (const op of ops) {
    const next = applyOp(held, op);
    if (next === 'resync') return next;
    held = next;
  }
  return held;
}
