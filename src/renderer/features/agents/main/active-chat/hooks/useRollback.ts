import type { UIMessage } from 'ai';
import type { RefObject } from 'react';
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { stripMessageMarkers } from '../../../../../../shared/lib/message-markers/strip-message-markers';
import { appStore } from '../../../../../lib/jotai-store';
import { trpcClient } from '../../../../../lib/trpc';
import { pendingChatRetryAtomFamily, taskExecutionErrorAtomFamily } from '../../../atoms';
import { detectExternalSideEffects } from '../../../lib/detect-external-side-effects';
import type { AgentsMentionsEditorHandle } from '../../../mentions/agents-mentions-editor';
import type { Message, RollbackMode } from '../../../stores/message-store';
import {
  clearPrependedForSubChat,
  perSubChatMainMessageIdsAtomFamily,
  perSubChatMessageIdsAtomFamily,
  setRollbackFilter,
  syncMessagesWithStatusAtom,
} from '../../../stores/message-store';
import type { PendingRollbackConfirm } from '../components/RollbackConfirmDialog';
import { STRINGS } from '../constants';

type Props = {
  subChatId: string;
  isStreaming: boolean;
  setMessages: (messages: Message[]) => void;
  recomputeChangedFiles: (messages: Message[]) => void;
  refreshDiff?: () => void;
  editorRef: RefObject<AgentsMentionsEditorHandle | null>;
};

export function useRollback({
  subChatId,
  isStreaming,
  setMessages,
  recomputeChangedFiles,
  refreshDiff,
  editorRef,
}: Props) {
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [rollbackConfirm, setRollbackConfirm] = useState<PendingRollbackConfirm | null>(null);

  const setMessagesRef = useRef(setMessages);
  const recomputeChangedFilesRef = useRef(recomputeChangedFiles);
  const refreshDiffRef = useRef(refreshDiff);
  const isStreamingRef = useRef(isStreaming);
  const isRollingBackRef = useRef(isRollingBack);

  setMessagesRef.current = setMessages;
  recomputeChangedFilesRef.current = recomputeChangedFiles;
  refreshDiffRef.current = refreshDiff;
  isStreamingRef.current = isStreaming;

  const handleRollback = useCallback(
    async (userMsgId: string, userTextContent: string, mode: RollbackMode = 'chat-and-code') => {
      if (isRollingBackRef.current) {
        toast.error('Rollback already in progress');
        return;
      }
      if (isStreamingRef.current) {
        toast.error('Cannot rollback while streaming');
        return;
      }

      const proceed = async () => {
        // Re-check here, not only at entry: the confirm dialog defers execution, and a flow
        // continuation can begin streaming while it is open. Rolling back mid-stream would
        // truncate history + revert git underneath an in-flight write.
        if (isStreamingRef.current) {
          toast.error('Cannot rollback while streaming');
          return;
        }

        setIsRollingBack(true);
        isRollingBackRef.current = true;

        try {
          const result = await trpcClient.chats.rollbackToMessage.mutate({
            subChatId,
            userMessageId: userMsgId,
            mode,
          });

          if (!result.success) {
            toast.error(`Failed to rollback: ${result.error}`);
            setIsRollingBack(false);
            isRollingBackRef.current = false;
            return;
          }

          if (mode === 'chat-and-code' && !result.gitReverted) {
            toast.warning('Chat reverted — git checkpoint not found, code unchanged');
          }

          clearPrependedForSubChat(subChatId);

          const resultMsgIds = (result.messages as Message[]).map((m: Message) => m.id);

          // Compute which IDs are being removed so the filter can strip them
          // from future syncs (AI SDK Chat instance re-provides old messages).
          const currentMainIds = appStore.get(perSubChatMainMessageIdsAtomFamily(subChatId));
          const resultIdSet = new Set(resultMsgIds);
          const removedIds = currentMainIds.filter((id) => !resultIdSet.has(id));

          // 1. Set persistent filter BEFORE syncs — strips rolled-back IDs from
          // all future MessageSyncManager syncs until useChat stops providing them.
          setRollbackFilter(subChatId, removedIds);

          // 2. Direct Jotai sync — sets correct UI state immediately
          appStore.set(syncMessagesWithStatusAtom, {
            messages: result.messages as unknown as UIMessage[],
            status: 'ready',
            subChatId,
            isActive: true,
          });

          // 3. Update useChat internal state (may trigger stale re-sync — filter strips it)
          setMessagesRef.current(result.messages as Message[]);

          // Rollback removes the failed user/assistant turn from the chat — any error
          // banner or pending-retry state tied to that turn is now stale and would
          // otherwise persist over a fresh history.
          appStore.set(taskExecutionErrorAtomFamily(subChatId), null);
          appStore.set(pendingChatRetryAtomFamily(subChatId), null);

          recomputeChangedFilesRef.current(result.messages as Message[]);
          refreshDiffRef.current?.();

          // Restore what the user can actually edit — the message body. Display markers (trigger,
          // task, question-answer) would land in the composer as raw HTML comments.
          const editableText = stripMessageMarkers(userTextContent ?? '');
          if (editableText) {
            editorRef.current?.setValue(editableText);
            editorRef.current?.focus();
          }
        } catch (_error) {
          toast.error(STRINGS.FAILED_TO_ROLLBACK);
        } finally {
          setIsRollingBack(false);
          isRollingBackRef.current = false;
        }
      };

      // Warn before discarding turns that made external integration writes: rollback
      // restores Frink's chat + worktree, but cannot undo those external changes.
      const orderedIds = appStore.get(perSubChatMessageIdsAtomFamily(subChatId));
      const effects = detectExternalSideEffects(orderedIds, userMsgId);
      if (effects.length > 0) {
        setRollbackConfirm({
          effects,
          onConfirm: () => {
            setRollbackConfirm(null);
            void proceed();
          },
        });
        return;
      }

      void proceed();
    },
    [subChatId, editorRef],
  );

  return {
    handleRollback,
    isRollingBack,
    rollbackConfirm,
    dismissRollbackConfirm: () => setRollbackConfirm(null),
  };
}
