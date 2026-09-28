/* eslint-disable max-lines, max-lines-per-function */
import { useSetAtom } from 'jotai';
import { useCallback, useEffect, useRef } from 'react';
import { commandFetcher } from '@/lib/commands/command-fetcher';
import { expandSlashCommand } from '@/lib/commands/expand-slash-command';
import { codeSelectionMention, pastedTextMention } from '@/lib/mentions/queued-message-text';
import { isRunBusy } from '../../../../../lib/agent-chat/steer/run-busy';
import { isCompactCommand } from '../../../../../../shared/commands/expand-slash-command';
import { stripHiddenWakeMarker } from '../../../../../../shared/lib/message-markers/hidden-wake-marker';
import type { ChatMode } from '../../../../../../shared/types/chat-mode';
import { getQueryClient } from '../../../../../contexts/TRPCProvider';
import { trackMessageSent } from '../../../../../lib/analytics';
import { pendingAccountAuthAtom } from '../../../../../lib/atoms';
import { api } from '../../../../../lib/mock-api';
import { notifySidebarChatActivity } from '../../../../sidebar/unified/sidebar-chat-activity';
import { pendingChatRetryAtomFamily } from '../../../atoms';
import type { UploadedFile, UploadedImage } from '../../../hooks/use-agents-file-upload';
import type { PastedTextFile } from '../../../hooks/use-pasted-text-files';
import { clearSubChatDraft } from '../../../lib/drafts';
import type {
  CodeSelectionContext,
  DiffTextContext,
  SelectedTextContext,
} from '../../../lib/queue-utils';
import {
  createQueueItem,
  generateQueueId,
  toQueuedCodeSelectionContext,
  toQueuedDiffTextContext,
  toQueuedFile,
  toQueuedImage,
  toQueuedPastedText,
  toQueuedTextContext,
} from '../../../lib/queue-utils';
import type { AgentsMentionsEditorHandle } from '../../../mentions';
import { MENTION_PREFIXES, MENTION_PREVIEW_SANITIZE_REGEX } from '../../../mentions';
import { useAgentSubChatStore } from '../../../stores/sub-chat-store';
import { clearFlowRunEndedErrorSignal, showAccountNotReadyToast, utf8ToBase64 } from '../utils';

type SendMessagePart =
  | { type: 'text'; text: string }
  | {
      type: 'data-image';
      data: { url: string; mediaType?: string; filename?: string; base64Data?: string };
    }
  | {
      type: 'data-file';
      data: { url: string; filename: string; size?: number };
    };

type SendMessageInput = {
  role: 'user' | 'assistant' | 'system';
  parts: SendMessagePart[];
};

type Props = {
  subChatId: string;
  parentChatId: string;
  projectPath?: string | null;
  teamId?: string;
  sandboxSetupStatus?: 'cloning' | 'ready' | 'error';
  isArchived: boolean;
  onRestoreWorkspace?: () => void;
  editorRef: React.RefObject<AgentsMentionsEditorHandle | null>;
  chatModeRef: React.RefObject<ChatMode>;
  isStreamingRef: React.RefObject<boolean>;
  imagesRef: React.RefObject<UploadedImage[]>;
  filesRef: React.RefObject<UploadedFile[]>;
  textContextsRef: React.RefObject<SelectedTextContext[]>;
  diffTextContextsRef: React.RefObject<DiffTextContext[]>;
  codeSelectionContextRef: React.RefObject<CodeSelectionContext | null>;
  activeFileRef: React.RefObject<{ name: string; path: string } | null>;
  activeFileExcludedRef: React.RefObject<boolean>;
  pastedTextsRef: React.RefObject<PastedTextFile[]>;
  sendMessageRef: React.RefObject<((input: SendMessageInput) => Promise<void>) | null>;
  scrollToBottom: () => void;
  clearAll: () => void;
  clearTextContexts: () => void;
  clearDiffTextContexts: () => void;
  clearCodeSelectionContext: () => void;
  clearPastedTexts: () => void;
  addToQueue: (
    subChatId: string,
    item: {
      id: string;
      message: string;
      images?: unknown[];
      files?: unknown[];
      textContexts?: unknown[];
      diffTextContexts?: unknown[];
      timestamp: Date;
      status: 'pending' | 'processing';
    },
  ) => void;
  /** After getResolvedAccount succeeded for this chat — required before direct sends (not queued). */
  isResolvedExecutionAccountReady: boolean;
  /** Set when the resolved account exists but is not authenticated — used to route the toast action. */
  unauthAccount?: { label: string; type: 'claude-code' | 'codex' } | null;
};

