import type { Chat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import { activeListeners } from '../../../lib/stores/active-transport-registry';
import { useStreamingStatusStore } from './streaming-status-store';

/**
 * Simple module-level storage for Chat objects.
 * Lives outside React lifecycle so chats persist across component mount/unmount.
 */

/** Chat instances torn down mid-turn: their onFinish must not chime for a turn main still runs. */
const tornDown = new WeakSet<Chat<UIMessage>>();

/** Tear down the deleted Chat's transport, closing its stream. Snapshot the owned listener before the
 * lazy import: a Chat re-created meanwhile owns a newer one, so only the old stream is closed then. */
async function cleanupChatListeners(chatId: string, chat?: Chat<UIMessage>): Promise<void> {
  const owned = activeListeners.get(chatId);
  if (owned && chat) tornDown.add(chat);
  const { cleanupTransportListeners } = await import('../lib/websocket-chat-transport');
  if (activeListeners.get(chatId) === owned) cleanupTransportListeners(chatId);
  else owned?.(true);
}

const chats = new Map<string, Chat<UIMessage>>();
const streamIds = new Map<string, string | null>();
const parentChatIds = new Map<string, string>(); // subChatId → parentChatId (stored at creation time)
const manuallyAborted = new Map<string, boolean>(); // Track if chat was manually stopped
const chatProjectPaths = new Map<string, string | undefined>(); // subChatId → projectPath (for detecting moves)
const pendingMoveTargets = new Map<
  string,
  {
    projectId: string | null;
    requestedWorktreePath: string | null;
  }
>(); // chatId → pending target identity
// Chats driven by a flow run (marked on every headless task:chat-ready). Read LIVE at turn
// finish to suppress the per-node chime — a creation-time isFlowDriven snapshot goes stale
// when a Chat is built before the flow's first dispatch links it (or is rehydrated mid-run).
// Monotonic per session: chats.taskId is durable, so flow-ness never reverts.
const flowChatIds = new Set<string>(); // parent chatId

/**
 * Notified whenever a Chat is registered for a sub-chat.
 *
 * Every other input the queue processor gates on is a store it can subscribe to, so a gate that
 * fails transiently re-fires when the value changes. This Map is the exception: a pane re-creating
 * its Chat leaves `get` empty for a beat, and a plain Map cannot announce the replacement — an item
 * that reached its dispatch tick in that window would then wait for an unrelated store write that
 * may never come.
 */
const registrationListeners = new Set<(subChatId: string) => void>();

/** Subscribe to Chat registrations. Returns an unsubscribe fn. */
export function onChatRegistered(listener: (subChatId: string) => void): () => void {
  registrationListeners.add(listener);
  return () => {
    registrationListeners.delete(listener);
  };
}

function subChatIdsForChat(chatId: string): string[] {
  const subChatIds: string[] = [];
  for (const [subChatId, parentId] of parentChatIds) {
    if (parentId === chatId) subChatIds.push(subChatId);
  }
  return subChatIds;
}

const BACKSLASH_REGEX = /\\/g;
const TRAILING_SLASHES_REGEX = /\/+$/;

export function normalizeWorktreePath(path: string | null | undefined): string | null {
  if (!path) return null;
  const slashNormalized = path.replace(BACKSLASH_REGEX, '/');
  const trimmedTrailing = slashNormalized.replace(TRAILING_SLASHES_REGEX, '');
  return trimmedTrailing.length > 0 ? trimmedTrailing : '/';
}

export const agentChatStore = {
  get: (id: string) => chats.get(id),

  /**
   * Get a Chat instance, updating its stored projectPath if changed.
   * We no longer delete on mismatch - that caused race conditions where
   * in-flight messages were lost. Instead, we rely on clearAllForChat
   * being called during moves to properly reset the state.
   */
  getIfProjectMatches: (id: string, currentProjectPath: string | undefined) => {
    const chat = chats.get(id);
    if (!chat) return undefined;

    // Update the stored projectPath to current (don't delete on mismatch)
    // This handles cases where the data refreshes while Chat is active
    chatProjectPaths.set(id, currentProjectPath);
    return chat;
  },

  set: (id: string, chat: Chat<UIMessage>, parentChatId: string, projectPath?: string) => {
    chats.set(id, chat);
    parentChatIds.set(id, parentChatId);
    chatProjectPaths.set(id, projectPath);
    for (const listener of registrationListeners) listener(id);
  },

  has: (id: string) => chats.has(id),

  delete: (id: string) => {
    const chat = chats.get(id);
    chats.delete(id);
    streamIds.delete(id);
    parentChatIds.delete(id);
    manuallyAborted.delete(id);
    chatProjectPaths.delete(id);
    cleanupChatListeners(id, chat);
  },

  // Get the ORIGINAL parentChatId that was set when the Chat was created
  getParentChatId: (subChatId: string) => parentChatIds.get(subChatId),

  /** Sub-chats with a registered Chat under this parent. */
  getSubChatIdsForChat: (chatId: string) => subChatIdsForChat(chatId),

  getStreamId: (id: string) => streamIds.get(id),
  setStreamId: (id: string, streamId: string | null) => {
    streamIds.set(id, streamId);
  },

  /** Mark a parent chat as flow-driven (its turns never chime per-node). */
  markFlowChat: (chatId: string) => {
    flowChatIds.add(chatId);
  },
  isFlowChat: (chatId: string) => flowChatIds.has(chatId),

  // Track manual abort to prevent completion sound
  setManuallyAborted: (id: string, aborted: boolean) => {
    manuallyAborted.set(id, aborted);
  },
  wasManuallyAborted: (id: string) => manuallyAborted.get(id) ?? false,
  /** Instance-scoped: a Chat re-created on the same sub-chat never inherits it. */
  wasTornDown: (chat: Chat<UIMessage>) => tornDown.has(chat),
  clearManuallyAborted: (id: string) => {
    manuallyAborted.delete(id);
  },

  clear: () => {
    chats.clear();
    streamIds.clear();
    parentChatIds.clear();
    manuallyAborted.clear();
    chatProjectPaths.clear();
    flowChatIds.clear();
  },

  /**
   * Clear all sub-chats belonging to a parent chat.
   * Called when a chat is moved to a new project to force recreation with new projectPath.
   */
  clearAllForChat: (chatId: string) => {
    // Delete every sub-chat that belongs to this parent chat
    for (const subChatId of subChatIdsForChat(chatId)) {
      const chat = chats.get(subChatId);
      chats.delete(subChatId);
      streamIds.delete(subChatId);
      parentChatIds.delete(subChatId);
      manuallyAborted.delete(subChatId);
      chatProjectPaths.delete(subChatId);
      useStreamingStatusStore.getState().clearStatus(subChatId);
      cleanupChatListeners(subChatId, chat);
    }
  },

  /**
   * Set the target projectId for a pending move.
   * Used to prevent Chat creation with stale data during async move.
   */
  setPendingMoveTarget: (
    chatId: string,
    targetProjectId: string | null,
    requestedWorktreePath: string | null,
  ) => {
    pendingMoveTargets.set(chatId, {
      projectId: targetProjectId,
      requestedWorktreePath,
    });
  },

  /**
   * Clear the pending move target after data has refreshed.
   */
  clearPendingMoveTarget: (chatId: string) => {
    pendingMoveTargets.delete(chatId);
  },

  /**
   * Read pending move target for a chat.
   * Used by renderer logic to gate one-time move-specific rehydration.
   */
  getPendingMoveTarget: (chatId: string) => pendingMoveTargets.get(chatId),

  /**
   * Check if a chat has a pending move and if the current projectId matches the target.
   * Returns true if NO pending move OR if projectId matches target (data is fresh).
   * Returns false if pending move exists and projectId doesn't match (data is stale).
   */
  isDataFreshForChat: (
    chatId: string,
    currentProjectId: string | null | undefined,
    currentWorktreePath: string | null | undefined,
  ) => {
    const target = pendingMoveTargets.get(chatId);
    if (target === undefined) {
      // No pending move - data is fresh
      return true;
    }
    return (
      currentProjectId === target.projectId &&
      normalizeWorktreePath(currentWorktreePath) ===
        normalizeWorktreePath(target.requestedWorktreePath)
    );
  },
};
