/* eslint-disable max-lines, max-lines-per-function */
// e2b API routes are used instead of useSandboxManager for agents
import { type Chat, useChat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import { atom, useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useStickToBottom } from 'use-stick-to-bottom';
import { useShallow } from 'zustand/react/shallow';
import { ChatAtmosphereSurface } from '@/components/ChatAtmosphereSurface';
import {
  chatContextFileAtomFamily,
  chatContextFileDismissedAtomFamily,
} from '@/lib/code-editor/state';
import { commandFetcher } from '@/lib/commands/command-fetcher';
import { expandSlashCommand } from '@/lib/commands/expand-slash-command';
import { buildQueuedMessageText } from '@/lib/mentions/queued-message-text';
// SplitViewContainer moved to agents-content.tsx for top-level chat splitting
import { buildAnswerMessage } from '../../../../shared/lib/agent-questions/answered-questions';
import { buildHiddenWakeMessage } from '../../../../shared/lib/message-markers/hidden-wake-marker';
import type { ChatMode } from '../../../../shared/types/chat-mode';
import { usePrefersReducedMotion } from '../../../hooks/use-prefers-reduced-motion';
import { deriveFlowChatBottomSurface } from '../../../lib/agent-chat/flow-chat-surface-state';
import { useClaudePrewarm } from '../../../lib/agent-chat/prewarm/use-claude-prewarm';
import { classifyDurableMessageRehydration } from '../../../lib/agent-chat/rehydration';
import { useSteerOrQueue } from '../../../lib/agent-chat/steer';
import { isRunBusy } from '../../../lib/agent-chat/steer/run-busy';
import { useFlowSurfaceQuery } from '../../../lib/agent-chat/use-flow-surface-query';
import { trackMessageSent } from '../../../lib/analytics';
import { isDesktopAtom, isFullscreenAtom, pendingAccountAuthAtom } from '../../../lib/atoms';
import { useFileChangeListener, useGitWatcher } from '../../../lib/hooks/use-file-change-listener';
import { appStore } from '../../../lib/jotai-store';
import { api } from '../../../lib/mock-api';
import { hasActiveTransport, runLiveAtomFamily } from '@/lib/stores/active-transport-registry';
import { askAgent, createPr, startReview } from '../../../lib/agent-chat/git-context';
import { liveGitContextIo } from '../../../lib/agent-chat/git-context/live-io';
import { useChatDiff } from '../../../lib/hooks/diff-panel/use-chat-diff';
import {
  generateCommitMessage,
  generateCommitToPrMessage,
  generateFixConflictsMessage,
  generateMergePrMessage,
} from '../../../lib/utils/pr-message';
import { type DiffHandoffs, DiffPanel } from '../../diff-panel';
import { trpc, trpcClient } from '../../../lib/trpc';
import { getDisplayFolderName } from '../../../lib/utils/path';
import { isDesktopApp } from '../../../lib/utils/platform';
import { runChatShortcutAction } from '../../../lib/work-queue/chat-owns-keyboard-shortcuts';
import {
  clearCodeSelectionContextAtomFamily,
  codeSelectionContextAtomFamily,
} from '../../code-editor';
import { notifySidebarChatActivity } from '../../sidebar/unified/sidebar-chat-activity';
import { terminalSidebarOpenAtomFamily } from '../../terminal/atoms';
import { TerminalBottomPanelGate } from '../../terminal/terminal-bottom-panel-gate';
import type { AgentUserQuestionHandle } from '../AgentUserQuestion';
import {
  agentsPreviewSidebarOpenAtom,
  agentsSubChatUnseenChangesAtom,
  agentsUnseenChangesAtom,
  chatModeAtomFamily,
  clearLoading,
  compactingForSubChatAtomFamily,
  diffSidebarOpenAtomFamily,
  expiredUserQuestionsAtom,
  filteredDiffFilesAtomFamily,
  filteredSubChatIdAtomFamily,
  isCreatingPrAtomFamily,
  loadingSubChatsAtom,
  pendingBuildPlanSubChatIdAtom,
  pendingChatRetryAtomFamily,
  pendingConflictResolutionMessageAtomFamily,
  pendingPrMessageAtomFamily,
  pendingReviewMessageAtomFamily,
  retryInFlightAtomFamily,
  selectedAgentChatIdAtom,
  setLoading,
  showNewChatFormAtom,
  splitViewAtom,
  subChatFilesAtom,
  taskExecutionErrorAtomFamily,
} from '../atoms';
import { CurrentChatWorktreeProvider } from '../context/current-chat-worktree-context';
import { TextSelectionProvider } from '../context/text-selection-context';
import { useAgentsFileUpload } from '../hooks/use-agents-file-upload';
import { useChangedFilesTracking } from '../hooks/use-changed-files-tracking';
import { useDesktopNotifications } from '../hooks/use-desktop-notifications';
import { useFocusInputOnEnter } from '../hooks/use-focus-input-on-enter';
import { useIsPaneActive } from '../hooks/use-is-pane-active';
import { usePastedTextFiles } from '../hooks/use-pasted-text-files';
import { useTextContextSelection } from '../hooks/use-text-context-selection';
import { useToggleFocusOnCmdEsc } from '../hooks/use-toggle-focus-on-cmd-esc';
import { createAgentChat } from '../lib/create-agent-chat';
import { clearSubChatDraft, getSubChatDraftFull } from '../lib/drafts';
import { createQueueItem, generateQueueId, toQueuedImage } from '../lib/queue-utils';
import { requestClaudePrewarm } from '../lib/websocket-chat-transport';
import { type AgentsMentionsEditorHandle } from '../mentions';
import { RunStatusRows } from '../RunStatusRows';
import { SearchHighlightProvider } from '../search';
import { agentChatStore } from '../stores/agent-chat-store';
import { useMessageQueueStore } from '../stores/message-queue-store';
import type { Message, MessageMetadata } from '../stores/message-store';
import { contextUsageFromMessages } from '../ui/agent-context-indicator';
import {
  chatHasGitContextAtomFamily,
  executionErrorRollbackSubChatIdAtom,
  flowRunIncompleteAtomFamily,
  isRollingBackAtom,
  rollbackHandlerAtom,
} from '../stores/message-store';
import { useStreamingStatusStore } from '../stores/streaming-status-store';
import {
  buildSubChatList,
  selectSubChatsForChat,
  type SubChatMeta,
  useAgentSubChatStore,
} from '../stores/sub-chat-store';
import { AgentToolCall } from '../ui/agent-tool-call';
import { isolatedChatToolRegistry } from '../ui/agent-tool-registry';
import { AgentUserMessageBubble } from '../ui/agent-user-message-bubble';
import { isStaleSelection } from '../ui/selection-reconcile';
import {
  ChatDock,
  ChatHeader,
  ChatHeaderSection,
  ChatInputSection,
  ChatTabsRenderer,
  FlowChatBottomSurface,
  ManagerComponentsGroup,
  MessageGroup,
  MessagesScrollContainer,
  RollbackConfirmDialog,
  SidebarsSection,
  StatusAndQueueSection,
  UserQuestionsPanel,
  usePendingQuestionsManager,
  useSearchScrollManager,
} from './active-chat/components';
import { STRINGS } from './active-chat/constants';
import {
  useCacheCleanup,
  useChatMode,
  useGitOperations,
  useMessageSend,
  usePendingMessageHandlers,
  usePlanApproval,
  useQueueEdit,
  useQuickComment,
  useRollback,
  useSingleShotPlanApproval,
  useSubChatMessages,
  useSubChatRename,
  useTaskCompletionDetection,
  useTextContextWrapper,
} from './active-chat/hooks';
import { shouldReleaseEdit } from './active-chat/hooks/use-queue-edit';
import { useRealtimeSync } from './active-chat/hooks/useRealtimeSync';
import type { ChatViewInnerProps, ChatViewProps } from './active-chat/types';
import {
  accountGateRefetchInterval,
  hasUnapprovedPlan as checkForUnapprovedPlan,
  copyMessageContent as copyMessageContentUtil,
  showAccountNotReadyToast,
} from './active-chat/utils';
import { retryChatMessage } from './active-chat/utils/chat-retry-actions';
import { pruneFailedExecutionShell } from './active-chat/utils/error-rollback';
import { getEffectiveActiveSubChatId } from './active-chat/utils/split-pane-derivations';
import { IsolatedMessagesSection } from './isolated-messages-section';

// Style constants
const MIN_WIDTH_350_STYLE = { minWidth: '350px' } as const;

/**
 * Convert UIMessage to Message type
 */
function uiMessageToMessage(uiMsg: UIMessage): Message {
  const result: Message = {
    id: uiMsg.id,
    role: uiMsg.role,
    parts: uiMsg.parts?.map((part) => ({
      type: part.type,
      text: 'text' in part ? part.text : undefined,
      toolCallId: 'toolCallId' in part ? part.toolCallId : undefined,
      state: 'state' in part ? part.state : undefined,
      input:
        'input' in part && typeof part.input === 'object'
          ? (part.input as Record<string, unknown>)
          : undefined,
      output:
        'output' in part && typeof part.output === 'object'
          ? (part.output as Record<string, unknown>)
          : undefined,
      result: 'result' in part ? part.result : undefined,
      error: 'error' in part ? part.error : undefined,
      errorText: 'errorText' in part ? part.errorText : undefined,
      toolName: 'toolName' in part ? part.toolName : undefined,
    })),
    metadata:
      uiMsg.metadata && typeof uiMsg.metadata === 'object'
        ? (uiMsg.metadata as MessageMetadata)
        : undefined,
  };
  // Only add createdAt if it exists on UIMessage (it's optional)
  if ('createdAt' in uiMsg && uiMsg.createdAt instanceof Date) {
    result.createdAt = uiMsg.createdAt;
  }
  return result;
}

/**
 * Convert Message to UIMessage type
 */
function messageToUIMessage(msg: Message): UIMessage {
  const result: UIMessage = {
    id: msg.id,
    role: msg.role,
    parts: msg.parts?.map((part) => ({
      type: part.type,
      ...(part.text !== undefined && { text: part.text }),
      ...(part.toolCallId !== undefined && { toolCallId: part.toolCallId }),
      ...(part.state !== undefined && { state: part.state }),
      ...(part.input !== undefined && { input: part.input }),
      ...(part.output !== undefined && { output: part.output }),
      ...(part.result !== undefined && { result: part.result }),
      ...(part.error !== undefined && { error: part.error }),
      ...(part.errorText !== undefined && { errorText: part.errorText }),
      ...(part.toolName !== undefined && { toolName: part.toolName }),
    })) as UIMessage['parts'],
    metadata: msg.metadata,
  };
  // Only add createdAt if it exists on Message (it's optional)
  if (msg.createdAt) {
    (result as { createdAt?: Date }).createdAt = msg.createdAt;
  }
  return result;
}

/**
 * Shared transport callbacks for execute complete/error.
 * getAgentChat invalidation is handled by QueueProcessor's global onSocketExecuteComplete
 * (QueueProcessor is mounted in agents-layout so it runs whenever the agents UI is shown).
 */
function parseSubChatMessages(raw: unknown): UIMessage[] {
  if (Array.isArray(raw)) return raw as UIMessage[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as UIMessage[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

const selectedTeamIdAtom = atom<string | null>(null);

// Inner chat component - only rendered when chat object is ready
// Memoized to prevent re-renders when parent state changes (e.g., selectedFilePath)
const ChatViewInner = memo(function ChatViewInner({
  chat,
  subChatId,
  initialSubChatName = null,
  parentChatId,
  hasExistingSession,
  refreshDiff,
  teamId,
  repository,
  streamId,
  isMobile = false,
  sandboxSetupStatus = 'ready',
  sandboxSetupError,
  onRetrySetup,
  sandboxId,
  projectPath,
  projectId,
  currentBranch,
  workspaceFolderName,
  isWorktree,
  isArchived = false,
  onRestoreWorkspace,
  isActive = true,
  taskId,
  splitPaneIndex,
  isPaneActive = true,
  loadOlderMessages,
  hasOlderMessages = false,
  isLoadingOlderMessages = false,
  loadOlderError = null,
  isResolvedExecutionAccountReady,
  isLoadingResolvedAccount = false,
  isErrorResolvedAccount = false,
  onRetryResolvedAccount,
  unauthAccount = null,
}: ChatViewInnerProps) {
  const hasTriggeredAutoGenerateRef = useRef(false);

  // Keep isActive in ref for use in callbacks (avoid stale closures)
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  const hasUnapprovedPlanRef = useRef(false); // Track unapproved plan state for scroll initialization

  const editorRef = useRef<AgentsMentionsEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const questionRef = useRef<AgentUserQuestionHandle>(null);
  const prevSubChatIdRef = useRef<string | null>(null);

  // Auto-scroll: single owner for this chat surface. Follow/release is decided from content-size
  // observation, never from scrollTop arithmetic — a layout-shift clamp is not user intent.
  // `resize`/`initial` accept only 'instant' or a spring object; bare 'smooth'/'auto' strings are
  // discarded at runtime, so pass a spring object to change the motion.
  const prefersReducedMotion = usePrefersReducedMotion();
  const stickToBottom = useStickToBottom(
    prefersReducedMotion ? { initial: 'instant', resize: 'instant' } : { initial: 'instant' },
  );
  // Depend on members, never on `stickToBottom` itself — the hook returns a fresh object each render
  // while its members are stable. The same file's decision entry covers why the read-only consumers
  // (search jump-to-match, pagination, Cmd+Down) get the plain ref below, not the hook's scrollRef:
  // docs/decisions/chat-autoscroll-single-owner.md
  const { isAtBottom, scrollToBottom: scrollViewportToBottom } = stickToBottom;
  /** The scroll viewport; MessagesScrollContainer populates this when the element attaches. */
  const chatContainerRef = useRef<HTMLElement | null>(null);
  const scrollToBottom = useCallback(() => {
    void scrollViewportToBottom(prefersReducedMotion ? { animation: 'instant' } : undefined);
  }, [scrollViewportToBottom, prefersReducedMotion]);

  // Sub-chat rename hook
  const { subChatName: storeSubChatName, handleRenameSubChat } = useSubChatRename(subChatId);
  const subChatName = storeSubChatName || initialSubChatName || '';

  // Chat mode hook (agent/plan/debug)
  const { chatMode, setChatMode } = useChatMode(subChatId, parentChatId);

  // Cache cleanup hook
  useCacheCleanup(subChatId);

  // File/image upload hook
  const {
    images,
    files,
    handleAddAttachments,
    removeImage,
    removeFile,
    clearAll,
    isUploading,
    setImagesFromDraft,
    setFilesFromDraft,
  } = useAgentsFileUpload();

  // Text context selection hook (for selecting text from assistant messages and diff)
  const {
    textContexts,
    diffTextContexts,
    addTextContext: addTextContextOriginal,
    addDiffTextContext,
    removeTextContext,
    removeDiffTextContext,
    clearTextContexts,
    clearDiffTextContexts,
    textContextsRef,
    diffTextContextsRef,
    setTextContextsFromDraft,
    setDiffTextContextsFromDraft,
  } = useTextContextSelection();

  // Code selection context from Monaco editor (per-chat, so each pane has its own)
  const codeSelectionContext = useAtomValue(codeSelectionContextAtomFamily(parentChatId));
  const clearCodeSelectionContext = useSetAtom(clearCodeSelectionContextAtomFamily(parentChatId));
  // Per-chat active file context (set when a file is opened from this chat's file tree)
  const chatContextFile = useAtomValue(chatContextFileAtomFamily(parentChatId));
  // When true, user clicked to remove active file from context (hide indicator, don't include in send)
  const activeFileDismissed = useAtomValue(chatContextFileDismissedAtomFamily(parentChatId));
  const setActiveFileDismissed = useSetAtom(chatContextFileDismissedAtomFamily(parentChatId));
  const setPendingAccountAuth = useSetAtom(pendingAccountAuthAtom);

  // Text context wrapper hook - handles different types of text selection sources
  const { addTextContext } = useTextContextWrapper({
    addTextContextOriginal,
    addDiffTextContext,
  });

  // Pasted text files (large pasted text saved as files)
  const pastedFiles = usePastedTextFiles(subChatId);
  const { pastedTexts, addPastedText, removePastedText, clearPastedTexts, pastedTextsRef } =
    pastedFiles;

  // Message queue for sending messages while streaming
  const queue = useMessageQueueStore((s) => s.getVisibleQueue(subChatId));
  const addToQueueStore = useMessageQueueStore((s) => s.addToQueue);
  const removeFromQueue = useMessageQueueStore((s) => s.removeFromQueue);
  const popItemFromQueue = useMessageQueueStore((s) => s.popItem);
  const reorderQueue = useMessageQueueStore((s) => s.reorderVisibleQueue);
  const editingItemId = useMessageQueueStore((s) => s.editingItemIds[subChatId] ?? null);
  const setEditingItemId = useMessageQueueStore((s) => s.setEditingItemId);
  const prependItem = useMessageQueueStore((s) => s.prependItem);

  // Wrapper matching useMessageSend's wide queue-item signature (fields are AgentQueueItem 1:1).
  const addToQueue = useCallback(
    (targetSubChatId: string, item: Parameters<typeof addToQueueStore>[1]) =>
      addToQueueStore(targetSubChatId, item),
    [addToQueueStore],
  ) as (subChatId: string, item: unknown) => void;

  // Track chat changes for rename trigger reset
  const chatRef = useRef<Chat<UIMessage> | null>(null);

  if (prevSubChatIdRef.current !== subChatId) {
    hasTriggeredAutoGenerateRef.current = false; // Reset auto-generate on sub-chat change
    prevSubChatIdRef.current = subChatId;
  }
  chatRef.current = chat;

  // Restore draft when subChatId changes (switching between sub-chats)
  const prevSubChatIdForDraftRef = useRef<string | null>(null);
  useEffect(() => {
    // Restore full draft (text + attachments + text contexts) for new sub-chat
    const savedDraft = parentChatId ? getSubChatDraftFull(parentChatId, subChatId) : null;

    if (savedDraft) {
      // Restore text
      if (savedDraft.text) {
        editorRef.current?.setValue(savedDraft.text);
      } else {
        editorRef.current?.clear();
      }
      // Restore images
      if (savedDraft.images.length > 0) {
        setImagesFromDraft(savedDraft.images);
      } else {
        clearAll();
      }
      // Restore files
      if (savedDraft.files.length > 0) {
        setFilesFromDraft(savedDraft.files);
      }
      // Restore text contexts
      if (savedDraft.textContexts.length > 0) {
        setTextContextsFromDraft(savedDraft.textContexts);
      } else {
        clearTextContexts();
      }
    } else if (prevSubChatIdForDraftRef.current && prevSubChatIdForDraftRef.current !== subChatId) {
      // Clear everything when switching to a sub-chat with no draft
      editorRef.current?.clear();
      clearAll();
      clearTextContexts();
    }

    // The editing flag outlives unmount and reload; the saved draft is what the edit left. An empty
    // one cannot finish it, so release the flag or it holds the queue head forever.
    if (shouldReleaseEdit(subChatId, savedDraft)) setEditingItemId(subChatId, null);

    prevSubChatIdForDraftRef.current = subChatId;
  }, [
    subChatId,
    parentChatId,
    setImagesFromDraft,
    setFilesFromDraft,
    setTextContextsFromDraft,
    clearAll,
    clearTextContexts,
    setEditingItemId,
  ]);

  // No `resume`: reconnectToStream is a stub, so resuming only flips a live run to 'ready'.
  const { messages, sendMessage, status, stop, regenerate, setMessages } = useChat({
    id: subChatId,
    chat,
    // biome-ignore lint/style/useNamingConvention: AI SDK experimental option name
    experimental_throttle: 50, // Throttle updates to reduce re-renders during streaming
  });
  // Blocks sends after unmount; set in setup too, as a hot update re-runs cleanup then setup.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Refs for useChat functions to keep callbacks stable across renders
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;
  const stopRef = useRef(stop);
  stopRef.current = stop;
  const regenerateRef = useRef(regenerate);
  regenerateRef.current = regenerate;

  // The store corrects stale streaming after unmount (e.g. Settings) but can read idle mid-turn, so
  // main's liveness counts too: every Stop and send gate here must see a turn main still runs.
  const runLive = useAtomValue(runLiveAtomFamily(subChatId), { store: appStore });
  const isStreaming = useStreamingStatusStore((s) => s.isStreaming(subChatId)) || runLive;
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;

  // Wrapper for sendMessageRef that converts Message to UIMessage format
  const sendMessageRefWrapper = useRef<(message: Message) => void>((message: Message) => {
    const uiMessage = messageToUIMessage(message);
    sendMessageRef.current(uiMessage);
  });
  sendMessageRefWrapper.current = (message: Message) => {
    const uiMessage = messageToUIMessage(message);
    sendMessageRef.current(uiMessage);
  };

  // Quick comment hook (after refs are defined)
  const {
    quickCommentState,
    handleQuickComment,
    handleQuickCommentSubmit,
    handleQuickCommentCancel,
    handleFocusInput,
  } = useQuickComment({
    editorRef,
    subChatId,
    projectPath,
    isStreamingRef,
    sendMessageRef: sendMessageRefWrapper,
    addToQueue,
    isResolvedExecutionAccountReady,
  });

  // Track compacting status from SDK (narrow subscription — only this subChatId)
  const isCompacting = useAtomValue(compactingForSubChatAtomFamily(subChatId));

  // Desktop/fullscreen state for window drag region
  const _isDesktop = useAtomValue(isDesktopAtom);

  // Handler to trigger manual context compaction
  const handleCompact = useCallback(() => {
    if (isStreamingRef.current) return; // Can't compact while streaming
    if (!isResolvedExecutionAccountReady) {
      showAccountNotReadyToast(unauthAccount, setPendingAccountAuth);
      return;
    }
    sendMessageRef.current({
      role: 'user',
      parts: [{ type: 'text', text: '/compact' }],
    });
  }, [isResolvedExecutionAccountReady, unauthAccount, setPendingAccountAuth]);

  // Handler to stop streaming - memoized to prevent ChatInputArea re-renders
  const handleStop = useCallback(async () => {
    // Mark as manually aborted to prevent completion sound
    agentChatStore.setManuallyAborted(subChatId, true);
    const transportOwned = hasActiveTransport(subChatId);
    await stopRef.current();
    // A recovered run has no useChat AbortSignal: only the observer lane asks main to stop.
    if (!transportOwned) {
      const result = await trpcClient.socket.sendStop
        .mutate({ chatId: parentChatId, subChatId })
        .catch((error: unknown) => ({
          success: false as const,
          reason: error instanceof Error ? error.message : 'Main process did not respond',
        }));
      if (!result.success) {
        toast.error('Could not stop the recovered run', { description: result.reason });
      }
    }
  }, [parentChatId, subChatId]);

  // Sync loading status to atom for UI indicators
  // When streaming starts, set loading. When it stops, clear loading.
  // Unseen changes, sound notification, and sidebar refresh are handled in onFinish callback
  const setLoadingSubChats = useSetAtom(loadingSubChatsAtom);

  // Handle all pending messages (PR, Review, Conflict, Auth)
  usePendingMessageHandlers({
    subChatId,
    parentChatId,
    isActive,
    isStreaming,
    sendMessage,
    messages,
    isResolvedExecutionAccountReady,
  });

  const [taskExecutionError, setTaskExecutionError] = useAtom(
    taskExecutionErrorAtomFamily(subChatId),
  );
  const clearTaskExecutionError = useCallback(() => {
    setTaskExecutionError(null);
  }, [setTaskExecutionError]);

  // Auto-detect task completion and mark for review
  useTaskCompletionDetection({
    taskId: taskId ?? null,
    chatId: parentChatId,
    subChatId,
    taskExecutionError,
    onTaskExecutionErrorHandled: clearTaskExecutionError,
  });

  useEffect(() => {
    const storedParentChatId = agentChatStore.getParentChatId(subChatId);
    if (!storedParentChatId) return;

    if (isStreaming) {
      setLoading(setLoadingSubChats, subChatId, storedParentChatId);
    } else {
      clearLoading(setLoadingSubChats, subChatId);
    }
  }, [isStreaming, subChatId, setLoadingSubChats]);

  // Handle pending "Build plan" from sidebar (atom - effect is defined after handleApprovePlan)
  const [pendingBuildPlanSubChatId, setPendingBuildPlanSubChatId] = useAtom(
    pendingBuildPlanSubChatIdAtom,
  );
  const [pendingChatRetry, setPendingChatRetry] = useAtom(pendingChatRetryAtomFamily(subChatId));
  const [retryInFlight, setRetryInFlight] = useAtom(retryInFlightAtomFamily(subChatId));

  // Track whether chat input has content (for custom text with questions)
  const [inputHasContent, setInputHasContent] = useState(false);

  // Memoize the last assistant message to avoid unnecessary recalculations
  const lastAssistantMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        return uiMessageToMessage(messages[i]);
      }
    }
    return null;
  }, [messages]);

  const {
    pendingQuestions,
    handleQuestionsAnswer,
    handleQuestionsSkip,
    clearPendingQuestionCallback,
  } = usePendingQuestionsManager({ subChatId, isStreaming, lastAssistantMessage });

  const [expiredQuestionsMap, setExpiredQuestionsMap] = useAtom(expiredUserQuestionsAtom);
  const expiredQuestions =
    [...expiredQuestionsMap.values()].find((question) => question.subChatId === subChatId) ?? null;
  const displayQuestions = pendingQuestions ?? expiredQuestions;
  const isQuestionExpired = !pendingQuestions && !!expiredQuestions;
  const expiredToolUseId = isQuestionExpired ? displayQuestions?.toolUseId : undefined;

  const clearDisplayQuestionsCallback = useCallback(() => {
    clearPendingQuestionCallback();
    if (!expiredToolUseId) return;
    setExpiredQuestionsMap((current) => {
      if (!current.has(expiredToolUseId)) return current;
      const newMap = new Map(current);
      newMap.delete(expiredToolUseId);
      return newMap;
    });
  }, [clearPendingQuestionCallback, expiredToolUseId, setExpiredQuestionsMap]);

  const handleDisplayQuestionsAnswer = useCallback(
    async (answers: Record<string, string>) => {
      if (!displayQuestions) return false;
      if (isQuestionExpired) {
        // Expired call → answer rides a normal message; labels ride in metadata, unseen by the model.
        // Guarded BEFORE the retire, so a refused send leaves the card — its only surface — still
        // answerable; and the retire stays synchronous, since it is not scoped to this question and
        // would otherwise wipe one raised while the send was in flight.
        const answer = buildAnswerMessage(displayQuestions.questions, answers);
        if (answer && !isResolvedExecutionAccountReady) {
          showAccountNotReadyToast(unauthAccount, setPendingAccountAuth);
          return false;
        }
        clearDisplayQuestionsCallback();
        if (answer) {
          scrollToBottom();
          const parts = [{ type: 'text' as const, text: answer.text }];
          await sendMessageRef.current({ role: 'user', parts, metadata: answer.metadata });
        }
        return true;
      }
      if (!isResolvedExecutionAccountReady) {
        showAccountNotReadyToast(unauthAccount, setPendingAccountAuth);
        return false;
      }
      return handleQuestionsAnswer(answers);
    },
    [
      displayQuestions,
      isQuestionExpired,
      clearDisplayQuestionsCallback,
      handleQuestionsAnswer,
      isResolvedExecutionAccountReady,
      unauthAccount,
      setPendingAccountAuth,
      scrollToBottom,
    ],
  );

  const handleDisplayQuestionsSkip = useCallback(async () => {
    if (!displayQuestions) return false;
    if (isQuestionExpired) {
      clearDisplayQuestionsCallback();
      return true;
    }
    const skipped = await handleQuestionsSkip();
    if (!skipped) questionRef.current?.reset(STRINGS.QUESTION_SKIP_RETRY);
    return skipped;
  }, [displayQuestions, isQuestionExpired, clearDisplayQuestionsCallback, handleQuestionsSkip]);

  // Guard every Flow-surface send with the account check and report whether it sent.
  const guardedFlowSend = useCallback(
    (text: string, metadata?: Record<string, unknown>): boolean => {
      if (!isResolvedExecutionAccountReady) {
        showAccountNotReadyToast(unauthAccount, setPendingAccountAuth);
        return false;
      }
      scrollToBottom();
      void sendMessageRef.current({ role: 'user', parts: [{ type: 'text', text }], metadata });
      return true;
    },
    [isResolvedExecutionAccountReady, unauthAccount, setPendingAccountAuth, scrollToBottom],
  );

  // Flow-chat bottom-surface state (decision flow-run-chat-surface); non-flow chats never poll.
  const drivingTaskQuery = useFlowSurfaceQuery(subChatId, taskId ?? null);
  const bottomSurface = deriveFlowChatBottomSurface(drivingTaskQuery.data);
  const flowSurfaceOwnsStop = drivingTaskQuery.isPending || bottomSurface.kind !== 'composer';

  // Context-ring data for ChatInputArea. Frozen while streaming so metadata chunks don't bust the
  // composer memo every chunk; the ring updates when the turn ends.
  const computedMessageTokenData = useMemo(() => contextUsageFromMessages(messages), [messages]);

  const messageTokenSnapshotRef = useRef(computedMessageTokenData);
  if (!isStreaming) messageTokenSnapshotRef.current = computedMessageTokenData;
  const messageTokenData = messageTokenSnapshotRef.current;

  // Carry on: resume the persisted session and continue from where the turn stopped — a hidden
  // wake message (never rendered; the executor strips the marker before the model sees it). The
  // failed partial response is KEPT (unlike Retry, which drops it and re-runs the turn). Default
  // recovery after a transient failure (usage limit reset, API error).
  const handleCarryOnChat = useCallback(() => {
    // Keep the pending-retry state recoverable: it is the ONLY affordance left on a failed turn,
    // so it must not be cleared unless the wake message actually goes out (restored if it rejects).
    if (!isResolvedExecutionAccountReady) {
      showAccountNotReadyToast(unauthAccount, setPendingAccountAuth);
      return;
    }
    if (isStreamingRef.current || retryInFlight) return;
    const previousPending = pendingChatRetry;
    const stopReason = pendingChatRetry?.errorText
      ? `Your previous attempt stopped with an error: ${pendingChatRetry.errorText.slice(0, 200)}`
      : 'Your previous attempt stopped before finishing.';
    setPendingChatRetry(null);
    Promise.resolve(
      sendMessageRef.current({
        role: 'user',
        parts: [
          {
            type: 'text',
            text: buildHiddenWakeMessage(
              `${stopReason}\n\nThe session has been resumed. Re-read the conversation and your todo state, work out what remains, and continue from there.`,
            ),
          },
        ],
      }),
    ).catch(() => setPendingChatRetry(previousPending));
  }, [
    isResolvedExecutionAccountReady,
    unauthAccount,
    setPendingAccountAuth,
    pendingChatRetry,
    retryInFlight,
    setPendingChatRetry,
  ]);

  const handleRetryChat = useCallback(async () => {
    if (!isResolvedExecutionAccountReady) {
      showAccountNotReadyToast(unauthAccount, setPendingAccountAuth);
      return;
    }
    await retryChatMessage({
      isStreaming: isStreamingRef.current,
      retryInFlight,
      pendingChatRetry,
      retryLastResponse: async () => regenerateRef.current(),
      dropTrailingAssistantMessage: () => {
        setMessages((prev) => {
          if (prev.length === 0) return prev;
          const lastMessage = prev[prev.length - 1] as UIMessage | undefined;
          if (lastMessage?.role !== 'assistant') return prev;
          return prev.slice(0, -1);
        });
      },
      setPendingChatRetry,
      setRetryInFlight,
    });
  }, [
    isResolvedExecutionAccountReady,
    unauthAccount,
    setPendingAccountAuth,
    pendingChatRetry,
    retryInFlight,
    setMessages,
    setPendingChatRetry,
    setRetryInFlight,
  ]);

  // Handle plan approval - sends "Build plan" message and switches to agent mode
  const handleApprovePlan = usePlanApproval({
    subChatId,
    messages,
    pendingBuildPlanSubChatId,
    setPendingBuildPlanSubChatId,
    setChatMode,
    scrollToBottom,
    sendMessageRef,
    isResolvedExecutionAccountReady,
  });

  // Convert messages to Message[] for hooks that expect that type
  const messagesAsMessageArray = useMemo(() => messages.map(uiMessageToMessage), [messages]);

  // Real-time sync for messages from other machines
  // Room joining happens later in this component after agentChat is loaded
  useRealtimeSync({
    subChatId,
    chatId: parentChatId,
    messages,
    setMessages,
    isActive,
  });

  // When execution fails, rollback only if the assistant message has no meaningful content.
  // If we have Task cards, tool calls, or text (e.g. subagent flow), keep the context so the user
  // sees which agents failed/succeeded—subagents may still be running.
  const setExecutionErrorRollbackSubChatId = useSetAtom(executionErrorRollbackSubChatIdAtom);
  const executionErrorRollbackSubChatId = useAtomValue(executionErrorRollbackSubChatIdAtom);
  useEffect(() => {
    if (executionErrorRollbackSubChatId !== subChatId || !subChatId) return;
    setMessages((prev) => {
      return pruneFailedExecutionShell(prev);
    });
    setExecutionErrorRollbackSubChatId(null);
  }, [executionErrorRollbackSubChatId, subChatId, setMessages, setExecutionErrorRollbackSubChatId]);

  const { changedFiles: changedFilesForSubChat, recomputeChangedFiles } = useChangedFilesTracking(
    messagesAsMessageArray,
    subChatId,
    isStreaming,
    parentChatId,
  );

  // Wrapper for setMessages that converts Message[] to UIMessage[]
  const setMessagesWrapper = useCallback(
    (newMessages: Message[]) => {
      const uiMessages = newMessages.map(messageToUIMessage);
      setMessages(uiMessages);
    },
    [setMessages],
  );

  // Rollback handler - truncates messages to the clicked user message and restores git state
  const { handleRollback, isRollingBack, rollbackConfirm, dismissRollbackConfirm } = useRollback({
    subChatId,
    isStreaming,
    setMessages: setMessagesWrapper,
    recomputeChangedFiles,
    refreshDiff,
    editorRef,
  });

  // Expose rollback handler/state via atoms for message action bar
  const setRollbackHandler = useSetAtom(rollbackHandlerAtom);
  useEffect(() => {
    setRollbackHandler(() => handleRollback);
    return () => setRollbackHandler(null);
  }, [handleRollback, setRollbackHandler]);

  const setIsRollingBackAtom = useSetAtom(isRollingBackAtom);
  useEffect(() => {
    setIsRollingBackAtom(isRollingBack);
  }, [isRollingBack, setIsRollingBackAtom]);

  // Suppress rollback chat-wide until this chat's flow run fully completes. Rolling back a mid-flow
  // OR failed/cancelled run rewinds the transcript + code but cannot rewind the flow graph
  // (node_runs stay desynced). Only a 'completed' run re-enables rollback — a failed/cancelled run
  // stays suppressed by design (recover by re-running the flow, not by rewinding this chat). Polls
  // while incomplete so the ↺ reappears once the run completes. Non-flow chats always return false.
  const flowRunIncompleteQuery = trpc.flows.hasIncompleteRunForChat.useQuery(
    { chatId: parentChatId ?? '' },
    {
      enabled: !!parentChatId,
      refetchInterval: (query) => (query.state.data === true ? 5000 : false),
    },
  );
  const setFlowRunIncomplete = useSetAtom(flowRunIncompleteAtomFamily(subChatId));
  useEffect(() => {
    setFlowRunIncomplete(flowRunIncompleteQuery.data === true);
  }, [flowRunIncompleteQuery.data, setFlowRunIncomplete]);

  // Keyboard shortcuts managed by KeyboardShortcutsManager component
  // (Escape/Ctrl+C to stop, Cmd+Enter for plan approval, Cmd+Arrow for scroll)

  // Keyboard shortcut: Enter to focus input when not already focused
  useFocusInputOnEnter(editorRef, splitPaneIndex);

  // Keyboard shortcut: Cmd+Esc to toggle focus/blur (without stopping generation)
  useToggleFocusOnCmdEsc(editorRef, splitPaneIndex);

  // Auto-trigger AI handled by AutoGenerateManager component

  // Scroll management handled by ScrollManager component
  const prewarmArmed = isActive && isPaneActive && !isStreaming && !taskId && !isArchived;
  const handlePrewarmFocus = useClaudePrewarm(prewarmArmed && isResolvedExecutionAccountReady, () =>
    requestClaudePrewarm(parentChatId, subChatId, hasUnapprovedPlanRef.current),
  );

  // Auto-focus input when switching to this chat (any sub-chat change)
  // Skip on mobile to prevent keyboard from opening automatically
  useEffect(() => {
    if (!isActive) return;
    if (isMobile) return; // Don't autofocus on mobile

    // Use requestAnimationFrame to ensure DOM is ready after render
    requestAnimationFrame(() => {
      editorRef.current?.focus();
    });
  }, [isActive, isMobile]);

  // Refs for handleSend to avoid recreating callback on every messages change
  const chatModeRef = useRef(chatMode);
  chatModeRef.current = chatMode;
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const filesRef = useRef(files);
  filesRef.current = files;
  const codeSelectionContextRef = useRef(codeSelectionContext);
  codeSelectionContextRef.current = codeSelectionContext;
  const activeFileRef = useRef(
    chatContextFile ? { name: chatContextFile.name, path: chatContextFile.path } : null,
  );
  activeFileRef.current = chatContextFile
    ? { name: chatContextFile.name, path: chatContextFile.path }
    : null;
  const activeFileExcludedRef = useRef(activeFileDismissed);
  activeFileExcludedRef.current = activeFileDismissed;

  // Reset dismissed when user switches to a different file (new file shows again)
  const prevActiveFilePathRef = useRef<string | null>(chatContextFile?.path ?? null);
  useEffect(() => {
    const currentPath = chatContextFile?.path ?? null;
    if (prevActiveFilePathRef.current !== currentPath) {
      prevActiveFilePathRef.current = currentPath;
      setActiveFileDismissed(false);
    }
  }, [chatContextFile?.path, setActiveFileDismissed]);

  // Stable handler — inlining this as `() => setActiveFileDismissed(true)` in the
  // ChatInputSection JSX busts its memo on every ChatViewInner re-render, pulling
  // the entire input subtree (editor, dropdowns, send button) into the per-chunk
  // render wave during streaming.
  const handleDismissActiveFile = useCallback(() => {
    setActiveFileDismissed(true);
  }, [setActiveFileDismissed]);

  // Message send handler extracted to hook
  const handleSend = useMessageSend({
    subChatId,
    parentChatId,
    projectPath,
    teamId,
    sandboxSetupStatus,
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
  });

  const clearExpiredQuestionsForSubChat = useCallback(() => {
    setExpiredQuestionsMap((current) => {
      if (!current.has(subChatId)) return current;
      const newMap = new Map(current);
      newMap.delete(subChatId);
      return newMap;
    });
  }, [setExpiredQuestionsMap, subChatId]);

  const handleSendWithExpiredCleanup = useCallback(async () => {
    clearExpiredQuestionsForSubChat();
    // Snapshot any "in edit" queue item BEFORE calling send. We only drop it on success.
    // If send throws, defensively re-prepend so the user doesn't lose their original.
    const editedId = useMessageQueueStore.getState().editingItemIds[subChatId] ?? null;
    const editedItem = editedId
      ? (useMessageQueueStore.getState().queues[subChatId]?.find((i) => i.id === editedId) ?? null)
      : null;
    try {
      await handleSend();
      if (editedId) {
        removeFromQueue(subChatId, editedId);
        setEditingItemId(subChatId, null);
      }
    } catch (err) {
      if (editedItem) {
        const stillThere = useMessageQueueStore
          .getState()
          .queues[subChatId]?.some((i) => i.id === editedItem.id);
        if (!stillThere) {
          prependItem(subChatId, editedItem);
        }
      }
      throw err;
    }
  }, [
    clearExpiredQuestionsForSubChat,
    handleSend,
    subChatId,
    removeFromQueue,
    setEditingItemId,
    prependItem,
  ]);

  const { handleAbandonEdit, handleEditFromQueue } = useQueueEdit({
    subChatId,
    parentChatId,
    editorRef,
    inputHasContent,
    upload: { clearAll, setImagesFromDraft, setFilesFromDraft },
    textContexts: {
      clearTextContexts,
      clearDiffTextContexts,
      setTextContextsFromDraft,
      setDiffTextContextsFromDraft,
    },
    pasted: pastedFiles,
  });

  const handleReorderQueue = useCallback(
    (fromIndex: number, toIndex: number) => {
      reorderQueue(subChatId, fromIndex, toIndex);
    },
    [reorderQueue, subChatId],
  );

  // Delivers into the RUNNING turn, else queues — never a direct send (that aborts the turn).
  const steerOrQueue = useSteerOrQueue(subChatId);

  // Queue handlers for sending queued messages
  const handleSendFromQueue = useCallback(
    async (itemId: string, canSteer: boolean) => {
      if (!isResolvedExecutionAccountReady) {
        showAccountNotReadyToast(unauthAccount, setPendingAccountAuth);
        return;
      }
      const item = popItemFromQueue(subChatId, itemId);
      if (!item) return;

      // If the popped item was the one being edited, clear the editing flag so we don't
      // leave a stale "Editing…" badge or lock another row.
      if (useMessageQueueStore.getState().editingItemIds[subChatId] === itemId) {
        handleAbandonEdit();
      }

      // Snapshot send function before async gaps to prevent stale ref reads
      const snapshotSendMessage = sendMessageRef.current;
      if (!snapshotSendMessage) return;

      try {
        // Build message parts from queued item
        const parts: Array<
          | {
              type: 'data-image';
              data: { url: string; mediaType?: string; filename?: string; base64Data?: string };
            }
          | { type: 'text'; text: string }
        > = [
          ...(item.images || [])
            .filter((img) => img.url || img.base64Data)
            .map((img) => ({
              type: 'data-image' as const,
              data: {
                url: img.url,
                mediaType: img.mediaType,
                filename: img.filename,
                base64Data: img.base64Data,
              },
            })),
        ];

        // Mention tokens for the item's attached contexts, with `/compact` left at position 0
        // (see buildQueuedMessageText).
        const queuedText = buildQueuedMessageText(item);
        if (queuedText) {
          parts.push({ type: 'text', text: queuedText });
        }

        // Track message sent
        trackMessageSent({
          workspaceId: subChatId,
          messageLength: item.message.length,
          mode: chatModeRef.current,
        });

        // Update timestamps
        useAgentSubChatStore.getState().updateSubChatTimestamp(subChatId);
        if (parentChatId) {
          notifySidebarChatActivity(parentChatId);
        }

        // After async gaps, bail out if component unmounted
        if (!isMountedRef.current) {
          // Requeue the item so it is not lost on unmount.
          useMessageQueueStore.getState().prependItem(subChatId, item);
          return;
        }

        // Re-arm stick-to-bottom and jump to the message just sent.
        scrollToBottom();

        clearExpiredQuestionsForSubChat();

        if (isRunBusy(subChatId, isStreamingRef.current)) {
          // Busy only because live runs are still hydrating: nothing to steer yet, so it waits.
          if (!isStreamingRef.current) {
            useMessageQueueStore.getState().prependItem(subChatId, item);
            return;
          }
          // Steer (or requeue) rather than abort; only a turn this view shows streaming is stopped.
          if (canSteer) {
            const text = parts.find((p) => p.type === 'text')?.text ?? '';
            await steerOrQueue(text, item.images, () =>
              useMessageQueueStore.getState().prependItem(subChatId, item),
            );
            return;
          }
          // No steer channel on this runtime, so the card shows "Send now" — honour it by
          // interrupting first. The executor's duplicate-request guard settles the overlap.
          await handleStop();
        }

        await snapshotSendMessage({ role: 'user', parts });
      } catch (_error) {
        // Requeue the item so it is not lost on send failures.
        useMessageQueueStore.getState().prependItem(subChatId, item);
      }
    },
    [
      subChatId,
      parentChatId,
      popItemFromQueue,
      steerOrQueue,
      handleStop,
      scrollToBottom, // Enable auto-scroll and immediately scroll to bottom
      clearExpiredQuestionsForSubChat,
      isResolvedExecutionAccountReady,
      unauthAccount,
      setPendingAccountAuth,
      handleAbandonEdit,
    ],
  );

  const handleRemoveFromQueue = useCallback(
    (itemId: string) => {
      // If we're removing the item that's currently in edit-mode, also reset the input so the
      // user isn't left with orphaned text/attachments referencing a queue item that no longer exists.
      if (useMessageQueueStore.getState().editingItemIds[subChatId] === itemId) {
        handleAbandonEdit();
      }
      removeFromQueue(subChatId, itemId);
    },
    [subChatId, removeFromQueue, handleAbandonEdit],
  );

  // Force send - stop stream and send immediately, bypassing queue (Opt+Enter)
  const handleForceSend = useCallback(async () => {
    // Block sending while sandbox is still being set up
    if (sandboxSetupStatus !== 'ready') {
      return;
    }
    if (!isResolvedExecutionAccountReady) {
      showAccountNotReadyToast(unauthAccount, setPendingAccountAuth);
      return;
    }

    // Get value from uncontrolled editor
    const inputValue = editorRef.current?.getValue() || '';
    const hasText = inputValue.trim().length > 0;
    const currentImages = imagesRef.current;
    const _currentFiles = filesRef.current;
    const hasImages = currentImages.filter((img) => !img.isLoading && img.url).length > 0;

    if (!hasText && !hasImages) return;

    clearExpiredQuestionsForSubChat();

    // Snapshot any "in edit" queue item BEFORE sending, so we can either drop it on success
    // or leave it in place on failure. (Same model as handleSendWithExpiredCleanup.)
    const editedId = useMessageQueueStore.getState().editingItemIds[subChatId] ?? null;
    const editedItem = editedId
      ? (useMessageQueueStore.getState().queues[subChatId]?.find((i) => i.id === editedId) ?? null)
      : null;

    // Snapshot send function before async gaps to prevent stale ref reads
    const snapshotSendMessage = sendMessageRef.current;
    if (!snapshotSendMessage) return;

    // Alt+Enter STEERS while the agent is working — it no longer aborts the turn. Whether the
    // message can actually be delivered is only known after the text is composed, so the decision
    // happens at the send seam below rather than here.
    const wasBusy = isRunBusy(subChatId, isStreamingRef.current);
    const awaitingHydration = wasBusy && !isStreamingRef.current;

    // Auto-restore archived workspace when sending a message
    if (isArchived && onRestoreWorkspace) {
      onRestoreWorkspace();
    }

    const text = inputValue.trim();
    const finalText = await expandSlashCommand(text, projectPath, commandFetcher);

    // After async gaps, bail out if component unmounted
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

    // Build message parts (only images and text, files are handled separately)
    const parts: Array<
      | {
          type: 'data-image';
          data: { url: string; mediaType?: string; filename?: string; base64Data?: string };
        }
      | { type: 'text'; text: string }
    > = [
      ...currentImages
        .filter((img): img is typeof img & { url: string } => !img.isLoading && !!img.url)
        .map((img) => ({
          type: 'data-image' as const,
          data: {
            url: img.url,
            mediaType: img.mediaType,
            filename: img.filename,
            base64Data: img.base64Data,
          },
        })),
    ];

    if (finalText) {
      parts.push({ type: 'text', text: finalText });
    }

    // Clear attachments
    clearAll();

    // Update timestamps
    useAgentSubChatStore.getState().updateSubChatTimestamp(subChatId);

    // Force scroll to bottom
    scrollToBottom();

    try {
      if (wasBusy) {
        const images = currentImages.filter((img) => !img.isLoading && img.url).map(toQueuedImage);
        const queue = () =>
          addToQueueStore(subChatId, createQueueItem(generateQueueId(), finalText, images));
        if (awaitingHydration) queue();
        else await steerOrQueue(finalText, currentImages, queue);
        if (editedId) {
          removeFromQueue(subChatId, editedId);
          setEditingItemId(subChatId, null);
        }
        return;
      }
      await snapshotSendMessage({ role: 'user', parts });
      // Success: drop the original from the queue and clear the editing flag.
      if (editedId) {
        removeFromQueue(subChatId, editedId);
        setEditingItemId(subChatId, null);
      }
    } catch (_error) {
      // Restore input so users can retry immediately.
      editorRef.current?.setValue(finalText);
      // If the original was lost from the queue mid-flight, restore it. Keep editingItemId set
      // so the badge persists and the user can retry.
      if (editedItem) {
        const stillThere = useMessageQueueStore
          .getState()
          .queues[subChatId]?.some((i) => i.id === editedItem.id);
        if (!stillThere) {
          prependItem(subChatId, editedItem);
        }
      }
    }
  }, [
    sandboxSetupStatus,
    isArchived,
    onRestoreWorkspace,
    projectPath,
    parentChatId,
    subChatId,
    steerOrQueue,
    addToQueueStore,
    clearAll,
    clearExpiredQuestionsForSubChat,
    removeFromQueue,
    setEditingItemId,
    prependItem,
    scrollToBottom, // Force scroll to bottom
    isResolvedExecutionAccountReady,
    unauthAccount,
    setPendingAccountAuth,
  ]);

  // NOTE: Auto-processing of queue is now handled globally by QueueProcessor
  // component in agents-layout.tsx. This ensures queues continue processing
  // even when user navigates to different sub-chats or workspaces.

  // Use imported utility for copying messages
  const _copyMessageContent = copyMessageContentUtil;

  // Plan approval state managed by PlanApprovalManager component
  const hasUnapprovedPlan = useMemo(
    () => checkForUnapprovedPlan(messages, chatMode === 'plan'),
    [messages, chatMode],
  );
  hasUnapprovedPlanRef.current = hasUnapprovedPlan;

  const { handleApprovePlanSingleShot } = useSingleShotPlanApproval({
    isStreaming,
    hasUnapprovedPlan,
    onApprove: handleApprovePlan,
  });

  // Message sync and search scroll managed by MessageSyncManager component
  useSearchScrollManager(chatContainerRef, splitPaneIndex);

  return (
    <>
      {/* Manager components for side effects */}
      <ManagerComponentsGroup
        isActive={isActive}
        isPaneActive={isPaneActive}
        isStreaming={isStreaming}
        subChatId={subChatId}
        parentChatId={parentChatId}
        pendingQuestions={displayQuestions}
        hasUnapprovedPlan={hasUnapprovedPlan}
        chatMode={chatMode}
        editorRef={editorRef}
        stop={stop}
        handleQuestionsSkip={handleDisplayQuestionsSkip}
        handleApprovePlan={handleApprovePlanSingleShot}
        scrollToBottom={scrollToBottom}
        status={status}
        messages={messages}
        hasUnapprovedPlanRef={hasUnapprovedPlanRef}
        hasExistingSession={hasExistingSession}
        streamId={streamId}
        hasTriggeredAutoGenerateRef={hasTriggeredAutoGenerateRef}
        regenerate={regenerate}
        editingItemId={editingItemId}
        onAbandonEdit={handleAbandonEdit}
        suppressRawStop={flowSurfaceOwnsStop}
      />

      <div className="flex flex-col flex-1 min-h-0 min-w-0 relative" onFocus={handlePrewarmFocus}>
        {/* Header section with text selection, quick comment, search, and title */}
        <ChatHeaderSection
          messages={messages}
          quickCommentState={quickCommentState}
          addTextContext={addTextContext}
          handleQuickComment={handleQuickComment}
          handleQuickCommentSubmit={handleQuickCommentSubmit}
          handleQuickCommentCancel={handleQuickCommentCancel}
          handleFocusInput={handleFocusInput}
          isMobile={isMobile}
          subChatName={subChatName}
          subChatId={subChatId}
          hasMessages={messages.length > 0}
          handleRenameSubChat={handleRenameSubChat}
          splitPaneIndex={splitPaneIndex}
          isActive={isActive}
        />

        <ChatDock
          hasLeftBottom={!isAtBottom}
          onScrollToBottom={scrollToBottom}
          worktreePath={projectPath ?? null}
          currentBranch={currentBranch}
          workspaceFolderName={workspaceFolderName}
          chatId={parentChatId}
          promptCacheExpiresAt={isStreaming ? null : messageTokenData.promptCacheExpiresAt}
          isActive={isActive}
          splitPaneIndex={splitPaneIndex}
          transcript={
            // Messages — SearchHighlightProvider scoped here so streaming chunks updating
            // chatSearchMatchesAtom (cmd+F open) can't leak re-renders into input/status/Radix menus.
            <SearchHighlightProvider splitPaneIndex={splitPaneIndex}>
              <CurrentChatWorktreeProvider
                worktreePath={isWorktree ? (projectPath ?? null) : null}
                chatId={parentChatId}
              >
                <MessagesScrollContainer
                  instance={stickToBottom}
                  isActive={isActive}
                  containerRef={chatContainerRef}
                  subChatId={subChatId}
                  pinnedTaskId={taskId ?? null}
                >
                  <IsolatedMessagesSection
                    key={subChatId}
                    subChatId={subChatId}
                    chatId={parentChatId}
                    taskId={taskId ?? null}
                    isMobile={isMobile}
                    sandboxSetupStatus={sandboxSetupStatus}
                    stickyTopClass="top-0"
                    sandboxSetupError={sandboxSetupError}
                    onRetrySetup={onRetrySetup}
                    UserBubbleComponent={AgentUserMessageBubble}
                    ToolCallComponent={AgentToolCall}
                    MessageGroupWrapper={MessageGroup}
                    toolRegistry={isolatedChatToolRegistry}
                    showChatRetryControl={!taskId && !!pendingChatRetry}
                    retryInFlight={retryInFlight}
                    onRetryChat={handleRetryChat}
                    onCarryOnChat={hasExistingSession ? handleCarryOnChat : null}
                    chatRetryTooltipText={pendingChatRetry?.errorText ?? null}
                    loadOlderMessages={loadOlderMessages}
                    hasOlderMessages={hasOlderMessages}
                    isLoadingOlderMessages={isLoadingOlderMessages}
                    loadOlderError={loadOlderError}
                    chatContainerRef={chatContainerRef}
                    status={status}
                  />
                </MessagesScrollContainer>
              </CurrentChatWorktreeProvider>
            </SearchHighlightProvider>
          }
        >
          <RunStatusRows
            subChatId={subChatId}
            pinnedTaskId={taskId ?? null}
            chatId={parentChatId ?? null}
            guardedSend={guardedFlowSend}
            isTurnActive={isStreaming}
            flowSurfaceOwnsStop={flowSurfaceOwnsStop}
          />
          {/* Stacked cards container - queue + status */}
          <StatusAndQueueSection
            queue={queue}
            changedFilesForSubChat={changedFilesForSubChat}
            parentChatId={parentChatId}
            subChatId={subChatId}
            isStreaming={isStreaming}
            isCompacting={isCompacting}
            projectPath={projectPath}
            handleRemoveFromQueue={handleRemoveFromQueue}
            handleSendFromQueue={handleSendFromQueue}
            handleEditFromQueue={handleEditFromQueue}
            handleReorderQueue={handleReorderQueue}
            editingItemId={editingItemId}
            inputHasContent={inputHasContent}
            handleStop={handleStop}
          />
          {/* Flow-run bottom surface: park answer card / running strip / paused bar replace the
              composer while a flow run drives this chat (decision flow-run-chat-surface). */}
          <FlowChatBottomSurface
            subChatId={subChatId}
            task={drivingTaskQuery.data?.task ?? null}
            parentChatId={parentChatId ?? null}
            questionCard={
              displayQuestions ? (
                // Keyed on the tool call so a second question resets the card's submitting state.
                <UserQuestionsPanel
                  key={displayQuestions.toolUseId}
                  pendingQuestions={displayQuestions}
                  questionRef={questionRef}
                  canStopTurn={isStreaming && bottomSurface.kind === 'composer'}
                  onStopTurn={handleStop}
                  handleQuestionsAnswer={handleDisplayQuestionsAnswer}
                  handleQuestionsSkip={handleDisplayQuestionsSkip}
                />
              ) : null
            }
            bottomSurface={bottomSurface}
            isTurnActive={isStreaming}
            guardedSend={guardedFlowSend}
            onStopTurn={handleStop}
          >
            <ChatInputSection
              editorRef={editorRef}
              fileInputRef={fileInputRef}
              onSend={handleSendWithExpiredCleanup}
              onForceSend={handleForceSend}
              onStop={handleStop}
              onCompact={handleCompact}
              isStreaming={isStreaming}
              isCompacting={isCompacting}
              images={images}
              files={files}
              onAddAttachments={handleAddAttachments}
              onRemoveImage={removeImage}
              onRemoveFile={removeFile}
              isUploading={isUploading}
              textContexts={textContexts}
              onRemoveTextContext={removeTextContext}
              diffTextContexts={diffTextContexts}
              onRemoveDiffTextContext={removeDiffTextContext}
              codeSelectionContext={codeSelectionContext}
              onClearCodeSelection={clearCodeSelectionContext}
              activeFileName={chatContextFile?.name ?? null}
              activeFileDismissed={activeFileDismissed}
              onDismissActiveFile={handleDismissActiveFile}
              pastedTexts={pastedTexts}
              onAddPastedText={addPastedText}
              onRemovePastedText={removePastedText}
              messageTokenData={messageTokenData}
              subChatId={subChatId}
              parentChatId={parentChatId}
              teamId={teamId}
              repository={repository}
              sandboxId={sandboxId}
              projectPath={projectPath}
              projectId={projectId}
              changedFiles={changedFilesForSubChat}
              isMobile={isMobile}
              queueLength={queue.length}
              onSendFromQueue={handleSendFromQueue}
              firstQueueItemId={queue[0]?.id}
              onInputContentChange={setInputHasContent}
              isResolvedExecutionAccountReady={isResolvedExecutionAccountReady}
              isLoadingResolvedAccount={isLoadingResolvedAccount}
              isErrorResolvedAccount={isErrorResolvedAccount}
              onRetryResolvedAccount={onRetryResolvedAccount}
              unauthAccount={unauthAccount}
            />
          </FlowChatBottomSurface>
        </ChatDock>
      </div>
      <RollbackConfirmDialog pending={rollbackConfirm} onCancel={dismissRollbackConfirm} />
    </>
  );
});