export function useMessageSend({
  subChatId,
  parentChatId,
  projectPath,
  teamId,
  sandboxSetupStatus = 'ready',
  isArchived,
  onRestoreWorkspace,
  editorRef,
  chatModeRef,
  isStreamingRef,
  imagesRef,
  filesRef,
  textContextsRef,
  diffTextContextsRef,
  codeSelectionContextRef,
  activeFileRef,
  activeFileExcludedRef,
  pastedTextsRef,
  sendMessageRef,
  scrollToBottom,
  clearAll,
  clearTextContexts,
  clearDiffTextContexts,
  clearCodeSelectionContext,
  clearPastedTexts,
  addToQueue,
  isResolvedExecutionAccountReady,
  unauthAccount,
}: Props) {
  const utils = api.useUtils();
  const clearPendingChatRetry = useSetAtom(pendingChatRetryAtomFamily(subChatId));
  const setPendingAccountAuth = useSetAtom(pendingAccountAuthAtom);

  // Blocks sends after unmount; set in setup too, as a hot update re-runs cleanup then setup.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleSend = useCallback(async () => {
    // Block sending while sandbox is still being set up
    if (sandboxSetupStatus !== 'ready') {
      return;
    }
    // Get value from uncontrolled editor
    // Typed text is the ONLY human intake, so an internal control token pasted literally is
    // neutralized here: left in place it would vanish from the transcript (the renderer
    // hides marker-prefixed bubbles) and read downstream as an already-dispatched wake.
    const inputValue = stripHiddenWakeMarker(editorRef.current?.getValue() || '');
    const hasText = inputValue.trim().length > 0;
    const currentImages = imagesRef.current ?? [];
    const currentFiles = filesRef.current ?? [];
    const currentTextContexts = textContextsRef.current ?? [];
    const currentCodeSelection = codeSelectionContextRef.current;
    const currentPastedTexts = pastedTextsRef.current ?? [];
    const hasImages = currentImages.filter((img) => !img.isLoading && img.url).length > 0;
    const hasTextContexts = currentTextContexts.length > 0;
    const hasCodeSelection = currentCodeSelection !== null;
    const hasPastedTexts = currentPastedTexts.length > 0;

    if (!hasText && !hasImages && !hasTextContexts && !hasCodeSelection && !hasPastedTexts) return;

    // While a turn runs (here or only in main), queue instead of sending directly
    if (isRunBusy(subChatId, isStreamingRef.current)) {
      const queuedImages = currentImages
        .filter((img) => !img.isLoading && img.url)
        .map(toQueuedImage);
      const queuedFiles = currentFiles.filter((f) => !f.isLoading && f.url).map(toQueuedFile);
      const queuedTextContexts = currentTextContexts.map(toQueuedTextContext);
      const queuedCodeSelections = currentCodeSelection
        ? [toQueuedCodeSelectionContext(currentCodeSelection)]
        : undefined;

      // Every attachment the direct path would send rides the item: a large paste lives only as a
      // chip (not editor text), so dropping it here lost the whole message (sc-3666).
      const queuedDiffTextContexts = (diffTextContextsRef.current ?? []).map(
        toQueuedDiffTextContext,
      );
      const item = createQueueItem(
        generateQueueId(),
        inputValue.trim(),
        queuedImages.length > 0 ? queuedImages : undefined,
        queuedFiles.length > 0 ? queuedFiles : undefined,
        queuedTextContexts.length > 0 ? queuedTextContexts : undefined,
        queuedDiffTextContexts,
        queuedCodeSelections,
        currentPastedTexts.map(toQueuedPastedText),
      );
      addToQueue(subChatId, item);

      // Clear input and attachments
      editorRef.current?.clear();
      if (parentChatId) {
        clearSubChatDraft(parentChatId, subChatId);
      }
      clearAll();
      clearTextContexts();
      clearDiffTextContexts();
      clearCodeSelectionContext();
      clearPastedTexts();
      return;
    }

    if (!isResolvedExecutionAccountReady) {
      showAccountNotReadyToast(unauthAccount, setPendingAccountAuth);
      return;
    }

    // Snapshot the send function BEFORE any async work to prevent race conditions.
    // If the user switches chats during the await, sendMessageRef.current may point
    // to a torn-down useChat instance. The snapshot preserves the correct target.
    const snapshotSendMessage = sendMessageRef.current;
    if (!snapshotSendMessage) {
      return;
    }

    // Auto-restore archived workspace when sending a message
    if (isArchived && onRestoreWorkspace) {
      onRestoreWorkspace();
    }

    const text = inputValue.trim();
    const finalText = await expandSlashCommand(text, projectPath ?? undefined, commandFetcher);

    // After the async gap (expandSlashCommand), bail out if this component
    // unmounted — e.g. the user opened a new chat pane during the await.
    if (!isMountedRef.current) {
      return;
    }

    // Clear editor and draft from localStorage
    editorRef.current?.clear();
    if (parentChatId) {
      clearSubChatDraft(parentChatId, subChatId);
    }

    // Track message sent
    trackMessageSent({
      workspaceId: subChatId,
      messageLength: finalText.length,
      mode: chatModeRef.current,
    });

    // Build message parts: images first, then files, then text
    const parts: SendMessagePart[] = [
      ...currentImages
        .filter((img) => !img.isLoading && img.url)
        .map((img) => ({
          type: 'data-image' as const,
          data: {
            url: img.url,
            mediaType: img.mediaType,
            filename: img.filename,
            base64Data: img.base64Data,
          },
        })),
      ...currentFiles
        .filter((f) => !f.isLoading && f.url)
        .map((f) => ({
          type: 'data-file' as const,
          data: {
            url: f.url,
            filename: f.filename,
            size: f.size,
          },
        })),
    ];

    // Add text contexts as mention tokens
    const currentDiffTextContexts = diffTextContextsRef.current ?? [];
    const currentActiveFile = activeFileRef.current;
    let mentionPrefix: string = '';

    // Include active file context if viewing a file (and no code selection from that file, and user hasn't excluded it)
    const shouldIncludeActiveFile =
      currentActiveFile &&
      !activeFileExcludedRef.current &&
      (!currentCodeSelection || currentCodeSelection.filePath !== currentActiveFile.path);

    // Mention tokens would push `/compact` off position 0 — see isCompactCommand.
    if (
      !isCompactCommand(finalText) &&
      (currentTextContexts.length > 0 ||
        currentDiffTextContexts.length > 0 ||
        currentCodeSelection ||
        shouldIncludeActiveFile ||
        currentPastedTexts.length > 0)
    ) {
      const quoteMentions = currentTextContexts.map((tc) => {
        const preview = tc.preview.replace(MENTION_PREVIEW_SANITIZE_REGEX, '');
        const encodedText = utf8ToBase64(tc.text);
        return `@[${MENTION_PREFIXES.QUOTE}${preview}:${encodedText}]`;
      });

      const diffMentions = currentDiffTextContexts.map((dtc) => {
        const preview = dtc.preview.replace(MENTION_PREVIEW_SANITIZE_REGEX, '');
        const encodedText = utf8ToBase64(dtc.text);
        const lineNum = dtc.lineNumber || 0;
        return `@[${MENTION_PREFIXES.DIFF}${dtc.filePath}:${lineNum}:${preview}:${encodedText}]`;
      });

      // Add code selection as mention token
      const codeMentions = currentCodeSelection ? [codeSelectionMention(currentCodeSelection)] : [];

      // Add active file as context (if not already included via code selection)
      const activeFileMention = shouldIncludeActiveFile
        ? [`@[${MENTION_PREFIXES.FILE}local:${currentActiveFile.path}]`]
        : [];

      const pastedTextMentions = currentPastedTexts.map(pastedTextMention);

      mentionPrefix = `${[...quoteMentions, ...diffMentions, ...codeMentions, ...activeFileMention, ...pastedTextMentions].join(' ')} `;
    }

    if (finalText || mentionPrefix) {
      parts.push({ type: 'text', text: mentionPrefix + (finalText || '') });
    }

    clearAll();
    clearTextContexts();
    clearDiffTextContexts();
    clearCodeSelectionContext();
    clearPastedTexts();

    // Optimistic update: immediately update chat's updated_at and resort array
    if (teamId) {
      const now = new Date();
      utils.agents.getAgentChats.setData(
        { teamId },
        (
          old: Array<{ id: string; updatedAt: Date | string; [key: string]: unknown }> | undefined,
        ) => {
          if (!old) return old;
          const updated = old.map((c) => (c.id === parentChatId ? { ...c, updatedAt: now } : c));
          return updated.sort(
            (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
          );
        },
      );
    }

    // Desktop app: Optimistic update for chats.list
    const queryClient = getQueryClient();
    if (queryClient) {
      const now = new Date();
      const queries = queryClient.getQueryCache().getAll();
      const chatsListQuery = queries.find(
        (q) =>
          Array.isArray(q.queryKey) &&
          Array.isArray(q.queryKey[0]) &&
          q.queryKey[0][0] === 'chats' &&
          q.queryKey[0][1] === 'list',
      );
      if (chatsListQuery) {
        queryClient.setQueryData(
          chatsListQuery.queryKey,
          (
            old:
              | Array<{ id: string; updatedAt: Date | string; [key: string]: unknown }>
              | undefined,
          ) => {
            if (!old) return old;
            const updated = old.map((c) => (c.id === parentChatId ? { ...c, updatedAt: now } : c));
            return updated.sort(
              (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
            );
          },
        );
      }
    }

    notifySidebarChatActivity(parentChatId);

    // Optimistically update sub-chat timestamp
    useAgentSubChatStore.getState().updateSubChatTimestamp(subChatId);

    // Re-arm stick-to-bottom and jump to the message just sent.
    scrollToBottom();

    // A new manual send supersedes any previously failed retry payload — and a latched
    // FLOW_RUN_ENDED signal (nothing else clears it for a flow sub-chat). Cleared here on user
    // intent, never from ambient stream chunks, and only for that category: an unrelated
    // failure must survive so task-failure detection still fires.
    clearPendingChatRetry(null);
    clearFlowRunEndedErrorSignal(subChatId);
    await snapshotSendMessage({ role: 'user', parts });
  }, [
    sandboxSetupStatus,
    isArchived,
    onRestoreWorkspace,
    parentChatId,
    projectPath,
    subChatId,
    clearAll,
    clearTextContexts,
    clearDiffTextContexts,
    clearCodeSelectionContext,
    clearPastedTexts,
    teamId,
    addToQueue,
    editorRef,
    chatModeRef,
    isStreamingRef,
    imagesRef,
    filesRef,
    textContextsRef,
    diffTextContextsRef,
    codeSelectionContextRef,
    activeFileRef,
    activeFileExcludedRef,
    pastedTextsRef,
    sendMessageRef,
    scrollToBottom,
    clearPendingChatRetry,
    utils.agents.getAgentChats,
    isResolvedExecutionAccountReady,
    unauthAccount,
    setPendingAccountAuth,
  ]);

  return handleSend;
}
