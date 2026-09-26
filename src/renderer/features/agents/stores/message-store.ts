/* eslint-disable max-lines */
import type { UIMessage } from 'ai';
import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import {
  isFrinkPlanMessagePartType,
  isPlanReadyPart,
  normalizeFrinkPlanMessagePartType,
} from '../../../../shared/types/plan';
import { appStore } from '../../../lib/jotai-store';
import { approvedPlanIdsAtomFamily } from '../atoms';

// Types
export type MessageMetadata = {
  sessionId?: string;
  sdkMessageUuid?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalCostUsd?: number;
  durationMs?: number;
  resultSubtype?: string;
  finalTextId?: string;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
};

export type MessagePart = {
  type: string;
  text?: string;
  toolCallId?: string;
  state?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  errorText?: string;
  toolName?: string;
  data?: Record<string, unknown>;
};

export type Message = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts?: MessagePart[];
  metadata?: MessageMetadata;
  createdAt?: Date;
};

// Helper to convert UIMessage to Message (extracts compatible fields)
function toMessage(uiMsg: UIMessage): Message {
  return {
    id: uiMsg.id,
    role: uiMsg.role,
    parts: uiMsg.parts?.map((part) => {
      const basePart: MessagePart = { type: normalizeFrinkPlanMessagePartType(part.type) };
      if (part.type === 'text' && 'text' in part) {
        basePart.text = part.text;
      }
      if ('toolCallId' in part && part.toolCallId !== undefined) {
        basePart.toolCallId = part.toolCallId;
      }
      if ('state' in part && part.state !== undefined) basePart.state = part.state;
      if ('input' in part && part.input !== undefined) {
        basePart.input =
          typeof part.input === 'object' && part.input !== null
            ? (part.input as Record<string, unknown>)
            : undefined;
      }
      if ('output' in part && part.output !== undefined) {
        basePart.output =
          typeof part.output === 'object' && part.output !== null
            ? (part.output as Record<string, unknown>)
            : undefined;
      }
      if ('result' in part && part.result !== undefined) {
        basePart.result = part.result;
      }
      if ('error' in part && part.error !== undefined) {
        basePart.error = part.error;
      }
      if ('errorText' in part && part.errorText !== undefined) {
        basePart.errorText = part.errorText;
      }
      if ('toolName' in part && part.toolName !== undefined) {
        basePart.toolName = part.toolName;
      }
      if ('data' in part && part.data !== undefined) {
        basePart.data =
          typeof part.data === 'object' && part.data !== null
            ? (part.data as Record<string, unknown>)
            : undefined;
      }
      return basePart;
    }),
    metadata: uiMsg.metadata as MessageMetadata | undefined,
  };
}

// ============================================================================
// MESSAGE STORE - OPTIMIZED ARCHITECTURE
// ============================================================================
// Key insight: Jotai atomFamily creates INDEPENDENT atoms for each key.
// When we use atomFamily with primitive atoms (not derived), each message
// has its own atom that can be updated without affecting other messages.
//
// Architecture:
// - messageAtomFamily: atomFamily<messageId, Message | null> - INDEPENDENT atoms per message
// - perSubChat*AtomFamily: the ids/roles rendering reads, keyed so split view can show many chats
// - messageIdsAtom/messageRolesAtom: superseded single-chat predecessor; nothing renders from it
//
// During streaming:
// - Only the streaming message's atom is updated
// - Other message atoms remain unchanged → no re-renders
// ============================================================================

// Per-message atom family - each message has its own INDEPENDENT atom
// This is the key optimization: updating one message doesn't affect others
export const messageAtomFamily = atomFamily((_messageId: string) => atom<Message | null>(null));

// Track active message IDs per subChat for cleanup
const activeMessageIdsByChat = new Map<string, Set<string>>();

// Ordered message IDs for the superseded global layer. No product consumer left: it only feeds
// hasUnapprovedPlanAtom, which nothing but its own test reads. Deleted with that layer in sc-3431.
const messageIdsAtom = atom<string[]>([]);

// Message roles cache - updated only when messages are added/removed
// This avoids reading all message atoms just to check roles
const messageRolesAtom = atom<Map<string, 'user' | 'assistant' | 'system'>>(new Map());

// Chat status atom. WRITE-ONLY since sc-3372 deleted its last reader (isStreamingAtom); three
// sync modules still write it. Removed with them, and the rest of the global layer, in sc-3431.
export const chatStatusAtom = atom<string>('ready');

// Flag to indicate remote streaming in progress (prevents status override by MessageSyncManager)
export const remoteStreamingAtom = atom<boolean>(false);

export type RollbackMode = 'chat' | 'chat-and-code';

