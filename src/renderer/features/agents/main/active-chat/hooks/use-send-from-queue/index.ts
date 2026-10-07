import { useSetAtom } from 'jotai';
import { useCallback, useRef } from 'react';
import { toast } from 'sonner';
import type { useSteerOrQueue } from '../../../../../../lib/agent-chat/steer';
import { isRunBusy } from '../../../../../../lib/agent-chat/steer/run-busy';
import type { ChatMode } from '../../../../../../../shared/types/chat-mode';
import { trackMessageSent } from '../../../../../../lib/analytics';
import { type PendingAccountAuthState, pendingAccountAuthAtom } from '../../../../../../lib/atoms';
import { notifySidebarChatActivity } from '@/features/sidebar';
import {
  type AgentQueueItem,
  isDispatchQueueItem,
  type QueuedSendMessage,
  queueItemToSendMessage,
} from '../../../../lib/queue-utils';
import { useMessageQueueStore } from '../../../../stores/message-queue-store';
import { useAgentSubChatStore } from '../../../../stores/sub-chat-store';
import { showAccountNotReadyToast } from '../../utils';

type Props = {
  subChatId: string;
  parentChatId: string;
  chatModeRef: React.RefObject<ChatMode>;
  isStreamingRef: React.RefObject<boolean>;
  isMountedRef: React.RefObject<boolean>;
  sendMessageRef: React.RefObject<((message: QueuedSendMessage) => Promise<void>) | null>;
  /** Delivers into the RUNNING turn, else queues — never a direct send (that aborts the turn). */
  steerOrQueue: ReturnType<typeof useSteerOrQueue>;
  handleStop: () => Promise<void>;
  /** Clears the composer's edit of a queued item when that item is the one being sent. */
  handleAbandonEdit: () => void;
  scrollToBottom: () => void;
  clearExpiredQuestionsForSubChat: () => void;
  /** After getResolvedAccount succeeded for this chat — required before any send. */
  isResolvedExecutionAccountReady: boolean;
  unauthAccount?: { label: string; type: 'claude-code' | 'codex' } | null;
};

/** Analytics, recency and sidebar order for a queued turn that is about to go out. */
function recordSend(item: AgentQueueItem, props: Props): void {
  trackMessageSent({
    workspaceId: props.subChatId,
    messageLength: item.message.length,
    mode: props.chatModeRef.current,
  });
  useAgentSubChatStore.getState().updateSubChatTimestamp(props.subChatId);
  if (props.parentChatId) notifySidebarChatActivity(props.parentChatId);
}

/**
 * A steer carries text and images only, so it would drop attached files and the metadata that
 * ties a dispatched prompt to its task. Such an item waits for the running turn to end instead.
 */
function mustWaitForTurn(item: AgentQueueItem, canSteer: boolean, props: Props): boolean {
  const steerWouldDrop = isDispatchQueueItem(item) || (item.files?.length ?? 0) > 0;
  return canSteer && props.isStreamingRef.current && steerWouldDrop;
}

type Delivery = {
  item: AgentQueueItem;
  message: QueuedSendMessage;
  canSteer: boolean;
  send: (message: QueuedSendMessage) => Promise<void>;
  requeue: () => void;
};

/** Steers into the running turn, waits behind it, or sends the item as its own turn. */
async function deliver(d: Delivery, props: Props): Promise<void> {
  const streaming = props.isStreamingRef.current;
  const busy = isRunBusy(props.subChatId, streaming);
  // Busy only because live runs are still hydrating: nothing to steer yet, so it waits.
  if (busy && !streaming) return d.requeue();

  // Steer (or requeue) rather than abort; only a turn this view shows streaming is stopped.
  if (busy && d.canSteer) {
    let delivered = true;
    const text = d.message.parts.find((p) => p.type === 'text')?.text ?? '';
    await props.steerOrQueue(text, d.item.images, () => {
      delivered = false;
      d.requeue();
    });
    if (delivered) recordSend(d.item, props);
    return;
  }
  // No steer channel on this runtime, so the card shows "Send now" — honour it by
  // interrupting first. The executor's duplicate-request guard settles the overlap.
  if (busy) await props.handleStop();
  recordSend(d.item, props);
  await d.send(d.message);
}

/** Takes the item off the queue for sending, or returns null when it cannot be sent right now. */
function claim(
  itemId: string,
  props: Props,
  setPendingAccountAuth: (value: PendingAccountAuthState) => void,
): AgentQueueItem | null {
  if (!props.isResolvedExecutionAccountReady) {
    showAccountNotReadyToast(props.unauthAccount ?? null, setPendingAccountAuth);
    return null;
  }
  const queueStore = useMessageQueueStore.getState();
  const item = queueStore.popItem(props.subChatId, itemId);
  // If the popped item was the one being edited, clear the editing flag so we don't
  // leave a stale "Editing…" badge or lock another row.
  if (item && queueStore.editingItemIds[props.subChatId] === itemId) props.handleAbandonEdit();
  return item;
}

/** Sends a claimed item, putting it back at the head whenever it cannot go out. */
async function sendClaimed(item: AgentQueueItem, canSteer: boolean, props: Props): Promise<void> {
  const requeue = () => useMessageQueueStore.getState().prependItem(props.subChatId, item);

  // Snapshot send function before async gaps to prevent stale ref reads
  const send = props.sendMessageRef.current;
  if (!send) return requeue();

  // An empty turn reads as a delivered message that carried nothing; requeueing it would only
  // offer the same dead item again.
  const { message, sendable } = queueItemToSendMessage(item);
  if (!sendable) {
    toast.error('A queued message was empty and was not sent.');
    return;
  }

  if (mustWaitForTurn(item, canSteer, props)) {
    requeue();
    toast.info('This message will be sent when the current step finishes.');
    return;
  }

  // Requeue the item so it is not lost on unmount.
  if (!props.isMountedRef.current) return requeue();

  try {
    // Re-arm stick-to-bottom and jump to the message just sent.
    props.scrollToBottom();
    props.clearExpiredQuestionsForSubChat();
    await deliver({ item, message, canSteer, send, requeue }, props);
  } catch (_error) {
    // Requeue the item so it is not lost on send failures.
    requeue();
  }
}

/**
 * The queue card's manual send: delivers one queued item now, by steering it into the running turn
 * or sending it as its own turn. An item that cannot go out is put back at the head, never lost.
 */
export function useSendFromQueue(
  props: Props,
): (itemId: string, canSteer: boolean) => Promise<void> {
  const setPendingAccountAuth = useSetAtom(pendingAccountAuthAtom);
  // Read through a ref so the returned callback stays stable across renders.
  const propsRef = useRef(props);
  propsRef.current = props;

  return useCallback(
    async (itemId, canSteer) => {
      const item = claim(itemId, propsRef.current, setPendingAccountAuth);
      if (item) await sendClaimed(item, canSteer, propsRef.current);
    },
    [setPendingAccountAuth],
  );
}
