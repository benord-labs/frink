/**
 * Observer lane: applies a sub-chat's stream when NO local transport owns it.
 *
 * Two producers land here. A between-turn wake burst — the agent woke itself on background work
 * after the turn that started it already finished, so its transport is long gone — and, when
 * cross-machine chats are enabled, a run executing on another machine.
 *
 * Local main-process streams carry an epoch and ordered cursor. They are reduced from deltas with
 * the same pure reducer main uses, then repaired from a bounded pull if this pane missed an event.
 * The disabled-by-default cross-machine relay has no epoch yet, so that legacy path keeps repainting
 * from cumulative `parts` snapshots and drops delta-only payloads.
 *
 * Note: Room joining is handled separately in active-chat.tsx after
 * agentChat data is loaded.
 */

import type { UIMessage } from 'ai';
import { api } from '../../../../../lib/mock-api';
import { useRealtimeSyncRefs } from '../utils/realtime-sync-recovery';
import { useRealtimeSyncController } from './realtime-sync-controller';

type UseRealtimeSyncOptions = {
  subChatId: string;
  chatId: string;
  messages: UIMessage[];
  setMessages: (messages: UIMessage[] | ((previous: UIMessage[]) => UIMessage[])) => void;
  isActive: boolean;
};

/**
 * Hook to apply a sub-chat's stream when no local transport owns the run.
 */
export function useRealtimeSync({
  subChatId,
  chatId,
  messages,
  setMessages,
  isActive,
}: UseRealtimeSyncOptions): void {
  const utils = api.useUtils();
  const refs = useRealtimeSyncRefs({
    messages,
    setMessages,
    isActive,
    invalidateSubChatMessages: utils.chats.getSubChatMessages.invalidate,
  });
  useRealtimeSyncController({ subChatId, chatId, refs });
}
