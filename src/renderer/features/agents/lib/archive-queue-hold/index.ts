import { useRef } from 'react';
import { trpcClient } from '../../../../lib/trpc';
import { agentChatStore } from '../../stores/agent-chat-store';
import { useMessageQueueStore } from '../../stores/message-queue-store';
import { useAgentSubChatStore } from '../../stores/sub-chat-store';

/** Every sub-chat of `chatId` this window knows about: registered Chats plus hydrated sidebar rows. */
function subChatIdsForChat(chatId: string): Set<string> {
  const ids = new Set(agentChatStore.getSubChatIdsForChat(chatId));
  for (const row of Object.values(useAgentSubChatStore.getState().subChatsById)) {
    if (row.chatId === chatId) ids.add(row.id);
  }
  return ids;
}

function dropQueuedMessagesForChat(chatId: string): void {
  const store = useMessageQueueStore.getState();
  // Sub-chats recorded on enqueue (known even after a reload), then those this window knows about.
  store.clearQueuesForChat(chatId);
  // Even when empty: the epoch bump stops a send already in flight from requeueing on failure.
  for (const subChatId of subChatIdsForChat(chatId)) store.clearQueue(subChatId);
}

let restoredHoldsSettled: Promise<void> | undefined;

/** Settle holds restored by a reload mid-archive, once per document: wait for main's archive, drop
 * the queue if it archived (or the chat is gone), then release each restored hold exactly once. */
export function reconcileRestoredHolds(): Promise<void> {
  restoredHoldsSettled ??= Promise.all(
    Object.keys(useMessageQueueStore.getState().heldChatIds).map(async (chatId) => {
      // A failed read keeps the queue: main's admission guard still declines an archived chat.
      const outcome = await trpcClient.chats.archiveOutcome.query({ id: chatId }).catch(() => {});
      if (outcome === null || outcome?.archived) dropQueuedMessagesForChat(chatId);
      useMessageQueueStore.getState().releaseChats([chatId]);
    }),
  ).then(() => {});
  return restoredHoldsSettled;
}

/** Test-only: forget that this document already reconciled its restored holds. */
export function _resetRestoredHoldsForTests(): void {
  restoredHoldsSettled = undefined;
}

/** Hold the chat's queue while `archive()` runs (main aborts the run mid-mutation, so the sub-chat goes
 * 'ready' early), then drop it on success. A failed archive keeps the queue and resumes it. */
export async function archiveWithQueueHold<T>(
  chatId: string,
  archive: () => Promise<T>,
): Promise<T> {
  useMessageQueueStore.getState().holdChats([chatId]);
  try {
    const result = await archive();
    // null: nothing was archived (e.g. the chat was already gone), so keep what was queued.
    if (result !== null) dropQueuedMessagesForChat(chatId);
    return result;
  } finally {
    useMessageQueueStore.getState().releaseChats([chatId]);
  }
}

type ArchiveMutation<T> = {
  mutateAsync: (input: { id: string; killTerminals?: boolean }) => Promise<T>;
};

/** Stable ref over the latest archive mutation (tRPC returns a new object each render); every call
 * runs under {@link archiveWithQueueHold}. All sidebar archives, single and bulk, go through it. */
export function useQueueHeldArchiveRef<T>(mutation: ArchiveMutation<T>) {
  const latest = useRef(mutation);
  latest.current = mutation;
  return useRef<ArchiveMutation<T>>({
    mutateAsync: (input) => archiveWithQueueHold(input.id, () => latest.current.mutateAsync(input)),
  });
}
