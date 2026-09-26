import type { UIMessage } from 'ai';
import { canonicalStringify } from '../../../../shared/lib/canonical-stringify';

type RehydrationCandidate = {
  isActiveSubChat: boolean;
  isExistingChatStreaming: boolean;
  existingMessages: UIMessage[];
  fetchedMessages: UIMessage[];
};

export type DurableMessageRehydrationDecision = 'replace' | 'preserve';

type RehydrationMemo = { existing: UIMessage[]; decision: DurableMessageRehydrationDecision };

// Decision per (durable page, live array) identity pair; both are replaced, never mutated, on write.
// Consulted only after the streaming/transient guards (see the live-run-observer-lane note).
const decisionByPage = new WeakMap<UIMessage[], RehydrationMemo>();

type TransientMessage = UIMessage & {
  isStreaming?: boolean;
  inFlight?: boolean;
  isInFlight?: boolean;
};

function durableValueSignature(value: unknown): string | undefined {
  return value === undefined ? undefined : canonicalStringify(value);
}

function hasTransientMessage(messages: UIMessage[]): boolean {
  return messages.some((message) => {
    const transient = message as TransientMessage;
    return Boolean(transient.isStreaming || transient.inFlight || transient.isInFlight);
  });
}

function haveAlignedIdentity(existing: UIMessage[], fetched: UIMessage[]): boolean {
  return fetched.every(
    (message, index) =>
      message.id === existing[index]?.id && message.role === existing[index]?.role,
  );
}

function hasAlignedTailWindowAdvance(existing: UIMessage[], fetched: UIMessage[]): boolean {
  const firstFetched = fetched[0];
  if (!firstFetched) return false;
  const overlapStart = existing.findIndex(
    (message) => message.id === firstFetched.id && message.role === firstFetched.role,
  );
  if (overlapStart <= 0) return false;
  return existing.slice(overlapStart).every((message, index) => {
    const fetchedMessage = fetched[index];
    return message.id === fetchedMessage?.id && message.role === fetchedMessage?.role;
  });
}

function hasAlignedExistingPrefix(existing: UIMessage[], fetched: UIMessage[]): boolean {
  return existing.every(
    (message, index) => message.id === fetched[index]?.id && message.role === fetched[index]?.role,
  );
}

function hasDurableContentChange(existing: UIMessage[], fetched: UIMessage[]): boolean {
  return fetched.some((message, index) => {
    const current = existing[index];
    return (
      !current ||
      durableValueSignature(message.parts) !== durableValueSignature(current.parts) ||
      durableValueSignature(message.metadata) !== durableValueSignature(current.metadata)
    );
  });
}

/**
 * Durable query state may replace an idle mounted Chat only when it demonstrably advances the same
 * message identities. Identity divergence belongs to optimistic/local state and must remain live.
 *
 * No revision floor is needed against a pre-commit fetch landing after a stream settles: streaming
 * status stays live through settling (the app-level lane drives it), and the committed
 * `socket:stream-settled` handler invalidates this query, which cancels any fetch still in flight.
 */
export function classifyDurableMessageRehydration({
  isActiveSubChat,
  isExistingChatStreaming,
  existingMessages,
  fetchedMessages,
}: RehydrationCandidate): DurableMessageRehydrationDecision {
  if (
    !isActiveSubChat ||
    isExistingChatStreaming ||
    hasTransientMessage(existingMessages) ||
    fetchedMessages.length === 0
  ) {
    return 'preserve';
  }
  // A Chat built from this page holds the page's own array.
  if (existingMessages === fetchedMessages) return 'preserve';
  const memo = decisionByPage.get(fetchedMessages);
  if (memo?.existing === existingMessages) return memo.decision;
  const decision = compareDurablePage(existingMessages, fetchedMessages);
  decisionByPage.set(fetchedMessages, { existing: existingMessages, decision });
  return decision;
}

function compareDurablePage(
  existing: UIMessage[],
  fetched: UIMessage[],
): DurableMessageRehydrationDecision {
  // Crossing the durable tail-page cap can grow and shift the page in the same fetch (for example,
  // 19 total rows becoming the m2..m21 tail). Prove the retained overlap before comparing lengths.
  if (hasAlignedTailWindowAdvance(existing, fetched)) return 'replace';
  if (fetched.length > existing.length) {
    return hasAlignedExistingPrefix(existing, fetched) ? 'replace' : 'preserve';
  }
  if (fetched.length !== existing.length) return 'preserve';
  if (!haveAlignedIdentity(existing, fetched)) return 'preserve';
  return hasDurableContentChange(existing, fetched) ? 'replace' : 'preserve';
}