// Rollback handler/state (optional) to avoid prop drilling
export const rollbackHandlerAtom = atom<
  ((userMsgId: string, userTextContent: string, mode: RollbackMode) => void) | null
>(null);
export const isRollingBackAtom = atom<boolean>(false);
export const chatHasGitContextAtomFamily = atomFamily((_subChatId: string) => atom<boolean>(false));
// True while this chat's flow run has not fully completed (in progress OR failed/cancelled).
// Rollback is suppressed chat-wide until the flow reaches 'completed' — a mid-flow or failed
// rollback rewinds the transcript/code but cannot rewind the flow graph, leaving node_runs desynced.
export const flowRunIncompleteAtomFamily = atomFamily((_subChatId: string) => atom<boolean>(false));

// Current subChatId - used to isolate caches per chat
export const currentSubChatIdAtom = atom<string>('default');

// ============================================================================
// PER-SUBCHAT ATOMS (for split view support)
// ============================================================================
// In split view, multiple ChatView instances coexist. The global atoms above
// can only hold ONE chat's data at a time. These per-subChat atoms allow
// each pane to independently read its own message state without collision.
// ============================================================================

// Per-subChat MAIN message IDs (from Chat/sync — initial page + streaming). Sync writes here only.
/** Exported for tests and diagnostics; prefer `perSubChatMessageIdsAtomFamily` for display order. */
export const perSubChatMainMessageIdsAtomFamily = atomFamily((_subChatId: string) =>
  atom<string[]>([]),
);

// Per-subChat PREPENDED message IDs (from "load older"). Prepended IDs are never removed by sync cleanup.
const perSubChatPrependedIdsAtomFamily = atomFamily((_subChatId: string) => atom<string[]>([]));

// Display list = prepended (older) + main (current page + new). Derived so prepended + main stay in sync.
export const perSubChatMessageIdsAtomFamily = atomFamily((subChatId: string) =>
  atom((get) => {
    const prepended = get(perSubChatPrependedIdsAtomFamily(subChatId));
    const main = get(perSubChatMainMessageIdsAtomFamily(subChatId));
    return [...prepended, ...main];
  }),
);

// Main roles (sync writes). Prepended roles stored separately and merged in derived atom.
const perSubChatMainMessageRolesAtomFamily = atomFamily((_subChatId: string) =>
  atom<Map<string, 'user' | 'assistant' | 'system'>>(new Map()),
);
const perSubChatPrependedRolesAtomFamily = atomFamily((_subChatId: string) =>
  atom<Map<string, 'user' | 'assistant' | 'system'>>(new Map()),
);

// Display roles = prepended + main (for grouping/display)
const perSubChatMessageRolesAtomFamily = atomFamily((subChatId: string) =>
  atom((get) => {
    const prepended = get(perSubChatPrependedRolesAtomFamily(subChatId));
    const main = get(perSubChatMainMessageRolesAtomFamily(subChatId));
    const merged = new Map<string, 'user' | 'assistant' | 'system'>(prepended);
    for (const [id, role] of main) merged.set(id, role);
    return merged;
  }),
);

// Per-subChat chat status
export const perSubChatStatusAtomFamily = atomFamily((_subChatId: string) => atom<string>('ready'));

// Derived: per-subChat last message ID
const lastMessageIdForSubChatAtomFamily = atomFamily((subChatId: string) =>
  atom((get) => {
    const ids = get(perSubChatMessageIdsAtomFamily(subChatId));
    return ids.length > 0 ? ids[ids.length - 1] : null;
  }),
);

// ============================================================================
// SHARED HELPERS — used by the per-subChat derived atoms
// ============================================================================

type MessageGroup = { userMsgId: string; assistantMsgIds: string[] };

/**
 * Sentinel prefix for synthetic anchors created for orphan assistant messages
 * (assistant messages that appear before any user message in a sub-chat).
 * Flow `chat_reply` blocks produce these — they post `role: "assistant"` with
 * no preceding user message.
 */
export const ORPHAN_ANCHOR_PREFIX = '__orphan_anchor__';

/** Filter user message IDs with structural-equality caching. */
function filterUserMessageIds(
  ids: string[],
  roles: Map<string, 'user' | 'assistant' | 'system'>,
  cacheKey: string,
  cache: Map<string, string[]>,
): string[] {
  const newUserIds: string[] = [];
  let hasAssistantBeforeFirstUser = false;
  let seenFirstUser = false;
  for (const id of ids) {
    const role = roles.get(id);
    if (role === 'user') {
      seenFirstUser = true;
      newUserIds.push(id);
    } else if (!seenFirstUser && role === 'assistant') {
      hasAssistantBeforeFirstUser = true;
    }
  }

  // Synthetic anchor when any assistant appears before the first user (including all-assistant threads)
  if (hasAssistantBeforeFirstUser) {
    newUserIds.unshift(`${ORPHAN_ANCHOR_PREFIX}${cacheKey}`);
  }

  const cached = cache.get(cacheKey);
  if (
    cached &&
    cached.length === newUserIds.length &&
    cached.every((id, i) => id === newUserIds[i])
  ) {
    return cached;
  }
  cache.set(cacheKey, newUserIds);
  return newUserIds;
}

