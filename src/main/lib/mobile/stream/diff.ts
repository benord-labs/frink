import { canonicalStringify } from '../../../../shared/lib/canonical-stringify';
import { applyChatOps, patchMessage } from '../../../../shared/lib/mobile-chat-ops';
import type {
  MobileChatDetail,
  MobileChatOp,
  MobileChatState,
  MobileMessage,
  MobileMessagePart,
} from '../../../../shared/types/remote/mobile';

function chatState({ messages, subChatId, ...state }: MobileChatDetail): MobileChatState {
  return state;
}

function same<Value>(left: Value, right: Value): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

/** The text a part gained when it only grew; null for any other change. */
function grownText(before?: MobileMessagePart, after?: MobileMessagePart): string | null {
  if (before?.type !== 'text' || after?.type !== 'text') return null;
  return after.text.startsWith(before.text) ? after.text.slice(before.text.length) : null;
}

/** The smallest op that turns `before` into `after`: a text delta, the changed tail, or all of it. */
function messageOps(before: MobileMessage | undefined, after: MobileMessage): MobileChatOp[] {
  if (before && same(before, after)) return [];
  if (!before) return [{ op: 'upsert', message: after }];
  const old = before.parts ?? [];
  const next = after.parts ?? [];
  const changed = next.findIndex((part, index) => !same(part, old[index]));
  const from = changed < 0 ? next.length : changed;
  const grown = grownText(old[from], next[from]);
  const tails: Array<Extract<MobileChatOp, { op: 'append' | 'parts' }>> = [
    { op: 'parts', messageId: after.id, from, parts: next.slice(from) },
  ];
  if (grown !== null)
    tails.unshift({ op: 'append', messageId: after.id, partIndex: from, text: grown });
  const tail = tails.find((op) => same(patchMessage(before, op), after));
  return [tail ?? { op: 'upsert', message: after }];
}

/** Whether a phone holding `held` shows `detail`. With older pages left out (`hasMore`), messages
 * it still holds from before the page's first are aged out, not removed. */
function shows(held: MobileChatDetail, detail: MobileChatDetail): boolean {
  const first = detail.messages[0]?.id;
  const start = detail.hasMore ? held.messages.findIndex((message) => message.id === first) : 0;
  return start >= 0 && same({ ...held, messages: held.messages.slice(start) }, detail);
}

/** Ops that bring a phone holding `sent` up to `detail`, in transcript order, state last, and what
 * it holds after them; null when no ops can, such as after a rollback removed messages it shows. */
export function chatOps(
  sent: MobileChatDetail,
  detail: MobileChatDetail,
): { ops: MobileChatOp[]; held: MobileChatDetail } | null {
  const before = new Map(sent.messages.map((message) => [message.id, message]));
  const ops = detail.messages.flatMap((message) => messageOps(before.get(message.id), message));
  const state = chatState(detail);
  if (!same(state, chatState(sent))) ops.push({ op: 'state', ...state });
  const held = applyChatOps(sent, ops);
  return held !== 'resync' && shows(held, detail) ? { ops, held } : null;
}
