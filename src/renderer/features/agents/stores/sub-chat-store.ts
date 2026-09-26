import { create } from 'zustand';
import type { ChatMode } from '../../../../shared/types/chat-mode';
import type { ApprovedPlanContext } from '../../../../shared/types/plan';
import { getWindowId } from '../../../contexts/WindowContext';
import { appStore } from '../../../lib/jotai-store';
import { approvedPlanContextAtomFamily, approvedPlanIdsAtomFamily } from '../atoms';
import { agentChatStore } from './agent-chat-store';

export type SubChatMeta = {
  id: string;
  name: string;
  /** Parent chat; a row without it is invisible to every per-chat view. */
  chatId?: string;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  mode?: ChatMode;
  messages?: unknown[]; // AI SDK message format
  // Canonical field from tRPC/renderer adapters
  sessionId?: string | null;
  streamId?: string | null;
};

type AgentSubChatStore = {
  // Current parent chat context
  chatId: string | null;

  // State
  activeSubChatId: string | null;
  /** Every hydrated sub-chat across all parent chats; per-chat lists via `selectSubChatsForChat`. */
  subChatsById: Record<string, SubChatMeta>;

  // Actions
  setChatId: (chatId: string | null) => void;
  setActiveSubChat: (subChatId: string) => void;
  setSubChatsForChat: (chatId: string, subChats: SubChatMeta[]) => void;
  updateSubChatName: (subChatId: string, name: string) => void;
  updateSubChatMode: (subChatId: string, mode: ChatMode, chatId?: string) => void;
  updateSubChatTimestamp: (subChatId: string) => void;
  reset: () => void;
};

// Remember each chat's active sub-chat in localStorage, keyed per Electron window.
const activeStorageKey = (chatId: string) => `${getWindowId()}:agent-active-sub-chats-${chatId}`;

const saveActiveToLS = (chatId: string, subChatId: string) => {
  if (typeof window === 'undefined') return;
  localStorage.setItem(activeStorageKey(chatId), JSON.stringify(subChatId));
};

const loadActiveFromLS = (chatId: string): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    const stored = localStorage.getItem(activeStorageKey(chatId));
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
};

// Fields hydration and patches can change. Add any new field that flows through
// `setSubChatsForChat`, or its updates are discarded as no-ops.
const COMPARED_FIELDS = [
  'id',
  'name',
  'chatId',
  'mode',
  'createdAt',
  'updatedAt',
] as const satisfies readonly (keyof SubChatMeta)[];

/** Whether two rows are interchangeable for the fields hydration can change. */
function shallowEqualSubChat(a: SubChatMeta, b: SubChatMeta): boolean {
  return COMPARED_FIELDS.every((field) => Object.is(a[field], b[field]));
}

/**
 * Hydrate one row over what the store already holds. Returns the EXISTING object when
 * nothing changed, so callers can detect a no-op by identity.
 */
function mergeSubChatRow(
  existing: SubChatMeta | undefined,
  incoming: SubChatMeta,
  chatId: string,
): SubChatMeta {
  const merged = { ...existing, ...incoming, chatId };
  return existing && shallowEqualSubChat(existing, merged) ? existing : merged;
}

/**
 * Apply a partial update to one sub-chat. Bails without allocating when the value is
 * unchanged, and when the row is absent either inserts `fallback` or does nothing.
 */
function patchSubChat(
  set: (partial: Partial<AgentSubChatStore>) => void,
  get: () => AgentSubChatStore,
  subChatId: string,
  patch: Partial<SubChatMeta>,
  fallback?: SubChatMeta,
): void {
  const { subChatsById } = get();
  const existing = subChatsById[subChatId];
  if (!existing) {
    if (!fallback) return;
    set({ subChatsById: { ...subChatsById, [subChatId]: fallback } });
    return;
  }
  const merged = { ...existing, ...patch };
  if (shallowEqualSubChat(existing, merged)) return;
  set({ subChatsById: { ...subChatsById, [subChatId]: merged } });
}

