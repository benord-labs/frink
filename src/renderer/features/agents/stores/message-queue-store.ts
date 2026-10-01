import { create } from 'zustand';
import { createJSONStorage, persist, subscribeWithSelector } from 'zustand/middleware';
import { isRunSettling } from '../../../lib/agent-chat/steer/run-busy';
import { registerChatScopedCleanup } from '../../../lib/atoms/atom-family-factory';
import { approvedPlanContextSchema } from '../../../../shared/types/approved-plan-context-schema';
import type { AgentQueueItem } from '../lib/queue-utils';
import { FLOW_DISPATCH_SOURCE, isInternalQueueItem, removeQueueItem } from '../lib/queue-utils';
import { agentChatStore, onChatRegistered } from './agent-chat-store';

/** sessionStorage key. Per window, survives a renderer reload, gone on quit — see decision
 * `message-queue-reload-persistence`. */
export const MESSAGE_QUEUE_STORAGE_KEY = 'frink:message-queue';

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
  // Map: subChatId -> parent chat id, recorded on enqueue so a chat's queues can be pruned when it
  // is archived or deleted even after a reload, when agentChatStore no longer knows the sub-chat.
  chatIds: Record<string, string>;
  // Map: parent chatId -> number of in-flight archives holding its sub-chats' queues. Counted, so
  // one pane's archive settling cannot release a hold another pane's archive still needs.
  heldChatIds: Record<string, number>;
  // Map: subChatId -> times its queue was cleared; an in-flight send checks it before requeueing.
  clearEpochs: Record<string, number>;

  // Actions
  addToQueue: (subChatId: string, item: AgentQueueItem) => void;
  removeFromQueue: (subChatId: string, itemId: string) => void;
  getQueue: (subChatId: string) => AgentQueueItem[];
  getVisibleQueue: (subChatId: string) => AgentQueueItem[];
  getNextItem: (subChatId: string) => AgentQueueItem | null;
  clearQueue: (subChatId: string) => void;
  // Drop every queue (and editing flag) belonging to a parent chat.
  clearQueuesForChat: (chatId: string) => void;
  getClearEpoch: (subChatId: string) => number;
  // Returns and removes the item for sending (atomic). Null for a turn held for lost attachments.
  popItem: (subChatId: string, itemId: string) => AgentQueueItem | null;
  // Add item to front of queue (for error recovery)
  prependItem: (subChatId: string, item: AgentQueueItem) => void;
  // Reorder a queue item from one index to another (used by drag-to-reorder).
  reorderQueue: (subChatId: string, fromIndex: number, toIndex: number) => void;
  reorderVisibleQueue: (subChatId: string, fromIndex: number, toIndex: number) => void;
  // Set or clear the per-subchat editing item id.
  setEditingItemId: (subChatId: string, itemId: string | null) => void;
  // Pause auto-send for every sub-chat of these parent chats (archive in flight).
  holdChats: (chatIds: readonly string[]) => void;
  releaseChats: (chatIds: readonly string[]) => void;
  isChatHeld: (chatId: string | undefined) => boolean;
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

/** Record the sub-chat's parent chat, keeping the map reference stable when nothing changes. */
function withChatId(chatIds: Record<string, string>, subChatId: string): Record<string, string> {
  const chatId = agentChatStore.getParentChatId(subChatId);
  if (!chatId || chatIds[subChatId] === chatId) return chatIds;
  return { ...chatIds, [subChatId]: chatId };
}

/** In-memory only (not persisted): a reload has no in-flight send left to requeue. */
function bumpEpochs(epochs: Record<string, number>, subChatIds: string[]): Record<string, number> {
  const next = { ...epochs };
  for (const subChatId of subChatIds) next[subChatId] = (next[subChatId] ?? 0) + 1;
  return next;
}

function without<T>(map: Record<string, T>, keys: string[]): Record<string, T> {
  if (!keys.some((key) => Object.hasOwn(map, key))) return map;
  const next = { ...map };
  for (const key of keys) delete next[key];
  return next;
}

type PersistedQueueState = Pick<MessageQueueState, 'queues' | 'editingItemIds' | 'chatIds'> &
  Partial<Pick<MessageQueueState, 'heldChatIds'>>;