/** Build message groups from IDs/roles with structural-equality caching. */
function buildMessageGroups(
  ids: string[],
  roles: Map<string, 'user' | 'assistant' | 'system'>,
  cacheKey: string,
  cache: Map<string, MessageGroup[]>,
): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentGroup: MessageGroup | null = null;

  // Collect leading assistant messages into a synthetic orphan group
  let orphanAssistantIds: string[] | null = null;
  let seenFirstUser = false;

  for (const id of ids) {
    const role = roles.get(id);
    if (!role) continue;
    if (role === 'user') {
      if (!seenFirstUser && orphanAssistantIds && orphanAssistantIds.length > 0) {
        groups.push({
          userMsgId: `${ORPHAN_ANCHOR_PREFIX}${cacheKey}`,
          assistantMsgIds: orphanAssistantIds,
        });
        orphanAssistantIds = null;
      }
      seenFirstUser = true;
      if (currentGroup) groups.push(currentGroup);
      currentGroup = { userMsgId: id, assistantMsgIds: [] };
    } else if (role === 'assistant') {
      if (!seenFirstUser) {
        if (!orphanAssistantIds) orphanAssistantIds = [];
        orphanAssistantIds.push(id);
      } else if (currentGroup) {
        currentGroup.assistantMsgIds.push(id);
      }
    }
  }
  if (currentGroup) groups.push(currentGroup);
  // Handle all-assistant sub-chat (no user messages at all)
  if (!seenFirstUser && orphanAssistantIds && orphanAssistantIds.length > 0) {
    groups.push({
      userMsgId: `${ORPHAN_ANCHOR_PREFIX}${cacheKey}`,
      assistantMsgIds: orphanAssistantIds,
    });
  }

  // Return cached if structurally equal
  const cached = cache.get(cacheKey) ?? [];
  if (groups.length === cached.length) {
    let allMatch = true;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const c = cached[i];
      if (
        g.userMsgId !== c?.userMsgId ||
        g.assistantMsgIds.length !== c?.assistantMsgIds.length ||
        !g.assistantMsgIds.every((id, j) => id === c?.assistantMsgIds[j])
      ) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) return cached;
  }
  cache.set(cacheKey, groups);
  return groups;
}

/** Look up assistant IDs for a user message from groups, with caching. */
function lookupAssistantIds(
  groups: MessageGroup[],
  userMsgId: string,
  cacheKey: string,
  cache: Map<string, string[]>,
): string[] {
  const group = groups.find((g) => g.userMsgId === userMsgId);
  const newIds = group?.assistantMsgIds ?? [];
  const cached = cache.get(cacheKey);
  if (cached && cached.length === newIds.length && cached.every((id, i) => id === newIds[i])) {
    return cached;
  }
  cache.set(cacheKey, newIds);
  return newIds;
}

/** Check if a status represents active streaming. */
function isStatusStreaming(status: string): boolean {
  return status === 'streaming' || status === 'submitted';
}

function sameIdListOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ============================================================================
// PER-SUBCHAT DERIVED ATOMS (using shared helpers)
// ============================================================================

const userMsgIdsCachePerSubChat = new Map<string, string[]>();
export const userMessageIdsForSubChatAtomFamily = atomFamily((subChatId: string) =>
  atom((get) => {
    const ids = get(perSubChatMessageIdsAtomFamily(subChatId));
    const roles = get(perSubChatMessageRolesAtomFamily(subChatId));
    return filterUserMessageIds(ids, roles, subChatId, userMsgIdsCachePerSubChat);
  }),
);

const messageGroupsCachePerSubChat = new Map<string, MessageGroup[]>();
export const messageGroupsForSubChatAtomFamily = atomFamily((subChatId: string) =>
  atom((get) => {
    const ids = get(perSubChatMessageIdsAtomFamily(subChatId));
    const roles = get(perSubChatMessageRolesAtomFamily(subChatId));
    return buildMessageGroups(ids, roles, subChatId, messageGroupsCachePerSubChat);
  }),
);