export const useAgentSubChatStore = create<AgentSubChatStore>((set, get) => ({
  chatId: null,
  activeSubChatId: null,
  subChatsById: {},

  setChatId: (chatId) => {
    if (!chatId) {
      set({
        chatId: null,
        activeSubChatId: null,
        subChatsById: {},
      });
      return;
    }

    // Re-selecting the current chat must not reset state. Several call sites fire this
    // for an already-active chat (layout effect, sub-chat init effect, work-queue jump);
    // without this guard the later caller wipes the hydrated list after an earlier one filled
    // it, leaving the chat pane with nothing to render.
    if (get().chatId === chatId) return;

    // subChatsById is populated from DB + placeholders in the init effect
    const activeSubChatId = loadActiveFromLS(chatId);

    // subChatsById is deliberately NOT cleared: it spans every chat, so wiping it here
    // would drop rows a concurrently-rendered pane still needs.
    set({ chatId, activeSubChatId });
  },

  setActiveSubChat: (subChatId) => {
    const { chatId } = get();
    set({ activeSubChatId: subChatId });
    if (chatId) saveActiveToLS(chatId, subChatId);
  },

  // Replaces only this chat's rows (panes hydrate concurrently), merging so an early plan-mode
  // toggle survives. A no-op keeps the same record, so an effect calling this cannot loop.
  setSubChatsForChat: (chatId, subChats) => {
    const { subChatsById } = get();
    const next: Record<string, SubChatMeta> = {};

    for (const [id, row] of Object.entries(subChatsById)) {
      // Rows of OTHER chats pass through. A row with no chatId is a not-yet-hydrated
      // stub; it is claimed below if this chat owns it, and otherwise kept.
      if (row.chatId !== chatId) next[id] = row;
    }

    let changed = false;
    for (const incoming of subChats) {
      const existing = subChatsById[incoming.id];
      const row = mergeSubChatRow(existing, incoming, chatId);
      if (row !== existing) changed = true;
      next[incoming.id] = row;
    }

    // Length differing means rows were dropped or added; otherwise every row matched above.
    if (!changed && Object.keys(next).length === Object.keys(subChatsById).length) return;
    set({ subChatsById: next });
  },

  updateSubChatName: (subChatId, name) => {
    patchSubChat(set, get, subChatId, { name });
  },

  // `chatId` only matters when upserting a not-yet-hydrated row; without a parent the stub would
  // vanish from every per-chat list, so fall back to the Chat instance's recorded parent.
  updateSubChatMode: (subChatId, mode, chatId) => {
    const parentChatId = chatId ?? agentChatStore.getParentChatId(subChatId);
    patchSubChat(
      set,
      get,
      subChatId,
      { mode },
      { id: subChatId, name: '', mode, chatId: parentChatId },
    );
  },

  updateSubChatTimestamp: (subChatId: string) => {
    patchSubChat(set, get, subChatId, { updatedAt: new Date().toISOString() });
  },

  reset: () => {
    set({
      chatId: null,
      activeSubChatId: null,
      subChatsById: {},
    });
  },
}));

// ─── Derivations: server rows → store rows, and flat record → per-chat list ───

const listCache = new WeakMap<Record<string, SubChatMeta>, Map<string, SubChatMeta[]>>();

/** Shared empty result so an absent chat never allocates a new array. */
const EMPTY_SUB_CHATS: SubChatMeta[] = [];

// Sub-chats of `chatId`, memoized per record so the same array comes back (it feeds useMemo
// deps). Rows without a chatId are unclaimed stubs and are excluded.
export function selectSubChatsForChat(
  subChatsById: Record<string, SubChatMeta>,
  chatId: string | null,
): SubChatMeta[] {
  if (!chatId) return EMPTY_SUB_CHATS;

  let perChat = listCache.get(subChatsById);
  if (!perChat) {
    perChat = new Map();
    listCache.set(subChatsById, perChat);
  }

  const cached = perChat.get(chatId);
  if (cached) return cached;

  const list = Object.values(subChatsById).filter((subChat) => subChat.chatId === chatId);
  const result = list.length > 0 ? list : EMPTY_SUB_CHATS;
  perChat.set(chatId, result);
  return result;
}

// Server rows plus a placeholder for a pending sub-chat the server lacks (else the pane has
// nothing to render until the next hydration).
// Blank fields are omitted, not `undefined`, so the merge keeps what the store already holds.
export function buildSubChatList(
  agentSubChats: SubChatMeta[],
  pendingSubChatId: string | null,
  chatId: string,
): SubChatMeta[] {
  const list: SubChatMeta[] = agentSubChats.map((subChat) => {
    const row: SubChatMeta = {
      id: subChat.id,
      name: subChat.name || 'New Chat',
      chatId,
    };
    // Omitted rather than defaulted: a default would overwrite a toggle not yet persisted.
    if (subChat.mode) row.mode = subChat.mode;
    const createdAt = toIsoString(subChat.createdAt);
    const updatedAt = toIsoString(subChat.updatedAt);
    if (createdAt) row.createdAt = createdAt;
    if (updatedAt) row.updatedAt = updatedAt;
    return row;
  });

  if (pendingSubChatId && !list.some((subChat) => subChat.id === pendingSubChatId)) {
    // No timestamp: minting one would churn every pass and shadow the server's real value.
    list.push({ id: pendingSubChatId, name: 'New Chat', chatId });
  }

  return list;
}

function toIsoString(value: string | Date | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

/** Arm the shared state for an approved execution turn before any path-specific send behavior. */
export function armApprovedPlanState(subChatId: string, context: ApprovedPlanContext): void {
  appStore.set(approvedPlanContextAtomFamily(subChatId), context);
  if (context.planId) {
    const idsAtom = approvedPlanIdsAtomFamily(subChatId);
    appStore.set(idsAtom, new Set([...appStore.get(idsAtom), context.planId]));
  }
  useAgentSubChatStore.getState().updateSubChatMode(subChatId, 'agent');
}