/** A restored image keeps only its inline data: its blob: url died with the old document. */
function reviveItem(raw: AgentQueueItem): AgentQueueItem {
  const { sendOnSettle: _settle, attachmentsLost: _lost, ...item } = raw;
  const timestamp = new Date(raw.timestamp);
  const images = item.images?.map((img) => ({ ...img, url: '' }));
  const lost = (item.files?.length ?? 0) > 0 || (item.images ?? []).some((img) => !img.base64Data);
  return {
    ...item,
    images,
    timestamp: Number.isNaN(timestamp.getTime()) ? new Date() : timestamp,
    status: 'pending',
    ...(lost ? { attachmentsLost: true as const } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isOptional = (value: unknown, check: (v: unknown) => boolean) =>
  value === undefined || check(value);

const isLineOrSize = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

type EntryCheck = (entry: Record<string, unknown>) => boolean;

/** The shape each attachment/context list must have for the send path to consume it unchanged. */
const LIST_SHAPES: Record<
  | 'images'
  | 'files'
  | 'textContexts'
  | 'diffTextContexts'
  | 'codeSelectionContexts'
  | 'pastedTexts',
  EntryCheck
> = {
  images: (e) =>
    isString(e.id) &&
    isString(e.mediaType) &&
    e.mediaType.startsWith('image/') &&
    isOptional(e.url, isString) &&
    isOptional(e.base64Data, isString) &&
    isOptional(e.filename, isString),
  files: (e) =>
    isString(e.id) &&
    isString(e.filename) &&
    isString(e.url) &&
    isOptional(e.mediaType, isString) &&
    isOptional(e.size, isLineOrSize),
  textContexts: (e) => isString(e.id) && isString(e.text) && isString(e.sourceMessageId),
  diffTextContexts: (e) =>
    isString(e.id) &&
    isString(e.text) &&
    isString(e.filePath) &&
    isOptional(e.lineNumber, isLineOrSize) &&
    isOptional(e.lineType, (t) => t === 'old' || t === 'new'),
  codeSelectionContexts: (e) =>
    isString(e.id) &&
    isString(e.text) &&
    isString(e.filePath) &&
    isString(e.fileName) &&
    isString(e.language) &&
    isLineOrSize(e.startLine) &&
    isLineOrSize(e.endLine),
  // A pasted chip points at a file on disk, which survives the reload, so it is not "lost".
  pastedTexts: (e) =>
    isString(e.id) &&
    isString(e.filePath) &&
    isString(e.filename) &&
    isString(e.preview) &&
    isLineOrSize(e.size),
};

function isRestorableItem(item: unknown): item is AgentQueueItem {
  if (!isRecord(item) || !isString(item.id) || !isString(item.message)) return false;
  if (
    !isOptional(item.approvedPlanContext, (c) => approvedPlanContextSchema.safeParse(c).success)
  ) {
    return false;
  }
  if (!isOptional(item.source, (source) => source === FLOW_DISPATCH_SOURCE)) return false;
  if (!isOptional(item.dispatchTaskId, isString)) return false;
  return Object.entries(LIST_SHAPES).every(([field, check]) => {
    const list = item[field];
    return (
      list === undefined || (Array.isArray(list) && list.every((e) => isRecord(e) && check(e)))
    );
  });
}

/** Rebuild the queue read back from sessionStorage after a reload; malformed data is dropped, see
 * `message-queue-reload-persistence` for what each restored field becomes. */
export function reviveQueueState(persisted: unknown): PersistedQueueState {
  const source = isRecord(persisted) ? persisted : {};
  const queues: Record<string, AgentQueueItem[]> = {};
  for (const [subChatId, queue] of entriesOf(source.queues)) {
    const items = Array.isArray(queue) ? queue.filter(isRestorableItem) : [];
    if (items.length > 0) queues[subChatId] = items.map(reviveItem);
  }
  const editingItemIds = restoredLinks(source.editingItemIds, (subChatId, itemId) =>
    queues[subChatId]?.some((item) => item.id === itemId),
  );
  const chatIds = restoredLinks(source.chatIds, (subChatId) => subChatId in queues);
  // An archive in flight at reload: one hold per chat until reconcileRestoredHolds settles it.
  const heldChatIds: Record<string, number> = {};
  for (const [chatId, count] of entriesOf(source.heldChatIds)) if (count) heldChatIds[chatId] = 1;
  return {
    queues,
    editingItemIds,
    chatIds,
    ...(Object.keys(heldChatIds).length && { heldChatIds }),
  };
}

function entriesOf(value: unknown): [string, unknown][] {
  return isRecord(value) ? Object.entries(value) : [];
}

/** A persisted sub-chat -> id map, keeping only string ids that still point at a restored queue. */
function restoredLinks(
  value: unknown,
  stillValid: (subChatId: string, id: string) => boolean | undefined,
): Record<string, string> {
  const links: Record<string, string> = {};
  for (const [subChatId, id] of entriesOf(value)) {
    if (isString(id) && stillValid(subChatId, id)) links[subChatId] = id;
  }
  return links;
}

function persistedSlice(state: MessageQueueState): PersistedQueueState {
  const queues: Record<string, AgentQueueItem[]> = {};
  for (const [subChatId, queue] of Object.entries(state.queues)) {
    if (queue.length > 0) queues[subChatId] = queue;
  }
  const editingItemIds: Record<string, string | null> = {};
  for (const [subChatId, itemId] of Object.entries(state.editingItemIds)) {
    if (itemId) editingItemIds[subChatId] = itemId;
  }
  const chatIds: Record<string, string> = {};
  for (const [subChatId, chatId] of Object.entries(state.chatIds)) {
    if (queues[subChatId]) chatIds[subChatId] = chatId;
  }
  const held = Object.keys(state.heldChatIds).length ? { heldChatIds: state.heldChatIds } : {};
  return { queues, editingItemIds, chatIds, ...held };
}

let quotaWarned = false;

/** sessionStorage whose writes never throw: a queue too large to persist (big inline images) must
 * still work in memory, because persist writes synchronously inside every set(). */
const queueStorage = createJSONStorage<PersistedQueueState>(() => {
  const storage = sessionStorage;
  return {
    getItem: (name) => storage.getItem(name),
    removeItem: (name) => storage.removeItem(name),
    setItem: (name, value) => {
      try {
        storage.setItem(name, value);
      } catch (error) {
        // An older snapshot must not outlive the state it no longer matches: it could restore, and
        // resend, a turn that was sent since.
        try {
          storage.removeItem(name);
        } catch {
          // Storage is unusable altogether (e.g. disabled); the queue still works in memory.
        }
        if (!quotaWarned) {
          quotaWarned = true;
          console.warn(
            '[message-queue] queue too large to persist; it will not survive a reload',
            error,
          );
        }
      }
    },
  };
});

export const useMessageQueueStore = create<MessageQueueState>()(
  persist(
    subscribeWithSelector((set, get) => ({
      queues: {},
      editingItemIds: {},
      chatIds: {},
      heldChatIds: {},
      clearEpochs: {},

      addToQueue: (subChatId, item) => {
        set((state) => {
          const queue = state.queues[subChatId] || [];
          // An item under edit is about to be replaced by this one, so it is not queued ahead of it.
          const ahead = queue.some((i) => i.id !== state.editingItemIds[subChatId]);
          const next = ahead ? item : asHead(subChatId, item);
          return {
            queues: { ...state.queues, [subChatId]: [...queue, next] },
            chatIds: withChatId(state.chatIds, subChatId),
          };
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
          queues: without(state.queues, [subChatId]),
          editingItemIds: without(state.editingItemIds, [subChatId]),
          chatIds: without(state.chatIds, [subChatId]),
          clearEpochs: bumpEpochs(state.clearEpochs, [subChatId]),
        }));
      },

      getClearEpoch: (subChatId) => get().clearEpochs[subChatId] ?? 0,

      clearQueuesForChat: (chatId) => {
        set((state) => {
          const subChatIds = Object.keys(state.chatIds).filter(
            (id) => state.chatIds[id] === chatId,
          );
          if (subChatIds.length === 0) return state;
          return {
            queues: without(state.queues, subChatIds),
            editingItemIds: without(state.editingItemIds, subChatIds),
            chatIds: without(state.chatIds, subChatIds),
            clearEpochs: bumpEpochs(state.clearEpochs, subChatIds),
          };
        });
      },

      // Atomic pop: find and remove in single set() call to prevent race conditions
      popItem: (subChatId, itemId) => {
        let foundItem: AgentQueueItem | null = null;
        set((state) => {
          const currentQueue = state.queues[subChatId] || [];
          foundItem = currentQueue.find((i) => i.id === itemId && !i.attachmentsLost) || null;
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
          chatIds: withChatId(state.chatIds, subChatId),
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

      holdChats: (chatIds) => {
        if (chatIds.length === 0) return;
        set((state) => {
          const heldChatIds = { ...state.heldChatIds };
          for (const chatId of chatIds) heldChatIds[chatId] = (heldChatIds[chatId] ?? 0) + 1;
          return { heldChatIds };
        });
      },

      releaseChats: (chatIds) => {
        if (chatIds.length === 0) return;
        set((state) => {
          const heldChatIds = { ...state.heldChatIds };
          for (const chatId of chatIds) {
            const remaining = (heldChatIds[chatId] ?? 0) - 1;
            if (remaining > 0) heldChatIds[chatId] = remaining;
            else delete heldChatIds[chatId];
          }
          return { heldChatIds };
        });
      },

      isChatHeld: (chatId) => (chatId ? (get().heldChatIds[chatId] ?? 0) > 0 : false),
    })),
    {
      name: MESSAGE_QUEUE_STORAGE_KEY,
      version: 1,
      storage: queueStorage,
      partialize: persistedSlice,
      merge: (persisted, current) => ({ ...current, ...reviveQueueState(persisted) }),
    },
  ),
);

registerChatScopedCleanup((chatId) => useMessageQueueStore.getState().clearQueuesForChat(chatId));

// Work Queue plan recovery queues its turn just before registering the Chat; map it on registration.
onChatRegistered((subChatId) => {
  useMessageQueueStore.setState((state) => {
    if (!state.queues[subChatId]?.length) return state;
    const chatIds = withChatId(state.chatIds, subChatId);
    return chatIds === state.chatIds ? state : { chatIds };
  });
});
