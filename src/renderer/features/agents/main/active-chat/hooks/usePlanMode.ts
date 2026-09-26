import { useAtom } from 'jotai';
import { useCallback, useEffect, useRef } from 'react';
import type { ChatMode } from '../../../../../../shared/types/chat-mode';
import { appStore } from '../../../../../lib/jotai-store';
import { api } from '../../../../../lib/mock-api';
import { ackModeIntent, pendingModeIntentAtomFamily } from '../../../../../lib/stores/mode-intent';
import { chatModeAtomFamily } from '../../../atoms';
import { useAgentSubChatStore } from '../../../stores/sub-chat-store';

/** Per sub-chat: the last PERSISTED mode plus how many of its toggles are still in flight. */
type InFlightToggles = Map<string, { persisted: ChatMode; inFlight: number }>;

/** One toggle settled; the entry is released once no toggle is pending so the next gesture re-seeds from the store. */
function settleToggle(toggles: InFlightToggles, subChatId: string): ChatMode | undefined {
  const entry = toggles.get(subChatId);
  if (entry && --entry.inFlight === 0) toggles.delete(subChatId);
  return entry?.persisted;
}

/**
 * Hook to manage chat mode state for a sub-chat.
 *
 * Mode transitions are raised by GESTURE HANDLERS through `commitModeChange` — never inferred
 * from atom changes. Programmatic atom writes (dispatch stamps, mode-change echoes) are mirrors
 * only: they must not persist or arm intents (decision `sub-chat-mode-ownership`).
 */
export const useChatMode = (subChatId: string, parentChatId: string) => {
  const [chatMode, setChatMode] = useAtom(chatModeAtomFamily(parentChatId));
  const utils = api.useUtils();

  // Track last initialized sub-chat to prevent re-initialization
  const lastInitializedRef = useRef<string | null>(null);

  // Overlapping toggles on one sub-chat share this entry: a failure reverts to the last mode a
  // sibling actually persisted, not to a pre-gesture snapshot an earlier success may have cleared.
  const inFlightTogglesRef = useRef<InFlightToggles>(new Map());

  // Mutation for updating sub-chat mode in database
  const updateSubChatModeMutation = api.agents.updateSubChatMode.useMutation({
    onSuccess: async (data, variables) => {
      void utils.agents.getAgentChat.invalidate({ chatId: parentChatId });
      // Correlated CAS ack: settle exactly the mode THIS mutation persisted — a newer toggle's
      // intent armed while it was in flight must survive a stale ack. A null result means no row
      // exists yet (chat still being created): nothing was persisted, so the armed intent stays
      // the sole carrier of the user's choice until the first send writes it.
      if (data !== null) {
        ackModeIntent(variables.subChatId, variables.mode);
        const entry = inFlightTogglesRef.current.get(variables.subChatId);
        if (entry) entry.persisted = variables.mode;
      }
      settleToggle(inFlightTogglesRef.current, variables.subChatId);
      // A mode change closes or opens an approval epoch in persisted state. Cancel before
      // invalidating so an older in-flight poll cannot repopulate the sidebar indicator.
      await utils.agents.getPendingPlanApprovals.cancel();
      await utils.agents.getPendingPlanApprovals.invalidate();
    },
    onError: (_error, { subChatId, mode }) => {
      const revertedMode = settleToggle(inFlightTogglesRef.current, subChatId) ?? 'agent';

      // CAS-disarm the FAILED toggle's intent so a later send can't silently apply what the UI
      // no longer shows; a newer toggle's intent survives (its own ack settles it).
      ackModeIntent(subChatId, mode);

      // Revert only while the display still shows the failed toggle: a newer toggle has its own
      // ack/revert, and a stale failure must not drag the display back over it.
      const subChat = useAgentSubChatStore.getState().subChatsById[subChatId];
      if (subChat?.mode !== mode) return;
      useAgentSubChatStore.getState().updateSubChatMode(subChatId, revertedMode, parentChatId);
      setChatMode(revertedMode);
    },
  });

  const { mutate: updateSubChatMode } = updateSubChatModeMutation;

  // Initialize mode from sub-chat metadata ONLY when switching sub-chats.
  // The atom is CHAT-scoped but this hook mounts once per open tab, so only the ACTIVE tab may
  // write its row's mode into the shared atom — a background tab initializing would stamp ITS
  // mode over the visible one.
  useEffect(() => {
    if (subChatId && subChatId !== lastInitializedRef.current) {
      const store = useAgentSubChatStore.getState();
      const subChat = store.subChatsById[subChatId];
      if (subChat?.mode && store.activeSubChatId === subChatId) {
        setChatMode(subChat.mode);
      }
      lastInitializedRef.current = subChatId;
    }
  }, [subChatId, setChatMode]);

  /**
   * Raise a USER mode transition: optimistic store + atom update, arm the send-carried intent,
   * and persist the row — the mode's owner (decision `sub-chat-mode-ownership`). This is the only
   * place a gesture becomes a row write; plan approval keeps its own send-carried path.
   */
  const commitModeChange = useCallback(
    (mode: ChatMode) => {
      if (!subChatId || mode === chatMode) return;
      const store = useAgentSubChatStore.getState();
      const toggles = inFlightTogglesRef.current;
      const entry = toggles.get(subChatId);
      if (entry) entry.inFlight += 1;
      else {
        const persisted = store.subChatsById[subChatId]?.mode ?? chatMode;
        toggles.set(subChatId, { persisted, inFlight: 1 });
      }
      store.updateSubChatMode(subChatId, mode, parentChatId);
      appStore.set(pendingModeIntentAtomFamily(subChatId), mode);
      setChatMode(mode);
      // No ordering guard needed: the router serializes each sub-chat's writes under
      // withSubChatLock and IPC keeps request order, so overlapping toggles persist in gesture
      // order, and each write echoes the CONFIRMED row value that the mirrors follow.
      updateSubChatMode({ subChatId, mode });
    },
    [subChatId, chatMode, setChatMode, updateSubChatMode],
  );

  return {
    chatMode,
    setChatMode,
    commitModeChange,
  };
};