/**
 * toolCallIds of frink-plan parts whose Approve & Run button should be hidden because they belong
 * to a closed approval epoch.
 *
 * Approval epochs: a plan is "closed" once it (or any plan in the same conversation cluster) has
 * been approved. Walks plans in chronological order; the latest plan that's either marked
 * `approved`/`in_progress`/`completed` OR whose planId is in `approvedPlanIdsAtomFamily` (set
 * synchronously on Approve & Run click) is the epoch boundary — every plan up to and including
 * that boundary hides its button. Plans created *after* the boundary (next epoch, user re-enters
 * plan mode) keep their buttons so the user can approve fresh plans.
 *
 * Result is cached per sub-chat by content fingerprint (plan ids+statuses + approvedPlanIds).
 * Stable Set reference across recomputes that produced identical content prevents memoized
 * subscribers from re-rendering on every unrelated message stream tick. Shared empty Set is
 * returned for the common no-closed-plans case so most chats pay zero per-render cost.
 */
const EMPTY_HIDDEN_SET: ReadonlySet<string> = new Set<string>();
const hiddenApprovalPlanIdsCache = new Map<string, { fingerprint: string; result: Set<string> }>();
export const hiddenApprovalPlanIdsForSubChatAtomFamily = atomFamily((subChatId: string) =>
  atom<ReadonlySet<string>>((get) => {
    const ids = get(perSubChatMessageIdsAtomFamily(subChatId));
    const plans: Array<{ toolCallId: string; planId?: string; status?: string }> = [];
    for (const id of ids) {
      if (!id) continue;
      const msg = get(messageAtomFamily(id));
      if (!msg?.parts) continue;
      for (const part of msg.parts) {
        if (!part || typeof part.type !== 'string') continue;
        if (!isFrinkPlanMessagePartType(part.type)) continue;
        const callId = (part as { toolCallId?: string }).toolCallId;
        if (typeof callId !== 'string' || callId.length === 0) continue;
        const input = (part as { input?: { status?: string; planId?: string } }).input;
        plans.push({ toolCallId: callId, planId: input?.planId, status: input?.status });
      }
    }
    if (plans.length === 0) return EMPTY_HIDDEN_SET;

    const approvedPlanIds = get(approvedPlanIdsAtomFamily(subChatId));
    let latestClosedIdx = -1;
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      if (p.status === 'approved' || p.status === 'in_progress' || p.status === 'completed') {
        latestClosedIdx = i;
      } else if (p.planId && approvedPlanIds.has(p.planId)) {
        latestClosedIdx = i;
      }
    }
    if (latestClosedIdx === -1) return EMPTY_HIDDEN_SET;

    // Fingerprint encodes the inputs that influence the result so we can short-circuit when the
    // derivation re-runs (any messageAtomFamily change re-runs this atom) but produces identical
    // output — subscribers keep the same Set reference and skip re-renders.
    const fingerprint = `${latestClosedIdx}|${plans
      .slice(0, latestClosedIdx + 1)
      .map((p) => p.toolCallId)
      .join(',')}`;
    const cached = hiddenApprovalPlanIdsCache.get(subChatId);
    if (cached?.fingerprint === fingerprint) return cached.result;
    const hidden = new Set<string>();
    for (let i = 0; i <= latestClosedIdx; i++) hidden.add(plans[i].toolCallId);
    hiddenApprovalPlanIdsCache.set(subChatId, { fingerprint, result: hidden });
    return hidden;
  }),
);

// Key format: "subChatId:userMsgId"
const assistantIdsCachePerSubChat = new Map<string, string[]>();
export const assistantIdsForSubChatMsgAtomFamily = atomFamily((key: string) => {
  const separatorIdx = key.indexOf(':');
  const subChatId = key.substring(0, separatorIdx);
  const userMsgId = key.substring(separatorIdx + 1);

  return atom((get) => {
    const groups = get(messageGroupsForSubChatAtomFamily(subChatId));
    return lookupAssistantIds(groups, userMsgId, key, assistantIdsCachePerSubChat);
  });
});

// Key format: "subChatId:messageId"
export const isLastMessageForSubChatAtomFamily = atomFamily((key: string) => {
  const separatorIdx = key.indexOf(':');
  const subChatId = key.substring(0, separatorIdx);
  const messageId = key.substring(separatorIdx + 1);

  return atom((get) => {
    const lastId = get(lastMessageIdForSubChatAtomFamily(subChatId));
    return lastId === messageId;
  });
});

// Key format: "subChatId:userMsgId"
export const isLastUserMessageForSubChatAtomFamily = atomFamily((key: string) => {
  const separatorIdx = key.indexOf(':');
  const subChatId = key.substring(0, separatorIdx);
  const userMsgId = key.substring(separatorIdx + 1);

  return atom((get) => {
    const userIds = get(userMessageIdsForSubChatAtomFamily(subChatId));
    return userIds[userIds.length - 1] === userMsgId;
  });
});

