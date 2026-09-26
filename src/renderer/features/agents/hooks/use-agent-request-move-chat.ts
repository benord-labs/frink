/**
 * Handles agent:move-chat-approved IPC from main process.
 * Same flow as drag-and-drop: move the existing chat to the new project (full history kept).
 * Updates store, invalidates caches, and switches UI to the moved chat.
 */

import { useSetAtom } from 'jotai';
import { useEffect, useRef } from 'react';
import { focusAgentChatAtom } from '../../../lib/atoms';
import { appStore } from '../../../lib/jotai-store';
import { trpc } from '../../../lib/trpc';
import { navigationSessionIdAtomFamily, pendingMoveChatContinuationAtom } from '../atoms';
import { agentChatStore } from '../stores/agent-chat-store';

type MoveChatApprovedPayload = {
  chatId: string;
  subChatId: string;
  projectId: string;
  projectName: string;
  projectPath: string;
  requestedWorktreePath: string | null;
  navigationSessionId: string;
};

export function useAgentRequestMoveChat() {
  const setMoveChatContinuation = useSetAtom(pendingMoveChatContinuationAtom);
  const utils = trpc.useUtils();
  const utilsRef = useRef(utils);
  utilsRef.current = utils;

  useEffect(() => {
    const api = window.desktopApi as unknown as {
      onAgentMoveChatApproved?: (cb: (data: MoveChatApprovedPayload) => void) => () => void;
    };
    if (!api?.onAgentMoveChatApproved) return;

    const cleanup = api.onAgentMoveChatApproved((data: MoveChatApprovedPayload) => {
      // Same as UnifiedSidebar handleMoveChat: store expects move before refetch
      agentChatStore.setPendingMoveTarget(
        data.chatId,
        data.projectId,
        data.requestedWorktreePath ?? null,
      );
      agentChatStore.clearAllForChat(data.chatId);
      appStore.set(navigationSessionIdAtomFamily(data.subChatId), data.navigationSessionId);
      // Reveal transient destinations before invalidation, while preserving a Flows editor whose
      // dirty-navigation contract must remain user-controlled.
      appStore.set(focusAgentChatAtom, data.chatId);

      const latestUtils = utilsRef.current;
      void Promise.all([
        latestUtils.chats.list.invalidate(),
        latestUtils.chats.listCounts.invalidate(),
        latestUtils.chats.listByFolder.invalidate(),
        latestUtils.chats.get.invalidate({ id: data.chatId }),
        latestUtils.chats.getSubChatMessages.invalidate(),
        latestUtils.claudeCode.getResolvedAccount.invalidate({ chatId: data.chatId }),
        latestUtils.claudeCode.getResolvedAccount.invalidate({ projectId: data.projectId }),
      ])
        .then(() => {
          // Queue a continuation prompt so the agent auto-resumes in the new CWD
          // after handleRemoteStop kills the old execution.
          setMoveChatContinuation({
            chatId: data.chatId,
            subChatId: data.subChatId,
            projectName: data.projectName,
            projectPath: data.projectPath,
          });
        })
        .catch(() => {
          // Clear the pending move target so a failed invalidation doesn't strand the Chat
          // instance behind isDataFreshForChat (permanent black screen). Mirrors the DnD path.
          agentChatStore.clearPendingMoveTarget(data.chatId);
          // Best-effort fallback: still navigate + queue continuation.
          setMoveChatContinuation({
            chatId: data.chatId,
            subChatId: data.subChatId,
            projectName: data.projectName,
            projectPath: data.projectPath,
          });
        });
    });

    return cleanup;
  }, [setMoveChatContinuation]);
}
