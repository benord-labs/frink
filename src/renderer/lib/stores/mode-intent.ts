import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { ChatMode } from '../../../shared/types/chat-mode';
import { appStore } from '../jotai-store';

/**
 * Pending mode TRANSITION INTENT per sub-chat — the only value the send path may attach as the
 * payload's `mode` (decision `sub-chat-mode-ownership`; the sub-chat row owns mode state). Set on
 * footer toggle, plan approval, and the flow plan-reply flip. Cleared ONLY by its own correlated
 * acks — the toggle mutation's onSuccess/onError, or a successful send (whose dispatch persisted
 * it) — never by mode-change echoes, which cannot tell whose write they announce. A send that
 * dies before reaching main leaves it armed for the retry. Single-valued: last-write-wins.
 */
export const pendingModeIntentAtomFamily = atomFamily((_subChatId: string) =>
  atom<ChatMode | null>(null),
);

/**
 * Arm an intent only when none is pending — the flow plan-reply flip fills the gap; an
 * explicitly armed toggle (e.g. debug) always wins over an automatic flip.
 */
export function armModeIntentIfEmpty(subChatId: string, mode: ChatMode): boolean {
  const intentAtom = pendingModeIntentAtomFamily(subChatId);
  if (appStore.get(intentAtom)) return false;
  appStore.set(intentAtom, mode);
  return true;
}

/**
 * CAS disarm: clear only the exact intent a completed ack refers to. A toggle armed while the
 * acked operation was in flight is a NEWER intent and must survive the stale ack.
 */
export function ackModeIntent(subChatId: string, carried: ChatMode): void {
  const intentAtom = pendingModeIntentAtomFamily(subChatId);
  if (appStore.get(intentAtom) === carried) appStore.set(intentAtom, null);
}

/** The mode a send may attach: the armed intent, on any trigger (settled ones were acked). */
export function takeModeIntentForSend(subChatId: string): ChatMode | undefined {
  return appStore.get(pendingModeIntentAtomFamily(subChatId)) ?? undefined;
}