// Key format: "subChatId:userMsgId"
export const isFirstUserMessageForSubChatAtomFamily = atomFamily((key: string) => {
  const separatorIdx = key.indexOf(':');
  const subChatId = key.substring(0, separatorIdx);
  const userMsgId = key.substring(separatorIdx + 1);

  return atom((get) => {
    const userIds = get(userMessageIdsForSubChatAtomFamily(subChatId));
    return userIds[0] === userMsgId;
  });
});

export const isStreamingForSubChatAtomFamily = atomFamily((subChatId: string) =>
  atom((get) => {
    const status = get(perSubChatStatusAtomFamily(subChatId));
    return isStatusStreaming(status);
  }),
);

// ============================================================================
// LAST ASSISTANT MESSAGE - For plan detection
// ============================================================================

// Cache for last assistant message to avoid re-reading on every check
// Keyed by subChatId to isolate per chat
const lastAssistantCacheByChat = new Map<string, { id: string | null; msg: Message | null }>();

// Feeds hasUnapprovedPlanAtom only; no product consumer. See sc-3431.
const lastAssistantMessageAtom = atom((get) => {
  const ids = get(messageIdsAtom);
  const roles = get(messageRolesAtom);
  const subChatId = get(currentSubChatIdAtom);

  // Find the last assistant ID
  let lastAssistantId: string | null = null;
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i];
    if (id && roles.get(id) === 'assistant') {
      lastAssistantId = id;
      break;
    }
  }

  const cached = lastAssistantCacheByChat.get(subChatId);

  if (!lastAssistantId) {
    lastAssistantCacheByChat.set(subChatId, { id: null, msg: null });
    return null;
  }

  // If same ID, return cached message
  if (lastAssistantId === cached?.id && cached.msg) {
    // But we need to get fresh message in case it changed during streaming
    const freshMsg = get(messageAtomFamily(lastAssistantId));
    if (freshMsg === cached.msg) {
      return cached.msg;
    }
    lastAssistantCacheByChat.set(subChatId, { id: lastAssistantId, msg: freshMsg });
    return freshMsg;
  }

  // Different ID, get fresh message
  const msg = get(messageAtomFamily(lastAssistantId));
  lastAssistantCacheByChat.set(subChatId, { id: lastAssistantId, msg });
  return msg;
});

// Has unapproved plan (for approve button)
export const hasUnapprovedPlanAtom = atom((get) => {
  const lastAssistant = get(lastAssistantMessageAtom);
  if (!lastAssistant) return false;

  const parts = lastAssistant.parts || [];
  for (const part of parts) {
    if (isPlanReadyPart(part)) return true;
  }
  return false;
});

// ============================================================================
// SYNC WITH STATUS - Main sync function
// ============================================================================
// This is called from useChat to sync messages to the store.
// Key optimization: Only updates atoms for messages that actually changed.
// ============================================================================

// Track previous message state to detect changes
// Key format: "subChatId:msgId" to isolate per chat
//
// NOTE: This is a simplified change detection optimized for streaming performance.
// It only checks the LAST part (partsLength + lastPartText + lastPartState).
// During streaming, only the last part changes, so this is sufficient and fast.
//
// Compare with messages-list.tsx which uses a more thorough check (all parts'
// textLengths[] and partStates[]) for useSyncExternalStore. That approach is
// more comprehensive but slightly slower. Both are correct for their use cases:
// - This (message-store): Jotai atom updates during high-frequency streaming
// - messages-list.tsx: External store subscription for React render triggering
const previousMessageState = new Map<
  string,
  {
    partsLength: number;
    lastPartText: string | undefined;
    lastPartState: string | undefined;
    lastPartInputJson: string | undefined;
    metadataJson: string | undefined;
  }
>();

function hasMessageChanged(subChatId: string, msgId: string, msg: UIMessage | Message): boolean {
  const cacheKey = `${subChatId}:${msgId}`;
  const prev = previousMessageState.get(cacheKey);
  const parts = msg.parts || [];
  const lastPart = parts[parts.length - 1];

  // Extract text, state, and input from lastPart (handles both UIMessagePart and MessagePart)
  const lastPartText =
    lastPart && 'text' in lastPart ? lastPart.text : (lastPart as MessagePart | undefined)?.text;
  const lastPartState =
    lastPart && 'state' in lastPart ? lastPart.state : (lastPart as MessagePart | undefined)?.state;
  const lastPartInput =
    lastPart && 'input' in lastPart ? lastPart.input : (lastPart as MessagePart | undefined)?.input;

  const current = {
    partsLength: parts.length,
    lastPartText,
    lastPartState,
    lastPartInputJson: lastPartInput ? JSON.stringify(lastPartInput) : undefined,
    metadataJson: msg.metadata ? JSON.stringify(msg.metadata) : undefined,
  };

  if (!prev) {
    previousMessageState.set(cacheKey, current);
    return true;
  }

  const changed =
    prev.partsLength !== current.partsLength ||
    prev.lastPartText !== current.lastPartText ||
    prev.lastPartState !== current.lastPartState ||
    prev.lastPartInputJson !== current.lastPartInputJson ||
    prev.metadataJson !== current.metadataJson;

  if (changed) {
    previousMessageState.set(cacheKey, current);
  }

  return changed;
}