// Chat View wrapper - handles loading and creates chat object
export const ChatView = memo(function ChatView({
  chatId,
  isSidebarOpen,
  onToggleSidebar,
  selectedTeamName: _selectedTeamName,
  selectedTeamImageUrl: _selectedTeamImageUrl,
  isMobileFullscreen = false,
  onBackToChats,
  onOpenPreview,
  onOpenDiff,
  onOpenTerminal,
  splitPaneIndex,
}: ChatViewProps) {
  const [selectedTeamId] = useAtom(selectedTeamIdAtom);
  const [chatMode] = useAtom(chatModeAtomFamily(chatId));
  const isActive = useIsPaneActive(splitPaneIndex);
  const splitViewState = useAtomValue(splitViewAtom);
  const isSplitActive = splitViewState.chatIds.length > 0;
  const isDesktop = useAtomValue(isDesktopAtom);
  const isFullscreen = useAtomValue(isFullscreenAtom);
  const unseenChanges = useAtomValue(agentsUnseenChangesAtom);
  const setUnseenChanges = useSetAtom(agentsUnseenChangesAtom);
  const setSubChatUnseenChanges = useSetAtom(agentsSubChatUnseenChangesAtom);
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom);
  const setShowNewChatForm = useSetAtom(showNewChatFormAtom);
  const { notifyAgentComplete } = useDesktopNotifications();

  // Check if any chat has unseen changes
  const hasAnyUnseenChanges = unseenChanges.size > 0;
  const [isPreviewSidebarOpen, setIsPreviewSidebarOpen] = useAtom(agentsPreviewSidebarOpenAtom);
  // Per-chat diff sidebar state - each chat remembers its own open/close state
  const diffSidebarAtom = useMemo(() => diffSidebarOpenAtomFamily(chatId), [chatId]);
  const [isDiffSidebarOpen, setIsDiffSidebarOpen] = useAtom(diffSidebarAtom);
  // Single reactive subscription for the active sub-chat and plan sidebar (avoids a duplicate subscription).
  const { activeSubChatId, subChatsById } = useAgentSubChatStore(
    useShallow((state) => ({
      activeSubChatId: state.activeSubChatId,
      subChatsById: state.subChatsById,
    })),
  );

  // This chat's own rows out of the flat record; identity-stable so the memos below hold.
  const allSubChats = selectSubChatsForChat(subChatsById, chatId);

  // In split view, each pane must use its own "active" subchat (first of this chat's subchats);
  // the global store is not set per-pane so we derive pane-local effective active from tRPC data.
  const agentChatQuery = api.agents.getAgentChat.useQuery(
    { chatId },
    { enabled: !!chatId, staleTime: 10_000 },
  );
  const agentChat = agentChatQuery.data;
  const isAgentChatLoading = agentChatQuery.isLoading;
  const agentSubChats = (agentChat?.subChats ?? []) as unknown as SubChatMeta[];

  // Clear stale selection: if query finished and chat doesn't exist, redirect to new chat form.
  // Prevents infinite "Loading messages..." when localStorage holds a deleted/non-existent chat ID.
  useEffect(() => {
    if (isStaleSelection({ chatId, isLoading: isAgentChatLoading, chatExists: !!agentChat })) {
      setSelectedChatId(null);
      setShowNewChatForm(true);
    }
  }, [chatId, isAgentChatLoading, agentChat, setSelectedChatId, setShowNewChatForm]);

  const effectiveActiveSubChatId = useMemo(
    () => getEffectiveActiveSubChatId(isSplitActive, agentSubChats, activeSubChatId),
    [isSplitActive, agentSubChats, activeSubChatId],
  );

  // Paginated messages for the active sub-chat (initial page only; loadOlder used by sentinel in messages list)
  const subChatMessages = useSubChatMessages(effectiveActiveSubChatId ?? null);

  // Per-chat terminal sidebar state - each chat remembers its own open/close state
  const terminalSidebarAtom = useMemo(() => terminalSidebarOpenAtomFamily(chatId), [chatId]);
  const [isTerminalSidebarOpen, setIsTerminalSidebarOpen] = useAtom(terminalSidebarAtom);
  // Track changed files across all sub-chats for throttled diff refresh
  const subChatFiles = useAtomValue(subChatFilesAtom);

  // Clear "unseen changes" when chat is opened
  useEffect(() => {
    setUnseenChanges((prev: Set<string>) => {
      if (prev.has(chatId)) {
        const next = new Set(prev);
        next.delete(chatId);
        return next;
      }
      return prev;
    });
  }, [chatId, setUnseenChanges]);

  // Clear sub-chat "unseen changes" indicator when sub-chat becomes active (pane-local in split view)
  useEffect(() => {
    if (!effectiveActiveSubChatId) return;
    setSubChatUnseenChanges((prev: Set<string>) => {
      if (prev.has(effectiveActiveSubChatId)) {
        const next = new Set(prev);
        next.delete(effectiveActiveSubChatId);
        return next;
      }
      return prev;
    });
  }, [effectiveActiveSubChatId, setSubChatUnseenChanges]);
  // tRPC utils for optimistic cache updates
  const utils = api.useUtils();
  const trpcUtils = trpc.useUtils();

  // PR creation loading state - using atom to allow ChatViewInner to reset it
  const [isCreatingPr, setIsCreatingPr] = useAtom(isCreatingPrAtomFamily(chatId));
  // Review loading state
  const [isReviewing, setIsReviewing] = useState(false);
  // Subchat filter setter - used by handleReview to filter by active subchat
  const setFilteredSubChatId = useSetAtom(filteredSubChatIdAtomFamily(chatId));
  const setFilteredDiffFiles = useSetAtom(filteredDiffFilesAtomFamily(chatId));

  // The one sub-chat this pane mounts. The ownership check stops a sub-chat from another chat
  // rendering during a chat-switch race (the store's active id can lag the selected chat).
  const renderedSubChatId = useMemo(() => {
    if (isSplitActive) return effectiveActiveSubChatId;
    if (!activeSubChatId) return null;
    // Server rows plus store rows, so an optimistic sub-chat counts before tRPC refetches.
    const belongsToChat =
      agentSubChats.some((sc) => sc.id === activeSubChatId) ||
      allSubChats.some((sc) => sc.id === activeSubChatId);
    return belongsToChat ? activeSubChatId : null;
  }, [isSplitActive, effectiveActiveSubChatId, agentSubChats, activeSubChatId, allSubChats]);

  // Workspace restore handled by custom hook
  const worktreePath = agentChat?.worktreePath as string | null;

  const { handleRestoreWorkspace, restoreWorkspaceMutation } = useGitOperations({ chatId, utils });

  // Check if this workspace is archived
  const isArchived = !!agentChat?.archivedAt;

  // A projectId with no project yet means still loading (block execution); a general chat
  // (no projectId) runs in homePath; otherwise use the project's path.
  const hasProjectId = !!agentChat?.projectId;
  const projectResolved = !!(agentChat?.project as { id: string } | null)?.id;
  // Local equivalent project ID - when same git repo exists on current machine
  // Use this for WebSocket routing to ensure execution happens locally
  const localProjectId = (agentChat?.project as { localProjectId?: string } | null)?.localProjectId;
  const isProjectLoading = isAgentChatLoading && !!chatId;

  // Desktop: original project path for MCP config lookup
  const _originalProjectPath = (agentChat?.project?.path as string | undefined) ?? undefined;
  // Fallback for web: use sandboxId
  const sandboxId = agentChat?.sandboxId ?? null;
  const sandboxUrl = sandboxId ? `https://3003-${sandboxId}.e2b.app` : null;

  // Get home path for general chats (no project context)
  const homePath = trpc.external.getHomePath.useQuery(undefined, { staleTime: 300_000 }).data;
  // SAFETY: agentChat.project is loosely typed by tRPC; path is a string or null when present.
  const rawProjectPath = (agentChat?.project?.path as string | null) ?? null;
  // Virtual folders (virtual://) use home directory as working directory
  const isVirtualFolder = rawProjectPath?.startsWith('virtual://') ?? false;
  const projectPath = isVirtualFolder ? null : rawProjectPath;
  /** Git operations path: isolated worktree when set, else project checkout (main repo). */
  const gitContextPath = worktreePath ?? projectPath;

  // Sync git context atom for every sub-chat so rollback footer shows correctly
  // regardless of which sub-chat is currently active. Git context is chat-level,
  // not sub-chat-level, so all sub-chats share the same value.
  useEffect(() => {
    const hasGit = !!gitContextPath;
    for (const sc of agentSubChats) {
      appStore.set(chatHasGitContextAtomFamily(sc.id), hasGit);
    }
    // Fallback when sub-chats haven't loaded yet
    if (agentSubChats.length === 0) {
      appStore.set(chatHasGitContextAtomFamily(chatId), hasGit);
    }
  }, [gitContextPath, chatId, agentSubChats]);

  // Effective cwd priority:
  // - Project loading → null (wait for project resolution)
  // - Has project path → use project path (or worktree)
  // - Virtual folder, general chat, or deleted project → use homePath
  const effectiveCwd = useMemo(() => {
    if (isProjectLoading) return null; // Wait for project to load
    if (worktreePath) return worktreePath;
    if (projectPath) return projectPath;
    if ((isVirtualFolder || !hasProjectId || !projectResolved) && homePath) return homePath;
    return null;
  }, [
    isProjectLoading,
    worktreePath,
    projectPath,
    isVirtualFolder,
    hasProjectId,
    projectResolved,
    homePath,
  ]);
  // Desktop uses worktreePath, web uses sandboxUrl
  const chatWorkingDir = effectiveCwd || sandboxUrl;

  // Listen for file changes from Claude Write/Edit tools and invalidate git status
  useFileChangeListener(worktreePath);

  // Invalidate branch/status when agent execution completes (e.g. git checkout in sandbox)
  // so the bar updates even when the watcher doesn't see .git/HEAD (sandbox vs host path).
  // Two global onSocketExecuteComplete listeners exist: QueueProcessor invalidates getAgentChat
  // for every chatId; this one invalidates git branches/status only for this chat + active subChat.
  useEffect(() => {
    if (!worktreePath || !chatId) return;
    const api = window.desktopApi;
    if (!api?.onSocketExecuteComplete) return;

    const cleanup = api.onSocketExecuteComplete(
      (payload: { chatId: string; subChatId: string }) => {
        // In split view use pane-local effective active so this pane's branch/status invalidate correctly
        const activeId = isSplitActive
          ? effectiveActiveSubChatId
          : useAgentSubChatStore.getState().activeSubChatId;
        if (payload.chatId !== chatId || payload.subChatId !== activeId) return;

        void trpcUtils.changes.getBranches.invalidate({ worktreePath });
        void trpcUtils.changes.getStatus.invalidate({ worktreePath });
      },
    );

    return () => cleanup?.();
  }, [worktreePath, chatId, trpcUtils, isSplitActive, effectiveActiveSubChatId]);

  // Extract port, repository, and quick setup flag from meta
  const meta = agentChat?.meta as {
    sandboxConfig?: { port?: number };
    repository?: string;
    isQuickSetup?: boolean;
  } | null;

  // Parse repository string (e.g., "owner/repo") into object
  const repositoryString = meta?.repository;
  const repository: { owner: string; name: string } | null = repositoryString
    ? (() => {
        const parts = repositoryString.split('/');
        return parts.length === 2 ? { owner: parts[0], name: parts[1] } : null;
      })()
    : null;

  // Track if we've already triggered sandbox setup for this chat
  // Check if this is a quick setup (no preview available)
  const isQuickSetup = meta?.isQuickSetup || !meta?.sandboxConfig?.port;
  const previewPort = meta?.sandboxConfig?.port ?? 3000;

  // Check if preview can be opened (sandbox with port exists and not quick setup)
  const canOpenPreview = !!(sandboxId && !isQuickSetup && meta?.sandboxConfig?.port);

  // The diff sidebar reads the worktree; getParsedDiff has no other source.
  const canOpenDiff = !!worktreePath;

  // Close preview sidebar if preview becomes unavailable
  useEffect(() => {
    if (!canOpenPreview && isPreviewSidebarOpen) {
      setIsPreviewSidebarOpen(false);
    }
  }, [canOpenPreview, isPreviewSidebarOpen, setIsPreviewSidebarOpen]);

  // Note: We no longer forcibly close diff sidebar when canOpenDiff is false.
  // The sidebar render is guarded by canOpenDiff, so it naturally hides.
  // Per-chat state (diffSidebarOpenAtomFamily) preserves each chat's preference.

  // One cached diff per chat (useChatDiff); these triggers only mark it stale
  const { diffStats, refresh: refreshDiff } = useChatDiff(chatId, !!worktreePath);
  const refreshDiffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bursts of agent edits and stream ends collapse into one refresh
  const refreshDiffSoon = useCallback(() => {
    if (refreshDiffTimerRef.current) clearTimeout(refreshDiffTimerRef.current);
    refreshDiffTimerRef.current = setTimeout(refreshDiff, 500);
  }, [refreshDiff]);
  const refreshDiffSoonRef = useRef(refreshDiffSoon);
  useEffect(() => {
    refreshDiffSoonRef.current = refreshDiffSoon;
  }, [refreshDiffSoon]);

  // GitWatcher (@parcel/watcher on main): a commit made outside Frink also refreshes the diff
  useGitWatcher(worktreePath, refreshDiffSoon);

  useEffect(() => {
    if (isDiffSidebarOpen) refreshDiff();
  }, [isDiffSidebarOpen, refreshDiff]);

  // Agent edits and writes change the per-sub-chat file lists; refresh the diff to match
  const totalSubChatFileCount = useMemo(() => {
    let count: number = 0;
    subChatFiles.forEach((files) => {
      count += files.length;
    });
    return count;
  }, [subChatFiles]);
  useEffect(() => {
    if (totalSubChatFileCount > 0) refreshDiffSoonRef.current();
  }, [totalSubChatFileCount]);

  // Create PR, review, commit, merge and conflict fixes are chat messages to the agent
  const [pendingPrMessage, setPendingPrMessage] = useAtom(pendingPrMessageAtomFamily(chatId));
  const [pendingReviewMessage, setPendingReviewMessage] = useAtom(
    pendingReviewMessageAtomFamily(chatId),
  );
  const [pendingConflictMessage, setPendingConflictMessage] = useAtom(
    pendingConflictResolutionMessageAtomFamily(chatId),
  );
  const [isAskingAgent, setIsAskingAgent] = useState(false);
  const isHandoffBusy =
    isAskingAgent ||
    isCreatingPr ||
    isReviewing ||
    [pendingPrMessage, pendingReviewMessage, pendingConflictMessage].some(Boolean);
  // One request at a time, held until the agent has been sent it. A ref, so two clicks (or the
  // Cmd+P shortcut) landing before React re-renders cannot both start one.
  const jotaiStore = useStore();
  const handoffLockRef = useRef(false);
  const runHandoff = useCallback(
    async (start: () => Promise<void>) => {
      if (handoffLockRef.current) return;
      handoffLockRef.current = true;
      try {
        await start();
      } finally {
        const queued = [
          pendingPrMessageAtomFamily(chatId),
          pendingReviewMessageAtomFamily(chatId),
          pendingConflictResolutionMessageAtomFamily(chatId),
        ].some((pending) => jotaiStore.get(pending));
        // A queued request keeps the lock; the effect below releases it once it is sent
        if (!queued) handoffLockRef.current = false;
      }
    },
    [jotaiStore, chatId],
  );
  useEffect(() => {
    if (!isHandoffBusy) handoffLockRef.current = false;
  }, [isHandoffBusy]);

  const handleCreatePr = useCallback(
    () =>
      runHandoff(() =>
        createPr({ chatId, setPendingPrMessage, setIsCreatingPr }, liveGitContextIo),
      ),
    [runHandoff, chatId, setPendingPrMessage, setIsCreatingPr],
  );

  const askAgentTo = useCallback(
    (
      buildMessage: Parameters<typeof askAgent>[0]['buildMessage'],
      setPending = setPendingPrMessage,
    ) =>
      runHandoff(() =>
        askAgent(
          { chatId, buildMessage, setPendingMessage: setPending, setBusy: setIsAskingAgent },
          liveGitContextIo,
        ),
      ),
    [runHandoff, chatId, setPendingPrMessage],
  );

  const handleReview = useCallback(
    () =>
      runHandoff(() =>
        startReview(
          {
            chatId,
            effectiveActiveSubChatId,
            // A review scopes the panel to its sub-chat, replacing any explicit file list
            setFilteredSubChatId: (subChatId) => {
              setFilteredDiffFiles(null);
              setFilteredSubChatId(subChatId);
            },
            setPendingReviewMessage,
            setIsReviewing,
          },
          liveGitContextIo,
        ),
      ),
    [
      runHandoff,
      chatId,
      effectiveActiveSubChatId,
      setFilteredDiffFiles,
      setFilteredSubChatId,
      setPendingReviewMessage,
    ],
  );

  const diffHandoffs = useMemo<DiffHandoffs>(
    () => ({
      isBusy: isHandoffBusy,
      onCommit: () => askAgentTo(generateCommitMessage),
      onCreatePr: handleCreatePr,
      onCommitToPr: () => askAgentTo(generateCommitToPrMessage),
      onReview: handleReview,
      onFixConflicts: () => askAgentTo(generateFixConflictsMessage, setPendingConflictMessage),
      onMerge: () => askAgentTo(generateMergePrMessage),
    }),
    [isHandoffBusy, askAgentTo, handleCreatePr, handleReview, setPendingConflictMessage],
  );

  // Branch list + current branch for composer bar and diff sidebar (always when repo path exists)
  const { data: branchData, refetch: refetchBranches } = trpc.changes.getBranches.useQuery(
    { worktreePath: gitContextPath || '' },
    { enabled: !!gitContextPath, staleTime: 30_000 },
  );

  const diffPanel = useMemo(
    () =>
      worktreePath ? (
        <DiffPanel
          chatId={chatId}
          worktreePath={worktreePath}
          onClose={() => setIsDiffSidebarOpen(false)}
          handoffs={diffHandoffs}
        />
      ) : null,
    [chatId, worktreePath, setIsDiffSidebarOpen, diffHandoffs],
  );

  /** Debounce focus refetch so rapid focus events do not spam main-process git work. */
  const focusBranchRefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refetch branch/status data when window gains focus
  useEffect(() => {
    if (!gitContextPath) return;

    const handleWindowFocus = () => {
      if (focusBranchRefetchTimerRef.current !== null) {
        clearTimeout(focusBranchRefetchTimerRef.current);
      }
      focusBranchRefetchTimerRef.current = setTimeout(() => {
        focusBranchRefetchTimerRef.current = null;
        void refetchBranches();
        if (isDiffSidebarOpen) refreshDiff();
      }, 500);
    };

    window.addEventListener('focus', handleWindowFocus);
    return () => {
      window.removeEventListener('focus', handleWindowFocus);
      if (focusBranchRefetchTimerRef.current !== null) {
        clearTimeout(focusBranchRefetchTimerRef.current);
        focusBranchRefetchTimerRef.current = null;
      }
    };
  }, [gitContextPath, isDiffSidebarOpen, refetchBranches, refreshDiff]);

  // Hydrate this chat's metadata. It is keyed per chat, so every split pane can; selection is
  // still a singleton, so only single-pane mode seeds the active sub-chat.
  useEffect(() => {
    if (!agentChat) return;
    const store = useAgentSubChatStore.getState();
    if (isSplitActive) {
      store.setSubChatsForChat(chatId, buildSubChatList(agentSubChats, null, chatId));
      return;
    }
    // setChatId is a no-op for the current chat; re-read the active id it may have loaded.
    store.setChatId(chatId);
    const freshState = useAgentSubChatStore.getState();
    // The server's sub-chat wins. Until it arrives, a handed-off id (e.g. a Work Queue jump to a
    // just-created chat) stays active as a placeholder so the pane can render.
    const subChatId = agentSubChats[0]?.id ?? freshState.activeSubChatId;
    freshState.setSubChatsForChat(chatId, buildSubChatList(agentSubChats, subChatId, chatId));
    if (subChatId && subChatId !== freshState.activeSubChatId) {
      freshState.setActiveSubChat(subChatId);
    }
    // `agentChat` identity tracks the sub-chat list; `agentSubChats` is a fresh array each
    // render when subChats is nullish, so depending on it would loop.
  }, [isSplitActive, agentChat, chatId]);

  const notifyAgentCompleteForSubChatId = useCallback(
    (id: string) => {
      const storeSubChatName = useAgentSubChatStore.getState().subChatsById[id]?.name;
      const localSubChatName = agentSubChats.find((subChat) => subChat.id === id)?.name;
      notifyAgentComplete(storeSubChatName || localSubChatName || 'Agent');
    },
    [notifyAgentComplete, agentSubChats],
  );

  /** Sticky execution account for WebSocket transport — updated when `getResolvedAccount` loads or changes. */
  const {
    data: resolvedAccountForExecution,
    isSuccess: isResolvedAccountQuerySuccess,
    isLoading: isLoadingResolvedAccount,
    isError: isErrorResolvedAccount,
    refetch: refetchResolvedAccount,
  } = trpc.claudeCode.getResolvedAccount.useQuery(
    { chatId },
    { enabled: !!chatId, staleTime: 30_000, refetchInterval: accountGateRefetchInterval },
  );
  // Gate sends on the new isAuthenticated semantics:
  //   - api-key rows: oauth_token IS NOT NULL
  //   - claude-passthrough rows: needsReauthAt IS NULL (token resolves live)
  // Without this gate a credential-less user hits the executor's raw "No credentials" error.
  const isResolvedExecutionAccountReady = Boolean(
    chatId &&
    isResolvedAccountQuerySuccess &&
    (resolvedAccountForExecution === null ? false : resolvedAccountForExecution.isAuthenticated),
  );
  const executionAccountTypeRef = useRef<'claude-code' | 'codex'>('claude-code');
  useEffect(() => {
    const t = resolvedAccountForExecution?.type;
    if (t != null) {
      executionAccountTypeRef.current = t;
    }
  }, [resolvedAccountForExecution?.type]);

  // Create or get Chat instance for a sub-chat
  const getOrCreateChat = useCallback(
    (subChatId: string): Chat<UIMessage> | null => {
      // Desktop uses worktreePath, web uses sandboxUrl
      if (!agentChat) return null;
      if (!chatWorkingDir) return null;

      // Guard: prevent rendering sub-chats from a different parent chat.
      // During single-view chat transitions, the rendered sub-chat id may briefly be one
      // from the previous chat (the sub-chat store updates asynchronously via useEffect).
      // Without this guard, the previous chat's messages flash under the new chat's title.
      const knownParentChatId = agentChatStore.getParentChatId(subChatId);
      if (knownParentChatId && knownParentChatId !== chatId) {
        return null;
      }

      // Check if data is fresh (no pending move with stale projectId)
      // This prevents creating Chat with stale cwd/projectPath during async refetch
      const currentProjectId = agentChat?.projectId ?? null;
      const currentWorktreePath = (agentChat?.worktreePath as string | null | undefined) ?? null;
      const isDataFresh = agentChatStore.isDataFreshForChat(
        chatId,
        currentProjectId,
        currentWorktreePath,
      );
      if (!isDataFresh) {
        // Data is stale - don't create Chat yet, wait for refetch
        return null;
      }

      // Data is fresh - clear any pending move target
      agentChatStore.clearPendingMoveTarget(chatId);

      // projectPath: original project path for MCP config lookup (worktreePath is the cwd)
      const projectPath = (agentChat?.project?.path as string | undefined) ?? undefined;
      const isActiveSubChat = subChatId === effectiveActiveSubChatId;
      const hasUsableCurrentPageSnapshot =
        !subChatMessages.isLoading && !subChatMessages.isFetching && !subChatMessages.error;

      // Return existing chat if available, unless it was created with empty messages and we now have data (hydrate)
      const existing = agentChatStore.getIfProjectMatches(subChatId, projectPath);
      if (existing) {
        // Ask the transport too: the status store is never written for a turn this window owns.
        const isExistingChatStreaming =
          hasActiveTransport(subChatId) ||
          useStreamingStatusStore.getState().isStreaming(subChatId);
        const rehydrationDecision =
          isActiveSubChat && hasUsableCurrentPageSnapshot
            ? classifyDurableMessageRehydration({
                isActiveSubChat,
                isExistingChatStreaming,
                existingMessages: existing.messages,
                fetchedMessages: subChatMessages.messages,
              })
            : 'preserve';
        if (rehydrationDecision !== 'replace') return existing;
        agentChatStore.delete(subChatId); // fall through: recreate the Chat from fetched messages
      }

      // For active sub-chat, wait for messages load. Also wait during refetch (e.g. after a move)
      // to avoid creating a Chat with stale message data.
      if (isActiveSubChat && !hasUsableCurrentPageSnapshot) {
        return null;
      }

      // Find sub-chat data; use paginated messages for active tab, else parse subChat.messages (legacy/empty)
      const subChat = agentSubChats.find((sc) => sc.id === subChatId);
      const rawMessages = subChat?.messages;
      const parsedInactive = parseSubChatMessages(rawMessages);
      // Don't create Chat for inactive tabs when we only have placeholder/empty data (avoids caching empty history).
      // Exception: if this sub-chat is currently streaming, always create the Chat so the in-flight
      // response reaches its spawn point even after the user navigates away.
      const isInFlightStream = useStreamingStatusStore.getState().isStreaming(subChatId);
      if (
        subChatId !== effectiveActiveSubChatId &&
        parsedInactive.length === 0 &&
        !isInFlightStream
      ) {
        return null;
      }
      const messages =
        subChatId === effectiveActiveSubChatId ? subChatMessages.messages : parsedInactive;

      // In split view use pane-local subchat mode (tRPC data); otherwise use store metadata
      const subChatMode =
        isSplitActive && subChat?.mode
          ? (subChat.mode as ChatMode)
          : useAgentSubChatStore.getState().subChatsById[subChatId]?.mode || chatMode;
      // WebSocket-first architecture: All execution flows through WebSocket
      // Server handles persistence and routes to the correct executing machine
      // Use localProjectId if available (same repo exists on current machine)
      // This ensures execution routes to current machine, preventing cross-machine routing issues
      // For general chats (no project), effectiveProjectId is empty - server executes locally
      const effectiveProjectId = localProjectId || agentChat?.projectId;

      // Build the Chat + WebSocket transport via the shared factory (also used by the
      // headless task path in use-task-ipc-handler). effectiveProjectId routes to the
      // current machine when the same repo exists locally; empty string => server
      // executes locally (general chats). onFinish lives in the factory and runs off
      // store/atom state, so it behaves the same whether or not this view is mounted.
      const newChat = createAgentChat({
        chatId,
        subChatId,
        projectId: effectiveProjectId || '',
        mode: subChatMode,
        initialMessages: messages,
        projectPath,
        streamId: subChat?.streamId || null,
        expectedFlowTaskId: agentChat?.taskId ?? null,
        getExecutionAccountType: () => executionAccountTypeRef.current,
        notifyComplete: notifyAgentCompleteForSubChatId,
        onFinishExtra: () => {
          // Refresh diff stats after agent finishes making changes.
          refreshDiffSoonRef.current();
        },
      });
      // No forceUpdate needed — the new Chat is returned directly to ChatTabsRenderer
      // which passes it as a prop to ChatViewInnerComponent in the same render.
      return newChat;
    },
    [
      effectiveActiveSubChatId,
      agentChat,
      chatWorkingDir,
      chatId,
      chatMode,
      isSplitActive,
      localProjectId,
      notifyAgentCompleteForSubChatId,
      agentSubChats,
      subChatMessages.messages,
      subChatMessages.isLoading,
      subChatMessages.isFetching,
      subChatMessages.error,
      agentChat?.taskId,
    ],
  );

  // NOTE: Desktop notifications for pending questions are now triggered directly
  // in websocket-chat-transport.ts when the ask-user-question chunk arrives.
  // This prevents duplicate notifications from multiple ChatView instances.

  // Keyboard shortcut: Cmd + D to toggle diff sidebar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check for Cmd (Meta) + D (without Alt/Shift)
      if (e.metaKey && !e.altKey && !e.shiftKey && !e.ctrlKey && e.code === 'KeyD') {
        e.preventDefault();
        e.stopPropagation();

        runChatShortcutAction(appStore, true, () => {
          setIsDiffSidebarOpen(!isDiffSidebarOpen);
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [
    isDiffSidebarOpen, // Toggle diff sidebar
    setIsDiffSidebarOpen,
  ]);

  // Keyboard shortcut: Create PR (preview)
  // Web: Opt+Cmd+P (browser uses Cmd+P for print)
  // Desktop: Cmd+P
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isDesktop = isDesktopApp();

      // Desktop: Cmd+P (without Alt)
      const isDesktopShortcut =
        isDesktop && e.metaKey && e.code === 'KeyP' && !e.altKey && !e.shiftKey && !e.ctrlKey;
      // Web: Opt+Cmd+P (with Alt)
      const isWebShortcut = e.altKey && e.metaKey && e.code === 'KeyP';

      if (isDesktopShortcut || isWebShortcut) {
        e.preventDefault();
        e.stopPropagation();

        runChatShortcutAction(appStore, diffStats.hasChanges && !isCreatingPr, () => {
          handleCreatePr();
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [diffStats.hasChanges, isCreatingPr, handleCreatePr]);

  const projectContextLabel =
    getDisplayFolderName(projectPath || worktreePath) ||
    ((agentChat?.project as { name?: string } | null)?.name ?? null) ||
    'General chat';

  // No early return - let the UI render with loading state handled by activeChat check below

  return (
    <TextSelectionProvider>
      <div className="flex h-full flex-col min-h-0 min-w-0">
        {/* Main content */}
        <div className="flex-1 min-h-0 min-w-0 overflow-hidden flex">
          {/* Chat Panel */}
          <ChatAtmosphereSurface style={isSplitActive ? undefined : MIN_WIDTH_350_STYLE}>
            <div className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col">
              {/* SubChatSelector header - absolute when sidebar open (desktop only), regular div otherwise */}
              <ChatHeader
                isMobileFullscreen={isMobileFullscreen}
                isSidebarOpen={isSidebarOpen}
                onToggleSidebar={onToggleSidebar}
                splitPaneIndex={splitPaneIndex}
                hasAnyUnseenChanges={hasAnyUnseenChanges}
                isPreviewSidebarOpen={isPreviewSidebarOpen}
                setIsPreviewSidebarOpen={setIsPreviewSidebarOpen}
                isTerminalSidebarOpen={isTerminalSidebarOpen}
                setIsTerminalSidebarOpen={setIsTerminalSidebarOpen}
                setIsDiffSidebarOpen={setIsDiffSidebarOpen}
                chatId={chatId}
                gitContextPath={gitContextPath}
                sandboxId={sandboxId ?? null}
                canOpenPreview={canOpenPreview}
                canOpenDiff={canOpenDiff}
                diffStats={diffStats}
                isArchived={isArchived}
                taskId={agentChat?.taskId ?? null}
                onBackToChats={onBackToChats ?? (() => {})}
                onOpenPreview={onOpenPreview ?? (() => {})}
                onOpenDiff={onOpenDiff ?? (() => {})}
                onOpenTerminal={onOpenTerminal ?? (() => {})}
                handleRestoreWorkspace={handleRestoreWorkspace}
                restoreWorkspaceMutationIsPending={restoreWorkspaceMutation.isPending}
              />

              {renderedSubChatId && agentChat ? (
                <ChatTabsRenderer
                  subChatId={renderedSubChatId}
                  agentSubChats={agentSubChats}
                  allSubChats={isSplitActive ? agentSubChats : allSubChats}
                  getOrCreateChat={getOrCreateChat}
                  subChatMessages={subChatMessages}
                  chatId={chatId}
                  selectedTeamId={selectedTeamId}
                  repository={repository ? `${repository.owner}/${repository.name}` : undefined}
                  isMobileFullscreen={isMobileFullscreen}
                  sandboxId={sandboxId ?? undefined}
                  projectPath={gitContextPath ?? undefined}
                  projectId={localProjectId ?? agentChat?.projectId ?? null}
                  currentBranch={
                    branchData?.current ??
                    (agentChat as { branch?: string | null } | null)?.branch ??
                    null
                  }
                  workspaceFolderName={projectContextLabel}
                  isWorktree={!!worktreePath && worktreePath !== projectPath}
                  isArchived={isArchived}
                  taskId={agentChat?.taskId ?? null}
                  splitPaneIndex={splitPaneIndex}
                  isPaneActive={isActive}
                  isResolvedExecutionAccountReady={isResolvedExecutionAccountReady}
                  isLoadingResolvedAccount={isLoadingResolvedAccount}
                  isErrorResolvedAccount={isErrorResolvedAccount}
                  onRetryResolvedAccount={() => void refetchResolvedAccount()}
                  unauthAccount={
                    resolvedAccountForExecution && !resolvedAccountForExecution.isAuthenticated
                      ? {
                          label: resolvedAccountForExecution.label,
                          type: resolvedAccountForExecution.type,
                        }
                      : null
                  }
                  handleRestoreWorkspace={handleRestoreWorkspace}
                  ChatViewInnerComponent={ChatViewInner}
                />
              ) : (
                <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
                  Loading messages...
                </div>
              )}
            </div>
          </ChatAtmosphereSurface>

          {/* All sidebars (Plan, Diff, Preview, Terminal, Details) */}
          <SidebarsSection
            isActive={isActive}
            isMobileFullscreen={isMobileFullscreen}
            canOpenDiff={canOpenDiff}
            isDiffSidebarOpen={isDiffSidebarOpen}
            setIsDiffSidebarOpen={setIsDiffSidebarOpen}
            diffPanel={diffPanel}
            gitContextPath={gitContextPath}
            chatId={chatId}
            sandboxId={sandboxId}
            repository={repository}
            canOpenPreview={canOpenPreview}
            isPreviewSidebarOpen={isPreviewSidebarOpen}
            setIsPreviewSidebarOpen={setIsPreviewSidebarOpen}
            isQuickSetup={isQuickSetup}
            previewPort={previewPort}
          />
        </div>

        {/* Terminal Bottom Panel — gate reads displayModeAtom internally to isolate re-renders */}
        {gitContextPath && (
          <TerminalBottomPanelGate
            chatId={chatId}
            cwd={gitContextPath}
            workspaceId={chatId}
            isPaneActive={isActive}
          />
        )}
      </div>
    </TextSelectionProvider>
  );
});
