import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { isRunSettling } from '../../../lib/agent-chat/steer/run-busy';
import type { AgentQueueItem } from '../lib/queue-utils';
import { isInternalQueueItem, removeQueueItem } from '../lib/queue-utils';

// Empty array constant to avoid creating new arrays on each call
// Exported for use in selectors to maintain stable reference
const EMPTY_QUEUE: AgentQueueItem[] = [];

type MessageQueueState = {
  // Map: subChatId -> queue items
  queues: Record<string, AgentQueueItem[]>;
  // Map: subChatId -> id of the queued item currently loaded into the chat input for editing.
  // The original item stays in the queue (with an "Editing…" badge) and is only removed
  // once the edited send succeeds.
  editingItemIds: Record<string, string | null>;

  // Actions
  addToQueue: (subChatId: string, item: AgentQueueItem) => void;
  removeFromQueue: (subChatId: string, itemId: string) => void;
  getQueue: (subChatId: string) => AgentQueueItem[];
  getVisibleQueue: (subChatId: string) => AgentQueueItem[];
  getNextItem: (subChatId: string) => AgentQueueItem | null;
  clearQueue: (subChatId: string) => void;
  // Returns and removes the item from queue (atomic operation)
  popItem: (subChatId: string, itemId: string) => AgentQueueItem | null;
  // Add item to front of queue (for error recovery)
  prependItem: (subChatId: string, item: AgentQueueItem) => void;
  // Reorder a queue item from one index to another (used by drag-to-reorder).
  reorderQueue: (subChatId: string, fromIndex: number, toIndex: number) => void;
  reorderVisibleQueue: (subChatId: string, fromIndex: number, toIndex: number) => void;
  // Set or clear the per-subchat editing item id.
  setEditingItemId: (subChatId: string, itemId: string | null) => void;
};

/** A turn that becomes the head while main only finalizes the last one goes the moment main settles
 * it; a turn that becomes the head at any other time keeps the spacing between queued turns. */
function asHead(subChatId: string, item: AgentQueueItem): AgentQueueItem {
  return { ...item, sendOnSettle: isRunSettling(subChatId) || undefined };
}

/** The mark belongs to the head alone, so a turn moved behind a new head drops it. */
function withHead(subChatId: string, head: AgentQueueItem, rest: AgentQueueItem[]) {
  const behind = rest.map((item) =>
    item.sendOnSettle ? { ...item, sendOnSettle: undefined } : item,
  );
  return [asHead(subChatId, head), ...behind];
}

const visibleQueueCache = new WeakMap<AgentQueueItem[], AgentQueueItem[]>();

function visibleQueue(queue: AgentQueueItem[]): AgentQueueItem[] {
  const cached = visibleQueueCache.get(queue);
  if (cached) return cached;
  const visible = queue.filter((item) => !isInternalQueueItem(item));
  visibleQueueCache.set(queue, visible);
  return visible;
}

export const useMessageQueueStore = create<MessageQueueState>()(
  subscribeWithSelector((set, get) => ({
    queues: {},
    editingItemIds: {},

    addToQueue: (subChatId, item) => {
      set((state) => {
        const queue = state.queues[subChatId] || [];
        // An item under edit is about to be replaced by this one, so it is not queued ahead of it.
        const ahead = queue.some((i) => i.id !== state.editingItemIds[subChatId]);
        const next = ahead ? item : asHead(subChatId, item);
        return { queues: { ...state.queues, [subChatId]: [...queue, next] } };
      });
    },

    removeFromQueue: (subChatId, itemId) => {
      set((state) => {
        const currentQueue = state.queues[subChatId] || [];
        if (currentQueue.some((item) => item.id === itemId && isInternalQueueItem(item))) {
          return state;
        }
        return {
          queues: {
            ...state.queues,
            [subChatId]: removeQueueItem(currentQueue, itemId),
          },
        };
      });
    },

    getQueue: (subChatId) => {
      return get().queues[subChatId] ?? EMPTY_QUEUE;
    },

    getVisibleQueue: (subChatId) => visibleQueue(get().queues[subChatId] ?? EMPTY_QUEUE),

    getNextItem: (subChatId) => {
      const queue = get().queues[subChatId] || [];
      return queue.find((item) => item.status === 'pending') || null;
    },

    clearQueue: (subChatId) => {
      set((state) => ({
        queues: {
          ...state.queues,
          [subChatId]: [],
        },
      }));
    },

    // Atomic pop: find and remove in single set() call to prevent race conditions
    popItem: (subChatId, itemId) => {
      let foundItem: AgentQueueItem | null = null;
      set((state) => {
        const currentQueue = state.queues[subChatId] || [];
        foundItem = currentQueue.find((i) => i.id === itemId) || null;
        if (!foundItem) return state;
        return {
          queues: {
            ...state.queues,
            [subChatId]: currentQueue.filter((i) => i.id !== itemId),
          },
        };
      });
      return foundItem;
    },

    // Add item to front of queue (used for error recovery - requeue failed items)
    prependItem: (subChatId, item) => {
      set((state) => ({
        queues: {
          ...state.queues,
          [subChatId]: withHead(subChatId, item, state.queues[subChatId] || []),
        },
      }));
    },

    reorderQueue: (subChatId, fromIndex, toIndex) => {
      if (fromIndex === toIndex) return;
      set((state) => {
        const currentQueue = state.queues[subChatId] || [];
        if (
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= currentQueue.length ||
          toIndex >= currentQueue.length
        ) {
          return state;
        }
        if (
          isInternalQueueItem(currentQueue[fromIndex]) ||
          isInternalQueueItem(currentQueue[toIndex])
        ) {
          return state;
        }
        const next = currentQueue.slice();
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        return {
          queues: {
            ...state.queues,
            [subChatId]:
              next[0] === currentQueue[0] ? next : withHead(subChatId, next[0], next.slice(1)),
          },
        };
      });
    },

    reorderVisibleQueue: (subChatId, fromIndex, toIndex) => {
      const visible = get().getVisibleQueue(subChatId);
      const currentQueue = get().queues[subChatId] ?? EMPTY_QUEUE;
      const fromId = visible[fromIndex]?.id;
      const toId = visible[toIndex]?.id;
      if (!fromId || !toId) return;
      get().reorderQueue(
        subChatId,
        currentQueue.findIndex((item) => item.id === fromId),
        currentQueue.findIndex((item) => item.id === toId),
      );
    },

    setEditingItemId: (subChatId, itemId) => {
      set((state) => {
        const item = itemId
          ? state.queues[subChatId]?.find((candidate) => candidate.id === itemId)
          : undefined;
        if (item && isInternalQueueItem(item)) return state;
        return {
          editingItemIds: {
            ...state.editingItemIds,
            [subChatId]: itemId,
          },
        };
      });
    },
  })),
);