// Rollback filter: after rollback, the AI SDK Chat instance re-provides rolled-back
// messages (both immediately and when the user sends a new message). This filter strips
// those IDs from every sync until useChat stops providing them.
const rollbackFilteredIds = new Map<string, Set<string>>();

export function setRollbackFilter(subChatId: string, removedIds: string[]): void {
  if (removedIds.length === 0) return;
  const existing = rollbackFilteredIds.get(subChatId) ?? new Set();
  for (const id of removedIds) existing.add(id);
  rollbackFilteredIds.set(subChatId, existing);
}

/** Filter rolled-back message IDs from a list. Used by the transport when sending
 *  a new message — useChat's internal state still contains rolled-back messages
 *  and would send them as conversation history to the agent without this. */
export function applyRollbackFilter<T extends { id: string }>(
  subChatId: string,
  messages: T[],
): T[] {
  const filterSet = rollbackFilteredIds.get(subChatId);
  if (!filterSet || filterSet.size === 0) return messages;
  return messages.filter((m) => !filterSet.has(m.id));
}

export function clearRollbackFilter(subChatId: string): void {
  rollbackFilteredIds.delete(subChatId);
}

export const syncMessagesWithStatusAtom = atom(
  null,
  (
    get,
    set,
    payload: {
      messages: UIMessage[];
      status: string;
      subChatId?: string;
      /** When false, skip writing to global singleton atoms (split view inactive panes). */
      isActive?: boolean;
    },
  ) => {
    const { messages: rawMessages, status, subChatId, isActive = true } = payload;

    const prevSubChatId = get(currentSubChatIdAtom);
    const currentSubChatId = subChatId ?? prevSubChatId;

    // Rollback filter: strip rolled-back message IDs that the AI SDK Chat instance
    // keeps re-providing. Only auto-clear when useChat provides a non-empty list
    // without any filtered IDs — empty syncs are transient and don't prove useChat
    // has caught up, so they must NOT clear the filter (otherwise the next stale
    // sync with the old IDs would slip through).
    let messages = rawMessages;
    const filterSet = rollbackFilteredIds.get(currentSubChatId);
    if (filterSet && filterSet.size > 0) {
      const hasFilteredIds = rawMessages.some((m) => filterSet.has(m.id));
      if (hasFilteredIds) {
        messages = rawMessages.filter((m) => !filterSet.has(m.id));
      } else if (rawMessages.length > 0) {
        rollbackFilteredIds.delete(currentSubChatId);
      }
    }

    // Build new IDs list and roles map
    const newIds = messages.map((m) => m.id);
    const newRoles = new Map<string, 'user' | 'assistant' | 'system'>();
    for (const msg of messages) {
      newRoles.set(msg.id, msg.role);
    }

    // ===================================================================
    // Global atom sync (only when this is the active/focused sub-chat)
    // In split view, only the active pane writes to global atoms to avoid
    // collision. All panes write to per-subChat atoms below.
    // ===================================================================
    if (isActive) {
      // Update current subChatId if provided AND changed
      if (subChatId && subChatId !== prevSubChatId) {
        set(currentSubChatIdAtom, subChatId);
      }

      // Update status only if changed AND not during remote streaming
      const isRemoteStreaming = get(remoteStreamingAtom);
      if (!isRemoteStreaming) {
        const prevStatus = get(chatStatusAtom);
        if (status !== prevStatus) {
          set(chatStatusAtom, status);
        }
      }

      const currentIds = get(messageIdsAtom);
      const currentRoles = get(messageRolesAtom);

      // Check if IDs changed (new message added or removed)
      const idsChanged =
        newIds.length !== currentIds.length || newIds.some((id, i) => id !== currentIds[i]);
      if (idsChanged) {
        set(messageIdsAtom, newIds);
      }

      // Check if roles changed
      let rolesChanged = newRoles.size !== currentRoles.size;
      if (!rolesChanged) {
        for (const [id, role] of newRoles) {
          if (currentRoles.get(id) !== role) {
            rolesChanged = true;
            break;
          }
        }
      }
      if (rolesChanged) {
        set(messageRolesAtom, newRoles);
      }
    }

    // ===================================================================
    // Individual message atoms (always update — keyed by message ID, not global)
    // ===================================================================
    // CRITICAL: AI SDK mutates objects in-place, so we MUST create a new reference
    // for Jotai to detect the change (it uses Object.is() for comparison)
    for (const uiMsg of messages) {
      const currentAtomValue = get(messageAtomFamily(uiMsg.id));
      const msgChanged = hasMessageChanged(currentSubChatId, uiMsg.id, uiMsg);

      if (msgChanged || !currentAtomValue) {
        const msg = toMessage(uiMsg);
        const clonedMsg = {
          ...msg,
          parts: msg.parts?.map((part) => ({
            ...part,
            input: part.input ? { ...part.input } : undefined,
          })),
        };
        set(messageAtomFamily(uiMsg.id), clonedMsg);
      }
    }

    // Cleanup removed message atoms (only for MAIN-window IDs; never remove prepended — they're not in activeMessageIdsByChat)
    const newIdsSet = new Set(newIds);
    const prependedIds = get(perSubChatPrependedIdsAtomFamily(currentSubChatId));
    const prependedSet = new Set(prependedIds);
    const previousIds = activeMessageIdsByChat.get(currentSubChatId) ?? new Set();
    for (const oldId of previousIds) {
      if (!newIdsSet.has(oldId) && !prependedSet.has(oldId)) {
        messageAtomFamily.remove(oldId);
        previousMessageState.delete(`${currentSubChatId}:${oldId}`);
      }
    }
    activeMessageIdsByChat.set(currentSubChatId, newIdsSet);

    // ===================================================================
    // Per-subChat sync (for split view support) — write only MAIN slice
    // ===================================================================
    const prevMainIds = get(perSubChatMainMessageIdsAtomFamily(currentSubChatId));
    const mainIdsChanged = !sameIdListOrder(prevMainIds, newIds);
    if (mainIdsChanged) {
      set(perSubChatMainMessageIdsAtomFamily(currentSubChatId), newIds);
    }
    set(perSubChatMainMessageRolesAtomFamily(currentSubChatId), newRoles);
    set(perSubChatStatusAtomFamily(currentSubChatId), status);
  },
);

/**
 * Prepend older messages (from "load more") to the display. Does not touch main-window state.
 * Call when getSubChatMessages(..., beforeMessageId) returns. Prepended messages are display-only (not in AI context).
 *
 * Display order comes from {@link perSubChatMessageIdsAtomFamily}: `[...prependedIds, ...mainIds]`.
 * API pagination can repeat a boundary id (already in `main` or a prior prepend); those rows are
 * skipped here so the combined id list stays unique and list rendering keys stay stable.
 * Duplicate ids in the incoming batch are deduped the same way. This path does **not** merge or replace
 * an existing message if the same id were ever resent with different content (not expected for pagination).
 */
export const prependOlderMessagesAtom = atom(
  null,
  (get, set, payload: { subChatId: string; messages: UIMessage[] }) => {
    const { subChatId, messages } = payload;
    if (messages.length === 0) return;

    const mainIds = get(perSubChatMainMessageIdsAtomFamily(subChatId));
    const existingPrependedIds = get(perSubChatPrependedIdsAtomFamily(subChatId));
    const alreadyPresent = new Set<string>([...mainIds, ...existingPrependedIds]);

    const toPrepend: UIMessage[] = [];
    const seenInBatch = new Set<string>();
    for (const uiMsg of messages) {
      if (alreadyPresent.has(uiMsg.id) || seenInBatch.has(uiMsg.id)) continue;
      seenInBatch.add(uiMsg.id);
      toPrepend.push(uiMsg);
      alreadyPresent.add(uiMsg.id);
    }
    if (toPrepend.length === 0) return;

    const newIds = toPrepend.map((m) => m.id);
    const newRoles = new Map<string, 'user' | 'assistant' | 'system'>();
    for (const msg of toPrepend) {
      newRoles.set(msg.id, msg.role);
    }

    for (const uiMsg of toPrepend) {
      const msg = toMessage(uiMsg);
      const clonedMsg = {
        ...msg,
        parts: msg.parts?.map((part) => ({
          ...part,
          input: part.input ? { ...part.input } : undefined,
        })),
      };
      set(messageAtomFamily(uiMsg.id), clonedMsg);
    }

    const existingPrepended = get(perSubChatPrependedIdsAtomFamily(subChatId));
    set(perSubChatPrependedIdsAtomFamily(subChatId), [...newIds, ...existingPrepended]);

    const existingPrependedRoles = get(perSubChatPrependedRolesAtomFamily(subChatId));
    const mergedPrependedRoles = new Map(existingPrependedRoles);
    for (const [id, role] of newRoles) mergedPrependedRoles.set(id, role);
    set(perSubChatPrependedRolesAtomFamily(subChatId), mergedPrependedRoles);
  },
);

// ============================================================================
// EXECUTION ERROR ROLLBACK - Remove last user + assistant on execution failure
// ============================================================================
// When set to a subChatId, the component showing that chat should remove the
// last two messages (failed user send + empty/error assistant) and reset this.
export const executionErrorRollbackSubChatIdAtom = atom<string | null>(null);

// ============================================================================
// CLEANUP - For clearing store when switching chats
// ============================================================================

/**
 * Clear only the prepended (older) message slice for a sub-chat.
 * Call after rollback so the timeline does not retain stale prepended messages.
 */
export function clearPrependedForSubChat(subChatId: string): void {
  const prependedIdsAtom = perSubChatPrependedIdsAtomFamily(subChatId);
  try {
    const ids = appStore.get(prependedIdsAtom);
    for (const id of ids) {
      messageAtomFamily.remove(id);
      previousMessageState.delete(`${subChatId}:${id}`);
    }
  } catch {
    // Atom may not be initialized
  }
  userMsgIdsCachePerSubChat.delete(subChatId);
  messageGroupsCachePerSubChat.delete(subChatId);
  hiddenApprovalPlanIdsCache.delete(subChatId);
  appStore.set(prependedIdsAtom, []);
  appStore.set(perSubChatPrependedRolesAtomFamily(subChatId), new Map());
}

// Clear all caches for a specific subChat (call when unmounting/switching)
export function clearSubChatCaches(subChatId: string) {
  // Clear rollback filter for this sub-chat
  rollbackFilteredIds.delete(subChatId);

  // Clear message atoms (main + prepended)
  const activeIds = activeMessageIdsByChat.get(subChatId);
  if (activeIds) {
    for (const id of activeIds) {
      messageAtomFamily.remove(id);
      previousMessageState.delete(`${subChatId}:${id}`);
    }
    activeMessageIdsByChat.delete(subChatId);
  }
  // Remove prepended message atoms (prepended IDs are not in activeMessageIdsByChat)
  const prependedIds = perSubChatPrependedIdsAtomFamily(subChatId);
  try {
    const ids = appStore.get(prependedIds);
    for (const id of ids) {
      messageAtomFamily.remove(id);
      previousMessageState.delete(`${subChatId}:${id}`);
    }
  } catch {
    // Atom may not be initialized
  }

  // Clear other caches
  lastAssistantCacheByChat.delete(subChatId);

  // Clear per-subChat caches
  userMsgIdsCachePerSubChat.delete(subChatId);
  messageGroupsCachePerSubChat.delete(subChatId);
  hiddenApprovalPlanIdsCache.delete(subChatId);
  // Clear assistantIds entries for this subChat (keyed as "subChatId:userMsgId")
  for (const key of assistantIdsCachePerSubChat.keys()) {
    if (key.startsWith(`${subChatId}:`)) {
      assistantIdsCachePerSubChat.delete(key);
    }
  }

  // Clean up per-subChat atomFamily entries (base atoms)
  perSubChatMainMessageIdsAtomFamily.remove(subChatId);
  perSubChatPrependedIdsAtomFamily.remove(subChatId);
  perSubChatMainMessageRolesAtomFamily.remove(subChatId);
  perSubChatPrependedRolesAtomFamily.remove(subChatId);
  perSubChatMessageIdsAtomFamily.remove(subChatId);
  perSubChatMessageRolesAtomFamily.remove(subChatId);
  perSubChatStatusAtomFamily.remove(subChatId);

  // Clean up derived per-subChat atomFamily entries (simple-key)
  lastMessageIdForSubChatAtomFamily.remove(subChatId);
  userMessageIdsForSubChatAtomFamily.remove(subChatId);
  messageGroupsForSubChatAtomFamily.remove(subChatId);
  isStreamingForSubChatAtomFamily.remove(subChatId);
  chatHasGitContextAtomFamily.remove(subChatId);
  flowRunIncompleteAtomFamily.remove(subChatId);

  // Clean up composite-key atomFamily entries ("subChatId:messageId")
  if (activeIds) {
    for (const msgId of activeIds) {
      assistantIdsForSubChatMsgAtomFamily.remove(`${subChatId}:${msgId}`);
      isLastMessageForSubChatAtomFamily.remove(`${subChatId}:${msgId}`);
      isLastUserMessageForSubChatAtomFamily.remove(`${subChatId}:${msgId}`);
      isFirstUserMessageForSubChatAtomFamily.remove(`${subChatId}:${msgId}`);
    }
  }
}
