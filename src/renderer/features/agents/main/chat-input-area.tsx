/* eslint-disable max-lines, max-lines-per-function */

import { Button } from '@benord-labs/frink-primitives';
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { handlePasteEvent } from '@/lib/utils/paste-text';
import {
  CLAUDE_CODE_MODELS,
  CODEX_MODELS,
  claudeModelToPickerItem,
  codexModelToPickerItem,
  isClaudeModelVisible,
  isCodexModelVisible,
} from '../../../../shared/lib/models';
import type { ChatMode } from '../../../../shared/types/chat-mode';
import {
  PromptInput,
  PromptInputActions,
  PromptInputContextItems,
} from '../../../components/ui/prompt-input';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { useComposerPlaceholder } from '../../../lib/agent-chat/use-composer-placeholder';
import {
  agentsSettingsDialogActiveTabAtom,
  agentsSettingsDialogOpenAtom,
  hiddenModelsAtom,
} from '../../../lib/atoms';
import { wakeHoldAdoptedAtomFamily } from '../../../lib/stores/active-transport-registry';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { runChatShortcutAction } from '../../../lib/work-queue/chat-owns-keyboard-shortcuts';
import { lastSelectedModelIdAtomFamily, splitViewAtom } from '../atoms';
import {
  AgentsSlashCommand,
  COMMAND_PROMPTS,
  LazyCommandEditorModal,
  SLASH_COMMAND_LISTBOX_ID,
  type SlashCommandOption,
} from '../commands';
import { AttachedTask } from '../components/AttachedTask';
import { AgentSendButton } from '../components/agent-send-button';
import { ChatAutoModeToggle } from '../components/auto-mode-toggle';
import { ComposerAttachButton } from '../components/ComposerAttachButton';
import { ModeSelector } from '../components/mode-selector';
import { ModelSelector } from '../components/model-selector';
import { useCommandEditor } from '../hooks/use-command-editor';
import { CHAT_MODE_CYCLE } from '../hooks/use-effective-plan-mode-for-pane';
import { useModelNormalization } from '../hooks/use-model-normalization';
import type { PastedTextFile } from '../hooks/use-pasted-text-files';
import { useTaskAttachment } from '../hooks/use-task-attachment';
import { useComposerDraft } from '../lib/composer-draft';
import {
  type CodeSelectionContext,
  codeSelectionContextPropsEqual,
  type DiffTextContext,
} from '../lib/queue-utils';
import { AgentsFileMention, AgentsMentionsEditor, type FileMentionOption } from '../mentions';
import { AgentContextIndicator, messageTokenDataEqual } from '../ui/agent-context-indicator';
import { AgentDiffTextContextItem } from '../ui/agent-diff-text-context-item';
import { AgentFileItem } from '../ui/agent-file-item';
import { AgentImageItem } from '../ui/agent-image-item';
import { AgentPastedTextItem } from '../ui/agent-pasted-text-item';
import { AgentTextContextItem } from '../ui/agent-text-context-item';
import { useChatMode } from './active-chat/hooks';
import type { ComposerForwardedProps } from './active-chat/types';
import {
  agentsChatComposerShellClass,
  COMPOSER_ACTION_ROW_CLASS,
  HIDE_CONTEXT_RING_TIER,
} from './chat-composer-shell-classes';

/**
 * Picker rows for one provider: filter the catalog by hidden families, map to picker items,
 * resolve the selected item (stored id → first visible → first in catalog). Called once per
 * provider (Claude / Codex) so the two share one implementation. Generic over the
 * picker-item type `P` so each provider keeps its own shape (e.g. Claude's carries `version`).
 */
function useVisibleProviderModels<T extends { id: string }, P>(
  all: readonly T[],
  isVisible: (model: T, hiddenFamilyIds: string[]) => boolean,
  toPickerItem: (model: T) => P,
  hiddenFamilyIds: string[],
  selectedId: string,
): { items: P[]; selected: P } {
  const visible = useMemo(
    () => all.filter((m) => isVisible(m, hiddenFamilyIds)),
    [all, isVisible, hiddenFamilyIds],
  );
  const items = useMemo(() => visible.map(toPickerItem), [visible, toPickerItem]);
  const selected = useMemo(
    () => toPickerItem(visible.find((m) => m.id === selectedId) ?? visible[0] ?? all[0]),
    [visible, selectedId, all, toPickerItem],
  );
  return { items, selected };
}

type ChatInputAreaProps = ComposerForwardedProps & {
  // Diff text context from selected diff sidebar text
  diffTextContexts?: DiffTextContext[];
  onRemoveDiffTextContext?: (id: string) => void;
  // Code selection context from Monaco editor (auto-added when code is selected)
  codeSelectionContext?: CodeSelectionContext | null;
  onClearCodeSelection?: () => void;
  // Active file context (auto-included current file being viewed). Click to remove from context.
  activeFileName?: string | null;
  /** When true, user clicked to remove — don't show indicator or include in send */
  activeFileDismissed?: boolean;
  onDismissActiveFile?: () => void;
  // Pasted text files (large pasted text saved as files)
  pastedTexts?: PastedTextFile[];
  onAddPastedText?: (text: string) => Promise<void>;
  onRemovePastedText?: (id: string) => void;
  // Mobile
  isMobile?: boolean;
  // Queue - for sending from queue when input is empty
  queueLength?: number;
  onSendFromQueue?: (itemId: string, canSteer: boolean) => void;
  // Callback to notify parent when input has content (for custom text with questions)
  onInputContentChange?: (hasContent: boolean) => void;
};

/**
 * Custom comparison for memo to prevent re-renders from unstable array references.
 * Compares messages by length and last message id, changedFiles by length and paths.
 */
function arePropsEqual(prevProps: ChatInputAreaProps, nextProps: ChatInputAreaProps): boolean {
  // Compare primitives and stable references first (fast path)
  if (
    prevProps.isStreaming !== nextProps.isStreaming ||
    prevProps.isCompacting !== nextProps.isCompacting ||
    prevProps.isUploading !== nextProps.isUploading ||
    prevProps.subChatId !== nextProps.subChatId ||
    prevProps.parentChatId !== nextProps.parentChatId ||
    prevProps.teamId !== nextProps.teamId ||
    prevProps.repository !== nextProps.repository ||
    prevProps.sandboxId !== nextProps.sandboxId ||
    prevProps.projectPath !== nextProps.projectPath ||
    prevProps.projectId !== nextProps.projectId ||
    prevProps.isMobile !== nextProps.isMobile ||
    prevProps.queueLength !== nextProps.queueLength ||
    prevProps.firstQueueItemId !== nextProps.firstQueueItemId ||
    prevProps.activeFileDismissed !== nextProps.activeFileDismissed ||
    prevProps.activeFileName !== nextProps.activeFileName
  ) {
    return false;
  }

  // Compare refs by identity (they should be stable)
  if (
    prevProps.editorRef !== nextProps.editorRef ||
    prevProps.fileInputRef !== nextProps.fileInputRef
  ) {
    return false;
  }

  // Compare callbacks by identity (they should be memoized in parent)
  if (
    prevProps.onSend !== nextProps.onSend ||
    prevProps.onForceSend !== nextProps.onForceSend ||
    prevProps.onStop !== nextProps.onStop ||
    prevProps.onCompact !== nextProps.onCompact ||
    prevProps.onAddAttachments !== nextProps.onAddAttachments ||
    prevProps.onRemoveImage !== nextProps.onRemoveImage ||
    prevProps.onRemoveFile !== nextProps.onRemoveFile ||
    prevProps.onRemoveTextContext !== nextProps.onRemoveTextContext ||
    prevProps.onAddPastedText !== nextProps.onAddPastedText ||
    prevProps.onRemovePastedText !== nextProps.onRemovePastedText ||
    prevProps.onInputContentChange !== nextProps.onInputContentChange ||
    prevProps.onSendFromQueue !== nextProps.onSendFromQueue ||
    prevProps.onDismissActiveFile !== nextProps.onDismissActiveFile ||
    prevProps.onClearCodeSelection !== nextProps.onClearCodeSelection ||
    prevProps.onRemoveDiffTextContext !== nextProps.onRemoveDiffTextContext
  ) {
    return false;
  }

  if (
    !codeSelectionContextPropsEqual(prevProps.codeSelectionContext, nextProps.codeSelectionContext)
  ) {
    return false;
  }

  // Compare textContexts array - by length and ids
  if (!prevProps.textContexts || !nextProps.textContexts) {
    return prevProps.textContexts === nextProps.textContexts;
  }
  if (prevProps.textContexts.length !== nextProps.textContexts.length) {
    return false;
  }
  for (let i = 0; i < prevProps.textContexts.length; i++) {
    if (prevProps.textContexts[i]?.id !== nextProps.textContexts[i]?.id) {
      return false;
    }
  }

  // Compare diffTextContexts array - by length and ids
  const prevDiff = prevProps.diffTextContexts || [];
  const nextDiff = nextProps.diffTextContexts || [];
  if (prevDiff.length !== nextDiff.length) {
    return false;
  }
  for (let i = 0; i < prevDiff.length; i++) {
    if (prevDiff[i]?.id !== nextDiff[i]?.id) {
      return false;
    }
  }

  // Compare images array - by length and ids
  if (!prevProps.images || !nextProps.images) {
    return prevProps.images === nextProps.images;
  }
  if (prevProps.images.length !== nextProps.images.length) {
    return false;
  }
  for (let i = 0; i < prevProps.images.length; i++) {
    if (prevProps.images[i]?.id !== nextProps.images[i]?.id) {
      return false;
    }
  }

  // Compare files array - by length and ids
  if (!prevProps.files || !nextProps.files) {
    return prevProps.files === nextProps.files;
  }
  if (prevProps.files.length !== nextProps.files.length) {
    return false;
  }
  for (let i = 0; i < prevProps.files.length; i++) {
    if (prevProps.files[i]?.id !== nextProps.files[i]?.id) {
      return false;
    }
  }

  // Compare pastedTexts array - by length and ids
  const prevPasted = prevProps.pastedTexts || [];
  const nextPasted = nextProps.pastedTexts || [];
  if (prevPasted.length !== nextPasted.length) {
    return false;
  }
  for (let i = 0; i < prevPasted.length; i++) {
    if (prevPasted[i]?.id !== nextPasted[i]?.id) {
      return false;
    }
  }

  // Compare messageTokenData - only re-render when token counts / cost actually change
  if (!messageTokenDataEqual(prevProps.messageTokenData, nextProps.messageTokenData)) {
    return false;
  }

  // Compare changedFiles - by length and filePaths
  if (!prevProps.changedFiles || !nextProps.changedFiles) {
    return prevProps.changedFiles === nextProps.changedFiles;
  }
  if (prevProps.changedFiles.length !== nextProps.changedFiles.length) {
    return false;
  }
  for (let i = 0; i < prevProps.changedFiles.length; i++) {
    if (prevProps.changedFiles[i]?.filePath !== nextProps.changedFiles[i]?.filePath) {
      return false;
    }
  }

  return true;
}

/**
 * ChatInputArea - Isolated input component to prevent re-renders of parent
 *
 * This component manages its own state for:
 * - hasContent (whether input has text)
 * - isFocused (editor focus state)
 * - isDragOver (drag/drop state)
 * - Mention dropdown state (showMentionDropdown, mentionSearchText, etc.)
 * - Slash command dropdown state
 * - Mode dropdown state
 * - Model dropdown state
 *
 * When user types, only this component re-renders, not the entire ChatViewInner.
 */
export const ChatInputArea = memo(function ChatInputArea({
  editorRef,
  fileInputRef,
  onSend,
  onForceSend,
  onStop,
  onCompact,
  isStreaming,
  isCompacting,
  images,
  files,
  onAddAttachments,
  onRemoveImage,
  onRemoveFile,
  isUploading,
  textContexts,
  onRemoveTextContext,
  diffTextContexts,
  onRemoveDiffTextContext,
  codeSelectionContext,
  onClearCodeSelection,
  activeFileName,
  activeFileDismissed = false,
  onDismissActiveFile,
  pastedTexts = [],
  onAddPastedText,
  onRemovePastedText,
  messageTokenData,
  subChatId,
  parentChatId,
  teamId,
  repository,
  sandboxId,
  projectPath,
  projectId,
  changedFiles,
  isMobile = false,
  queueLength = 0,
  onSendFromQueue,
  firstQueueItemId,
  onInputContentChange,
}: ChatInputAreaProps) {
  // Local state - changes here don't re-render parent
  const [hasContent, setHasContent] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  // Task attachment hook
  const taskAttachment = useTaskAttachment({
    editorRef,
    onDrop: () => editorRef.current?.focus(),
  });

  // Mention dropdown state
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const [mentionSearchText, setMentionSearchText] = useState('');
  const [mentionPosition, setMentionPosition] = useState({ top: 0, left: 0 });

  // Mention dropdown subpage navigation state
  const [showingFilesList, setShowingFilesList] = useState(false);
  const [showingSkillsList, setShowingSkillsList] = useState(false);
  const [showingAgentsList, setShowingAgentsList] = useState(false);
  const [showingToolsList, setShowingToolsList] = useState(false);
  const [showingBriefingsList, setShowingBriefingsList] = useState(false);

  // Slash command dropdown state
  const [showSlashDropdown, setShowSlashDropdown] = useState(false);
  const [slashActiveDescendantId, setSlashActiveDescendantId] = useState<string | undefined>();
  const [slashSearchText, setSlashSearchText] = useState('');
  const [slashPosition, setSlashPosition] = useState({ top: 0, left: 0 });

  // Command editor modal state (shared hook)
  // onBeforeEdit closes the slash dropdown before opening the editor
  const commandEditor = useCommandEditor({
    onBeforeEdit: useCallback(() => setShowSlashDropdown(false), []),
  });

  // Mode dropdown state
  const [modeDropdownOpen, setModeDropdownOpen] = useState(false);
  const [modeTooltip, setModeTooltip] = useState<{
    visible: boolean;
    position: { top: number; left: number };
    mode: ChatMode;
  } | null>(null);
  const tooltipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasShownTooltipRef = useRef(false);

  // Model dropdown state
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const setSettingsDialogOpen = useSetAtom(agentsSettingsDialogOpenAtom);
  const setSettingsActiveTab = useSetAtom(agentsSettingsDialogActiveTabAtom);
  const openModelSettings = useCallback(() => {
    setIsModelDropdownOpen(false);
    setSettingsActiveTab('models');
    setSettingsDialogOpen(true);
  }, [setSettingsActiveTab, setSettingsDialogOpen]);
  const [lastSelectedModelId, setLastSelectedModelId] = useAtom(
    lastSelectedModelIdAtomFamily(parentChatId),
  );
  const hiddenModelFamilies = useAtomValue(hiddenModelsAtom);
  const claudeModels = useVisibleProviderModels(
    CLAUDE_CODE_MODELS,
    isClaudeModelVisible,
    claudeModelToPickerItem,
    hiddenModelFamilies,
    lastSelectedModelId,
  );
  const codexModels = useVisibleProviderModels(
    CODEX_MODELS,
    isCodexModelVisible,
    codexModelToPickerItem,
    hiddenModelFamilies,
    lastSelectedModelId,
  );

  const { data: resolvedAccount, isSuccess: accountResolved } =
    trpc.claudeCode.getResolvedAccount.useQuery(
      { chatId: parentChatId },
      { enabled: !!parentChatId, staleTime: 30000 },
    );
  const isCodexAccount = resolvedAccount?.type === 'codex';
  const composerPlaceholder = useComposerPlaceholder(parentChatId, isStreaming);
  const stopEndsBackgroundWork = useAtomValue(wakeHoldAdoptedAtomFamily(subChatId));
  const { chatMode, commitModeChange } = useChatMode(subChatId, parentChatId);

  // Refs for draft saving
  const currentSubChatIdRef = useRef<string>(subChatId);
  const currentChatIdRef = useRef<string | null>(parentChatId);
  const currentDraftTextRef = useRef<string>('');
  currentSubChatIdRef.current = subChatId;
  currentChatIdRef.current = parentChatId;

  const jotaiStore = useStore();
  const isModelDropdownOpenRef = useRef(isModelDropdownOpen);
  isModelDropdownOpenRef.current = isModelDropdownOpen;
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === '/') {
        const sv = jotaiStore.get(splitViewAtom);
        if (sv.chatIds.length >= 2 && sv.chatIds[sv.activePaneIndex] !== parentChatId) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        runChatShortcutAction(jotaiStore, true, () =>
          setIsModelDropdownOpen(!isModelDropdownOpenRef.current),
        );
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [parentChatId, jotaiStore]);

  // Normalize model selection when account type changes (Codex ↔ Claude)
  useModelNormalization(
    isCodexAccount,
    lastSelectedModelId,
    setLastSelectedModelId,
    accountResolved,
  );

  // Content change handler
  const handleContentChange = useCallback(
    (newHasContent: boolean) => {
      setHasContent(newHasContent);
      onInputContentChange?.(newHasContent);
      // Sync the draft text ref for unmount save
      const draft = editorRef.current?.getValue() || '';
      currentDraftTextRef.current = draft;
    },
    [editorRef, onInputContentChange],
  );

  // Owns the draft for this composer's whole lifetime — blur, and the unmount that fires no blur.
  const saveDraftWithAttachments = useComposerDraft({
    editorRef,
    chatIdRef: currentChatIdRef,
    subChatIdRef: currentSubChatIdRef,
    draftTextRef: currentDraftTextRef,
    images,
    files,
    textContexts,
    extraContextCount: diffTextContexts?.length ?? 0,
    onContentChange: handleContentChange,
  });

  const handleEditorBlur = useCallback(async () => {
    setIsFocused(false);
    await saveDraftWithAttachments();
  }, [saveDraftWithAttachments]);

  // Editor submit handler - handles Enter key with queue logic
  // If input is empty and queue has items, stop stream and send first from queue
  const handleEditorSubmit = useCallback(async () => {
    // Prepend attached task message if present and get task reference
    const taskToLink = taskAttachment.prependTaskMessage();

    const inputValue = editorRef.current?.getValue() || '';
    const hasText = inputValue.trim().length > 0;
    const hasAttachments =
      images.length > 0 ||
      files.length > 0 ||
      textContexts.length > 0 ||
      (diffTextContexts?.length ?? 0) > 0;

    if (!hasText && !hasAttachments && queueLength > 0 && onSendFromQueue && firstQueueItemId) {
      // Input empty, queue has items - stop stream and send from queue
      await onStop();
      onSendFromQueue(firstQueueItemId, false);
    } else {
      // getValue() automatically encodes command-highlight blocks with [/cmd:] delimiters
      onSend();

      // Link task to chat and clear
      if (taskToLink) {
        await taskAttachment.linkTaskToChat(taskToLink.id, parentChatId);
        taskAttachment.clearTask();
      }
    }
  }, [
    taskAttachment,
    parentChatId,
    editorRef,
    images,
    files,
    textContexts,
    diffTextContexts,
    queueLength,
    onSendFromQueue,
    firstQueueItemId,
    onStop,
    onSend,
  ]);

  const handlePromptInputSubmit = useCallback(() => {
    onSend();
  }, [onSend]);

  const handleMentionsEditorSubmit = useCallback(() => {
    handleEditorSubmit();
  }, [handleEditorSubmit]);

  // Mention select handler
  const handleMentionSelect = useCallback(
    (mention: FileMentionOption) => {
      // Category navigation - enter subpage instead of inserting mention
      if (mention.type === 'category') {
        setMentionSearchText('');
        if (mention.id === 'files') {
          setShowingFilesList(true);
          return;
        }
        if (mention.id === 'skills') {
          setShowingSkillsList(true);
          return;
        }
        if (mention.id === 'agents') {
          setShowingAgentsList(true);
          return;
        }
        if (mention.id === 'tools') {
          setShowingToolsList(true);
          return;
        }
        if (mention.id === 'briefings') {
          setShowingBriefingsList(true);
          return;
        }
      }

      // Otherwise: insert mention as normal
      editorRef.current?.insertMention(mention);
      setShowMentionDropdown(false);
      // Reset subpage state
      setShowingFilesList(false);
      setShowingSkillsList(false);
      setShowingAgentsList(false);
      setShowingToolsList(false);
      setShowingBriefingsList(false);
    },
    [editorRef],
  );

  // Slash command handlers
  const handleSlashTrigger = useCallback(
    ({ searchText, rect }: { searchText: string; rect: DOMRect }) => {
      setSlashSearchText(searchText);
      setSlashPosition({ top: rect.top, left: rect.left });
      setShowSlashDropdown(true);
    },
    [],
  );

  const handleCloseSlashTrigger = useCallback(() => {
    setShowSlashDropdown(false);
  }, []);

  const handleMentionTrigger = useCallback(
    ({ searchText, rect }: { searchText: string; rect: DOMRect }) => {
      if (projectPath || repository || projectId) {
        setMentionSearchText(searchText);
        setMentionPosition({ top: rect.top, left: rect.left });
        setShowMentionDropdown(true);
      }
    },
    [projectPath, repository, projectId],
  );

  const handleCloseMentionTrigger = useCallback(() => {
    setShowMentionDropdown(false);
    setShowingFilesList(false);
    setShowingSkillsList(false);
    setShowingAgentsList(false);
    setShowingToolsList(false);
    setShowingBriefingsList(false);
  }, []);

  const handleEditorShiftTab = useCallback(() => {
    const cycle = projectId ? CHAT_MODE_CYCLE : CHAT_MODE_CYCLE.filter((m) => m !== 'debug');
    const idx = cycle.indexOf(chatMode);
    commitModeChange(cycle[(idx + 1) % cycle.length]);
  }, [chatMode, commitModeChange, projectId]);

  const handleSlashSelect = useCallback(
    (command: SlashCommandOption) => {
      // Clear the slash command text from editor
      editorRef.current?.clearSlashCommand();
      setShowSlashDropdown(false);

      // Handle builtin commands
      if (command.category === 'builtin') {
        switch (command.name) {
          case 'plan':
            commitModeChange('plan');
            break;
          case 'agent':
            commitModeChange('agent');
            break;
          case 'debug':
            if (projectId) commitModeChange('debug');
            break;
          case 'compact':
            // Trigger context compaction
            onCompact();
            break;
          // Prompt-based commands - insert into editor for user to review/send
          case 'review':
          case 'pr-comments':
          case 'release-notes':
          case 'security-review':
          case 'commit': {
            const prompt = COMMAND_PROMPTS[command.name as keyof typeof COMMAND_PROMPTS];
            if (prompt) {
              editorRef.current?.setCommandValue(command.name, prompt);
            }
            break;
          }
        }
        return;
      }

      // Handle custom commands - insert as highlighted command block
      if (command.prompt) {
        editorRef.current?.setCommandValue(command.name, command.prompt);
      }
    },
    [commitModeChange, onCompact, editorRef, projectId],
  );

  // Paste handler for images, plain text, and large text (saved as files)
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => handlePasteEvent(e, onAddAttachments, onAddPastedText),
    [onAddAttachments, onAddPastedText],
  );

  // Drag/drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);

      // Check if this is a task drop - delegate to hook
      const isTaskDrop = taskAttachment.handleTaskDrop(e);
      if (isTaskDrop) return;

      // Otherwise, handle as file drop
      const droppedFiles = Array.from(e.dataTransfer.files);
      onAddAttachments(droppedFiles);
      // Focus after state update - use double rAF to wait for React render
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          editorRef.current?.focus();
        });
      });
    },
    [taskAttachment, onAddAttachments, editorRef],
  );

  return (
    <div className="relative z-10 min-w-0 px-2 pb-2" data-chat-composer-root>
      <div className="@container/composer mx-auto w-full max-w-2xl">
        <section
          className="relative w-full"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          aria-label="Drop zone for files"
        >
          <div className="relative w-full">
            <PromptInput
              className={agentsChatComposerShellClass(isDragOver, isFocused)}
              maxHeight={200}
              onSubmit={handlePromptInputSubmit}
              contextItems={
                taskAttachment.attachedTask ||
                images.length > 0 ||
                files.length > 0 ||
                textContexts.length > 0 ||
                (diffTextContexts?.length ?? 0) > 0 ||
                pastedTexts.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {taskAttachment.attachedTask && (
                      <AttachedTask
                        task={taskAttachment.attachedTask}
                        onRemove={taskAttachment.clearTask}
                      />
                    )}
                    {(images.length > 0 ||
                      files.length > 0 ||
                      textContexts.length > 0 ||
                      (diffTextContexts?.length ?? 0) > 0 ||
                      pastedTexts.length > 0) && (
                      <div className="flex flex-wrap gap-[6px]">
                        {(() => {
                          // Build allImages array for gallery navigation
                          const allImages = images
                            .filter(
                              (img): img is typeof img & { url: string } =>
                                !!img.url && !img.isLoading,
                            )
                            .map((img) => ({
                              id: img.id,
                              filename: img.filename,
                              url: img.url,
                            }));

                          return images.map((img, idx) => (
                            <AgentImageItem
                              key={img.id}
                              id={img.id}
                              filename={img.filename}
                              url={img.url || ''}
                              isLoading={img.isLoading}
                              onRemove={() => onRemoveImage(img.id)}
                              allImages={allImages}
                              imageIndex={idx}
                            />
                          ));
                        })()}
                        {files.map((f) => (
                          <AgentFileItem
                            key={f.id}
                            id={f.id}
                            filename={f.filename}
                            url={f.url || ''}
                            size={f.size}
                            isLoading={f.isLoading}
                            onRemove={() => onRemoveFile(f.id)}
                          />
                        ))}
                        {textContexts.map((tc) => (
                          <AgentTextContextItem
                            key={tc.id}
                            text={tc.text}
                            preview={tc.preview}
                            onRemove={() => onRemoveTextContext(tc.id)}
                          />
                        ))}
                        {diffTextContexts?.map((dtc) => (
                          <AgentDiffTextContextItem
                            key={dtc.id}
                            text={dtc.text}
                            preview={dtc.preview}
                            filePath={dtc.filePath}
                            lineNumber={dtc.lineNumber}
                            lineType={dtc.lineType}
                            onRemove={
                              onRemoveDiffTextContext
                                ? () => onRemoveDiffTextContext(dtc.id)
                                : undefined
                            }
                          />
                        ))}
                        {pastedTexts.map((pt) => (
                          <AgentPastedTextItem
                            key={pt.id}
                            filePath={pt.filePath}
                            filename={pt.filename}
                            size={pt.size}
                            preview={pt.preview}
                            onRemove={
                              onRemovePastedText ? () => onRemovePastedText(pt.id) : undefined
                            }
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ) : null
              }
            >
              <PromptInputContextItems />
              <AgentsMentionsEditor
                ref={editorRef}
                onTrigger={handleMentionTrigger}
                onCloseTrigger={handleCloseMentionTrigger}
                onSlashTrigger={handleSlashTrigger}
                onCloseSlashTrigger={handleCloseSlashTrigger}
                onContentChange={handleContentChange}
                onSubmit={handleMentionsEditorSubmit}
                onForceSubmit={onForceSend}
                onShiftTab={handleEditorShiftTab}
                placeholder={composerPlaceholder}
                className={cn(
                  'max-h-[200px] overflow-y-auto bg-transparent px-0.5 pb-1 pt-0.5',
                  isMobile && 'min-h-[56px]',
                )}
                onPaste={handlePaste}
                onFocus={() => setIsFocused(true)}
                onBlur={handleEditorBlur}
                slashActiveDescendantId={slashActiveDescendantId}
                slashCommandListboxId={showSlashDropdown ? SLASH_COMMAND_LISTBOX_ID : undefined}
              />
              <PromptInputActions
                className="mt-0.5 w-full gap-2 border-t border-border/35 pt-2.5"
                onClick={(e) => e.stopPropagation()}
              >
                <div className={COMPOSER_ACTION_ROW_CLASS}>
                  <ModeSelector
                    chatMode={chatMode}
                    onModeChange={commitModeChange}
                    modeDropdownOpen={modeDropdownOpen}
                    onDropdownOpenChange={setModeDropdownOpen}
                    modeTooltip={modeTooltip}
                    onTooltipChange={setModeTooltip}
                    tooltipTimeoutRef={tooltipTimeoutRef}
                    hasShownTooltipRef={hasShownTooltipRef}
                    disableDebugMode={!projectId}
                  />

                  <ChatAutoModeToggle
                    chatId={parentChatId}
                    accountResolved={accountResolved}
                    account={resolvedAccount}
                    selectedModelId={lastSelectedModelId}
                  />

                  <ModelSelector
                    selectedModel={isCodexAccount ? codexModels.selected : claudeModels.selected}
                    availableModels={isCodexAccount ? codexModels.items : claudeModels.items}
                    onModelChange={(m) => setLastSelectedModelId(m.id)}
                    modelVariant={isCodexAccount ? 'codex' : 'claude'}
                    isOpen={isModelDropdownOpen}
                    onOpenChange={setIsModelDropdownOpen}
                    onOpenModelSettings={openModelSettings}
                    chatId={parentChatId}
                  />

                  {/* Context indicator - shows code selection or active file */}
                  {codeSelectionContext ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            onClearCodeSelection?.();
                            onDismissActiveFile?.();
                          }}
                          className="flex gap-1 h-auto px-2 py-1 text-xs rounded-md font-normal @max-[34rem]/composer:sr-only"
                          aria-label={`Remove code selection and file from context: ${codeSelectionContext.fileName} lines ${codeSelectionContext.startLine}-${codeSelectionContext.endLine}`}
                        >
                          <span className="truncate max-w-[100px]">
                            {codeSelectionContext.fileName}
                          </span>
                          <span className="text-muted-foreground/60">
                            L{codeSelectionContext.startLine}-{codeSelectionContext.endLine}
                          </span>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {codeSelectionContext.fileName} (L{codeSelectionContext.startLine}-
                        {codeSelectionContext.endLine})
                        <br />
                        Click to remove selection and file from context
                      </TooltipContent>
                    </Tooltip>
                  ) : activeFileName && !activeFileDismissed ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          onClick={() => onDismissActiveFile?.()}
                          className="flex h-auto px-2 py-1 text-xs rounded-md font-normal @max-[34rem]/composer:sr-only"
                          aria-label={`Remove ${activeFileName} from context`}
                        >
                          <span className="truncate max-w-[120px]">{activeFileName}</span>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {activeFileName} — click to remove from context
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                </div>

                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                  {/* Hidden file input - accepts any files */}
                  <input
                    type="file"
                    ref={fileInputRef}
                    hidden
                    multiple
                    onChange={(e) => {
                      const inputFiles = Array.from(e.target.files || []);
                      onAddAttachments(inputFiles);
                      e.target.value = '';
                    }}
                  />

                  {/* Context window indicator - click to compact */}
                  <AgentContextIndicator
                    className={HIDE_CONTEXT_RING_TIER}
                    tokenData={messageTokenData}
                    onCompact={onCompact}
                    isCompacting={isCompacting}
                    disabled={isStreaming}
                  />

                  <ComposerAttachButton
                    label="Attach files"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={images.length >= 5 && files.length >= 10}
                  />

                  {/* Send/Stop button */}
                  <div className="ml-1">
                    <AgentSendButton
                      isStreaming={isStreaming}
                      stopEndsBackgroundWork={stopEndsBackgroundWork}
                      isSubmitting={false}
                      disabled={
                        (!hasContent &&
                          images.length === 0 &&
                          files.length === 0 &&
                          textContexts.length === 0 &&
                          (diffTextContexts?.length ?? 0) === 0 &&
                          queueLength === 0) ||
                        isUploading
                      }
                      hasContent={
                        hasContent ||
                        images.length > 0 ||
                        files.length > 0 ||
                        textContexts.length > 0 ||
                        (diffTextContexts?.length ?? 0) > 0
                      }
                      onClick={() => {
                        // If input is empty and queue has items, send first queue item
                        if (
                          !hasContent &&
                          images.length === 0 &&
                          files.length === 0 &&
                          queueLength > 0 &&
                          onSendFromQueue &&
                          firstQueueItemId
                        ) {
                          onSendFromQueue(firstQueueItemId, false);
                        } else {
                          // getValue() automatically encodes command-highlight blocks
                          onSend();
                        }
                      }}
                      onStop={onStop}
                      chatMode={chatMode}
                    />
                  </div>
                </div>
              </PromptInputActions>
            </PromptInput>
          </div>
        </section>
      </div>

      {/* File mention dropdown */}
      {/* Desktop: use projectPath for local file search */}
      <AgentsFileMention
        isOpen={
          showMentionDropdown && (!!projectPath || !!repository || !!sandboxId || !!projectId)
        }
        onClose={() => {
          setShowMentionDropdown(false);
          // Reset subpage state when closing
          setShowingFilesList(false);
          setShowingSkillsList(false);
          setShowingAgentsList(false);
          setShowingToolsList(false);
          setShowingBriefingsList(false);
        }}
        onSelect={handleMentionSelect}
        searchText={mentionSearchText}
        position={mentionPosition}
        teamId={teamId}
        repository={repository}
        sandboxId={sandboxId}
        projectPath={projectPath}
        projectId={projectId ?? undefined}
        changedFiles={changedFiles}
        // Subpage navigation state
        showingFilesList={showingFilesList}
        showingSkillsList={showingSkillsList}
        showingAgentsList={showingAgentsList}
        showingToolsList={showingToolsList}
        showingBriefingsList={showingBriefingsList}
      />

      {/* Slash command dropdown */}
      <AgentsSlashCommand
        isOpen={showSlashDropdown}
        onClose={handleCloseSlashTrigger}
        onSelect={handleSlashSelect}
        searchText={slashSearchText}
        position={slashPosition}
        projectPath={projectPath}
        hasProject={Boolean(projectId)}
        chatMode={chatMode}
        onCreateCommand={commandEditor.openCreate}
        onEditCommand={commandEditor.openEdit}
        onForkCommand={commandEditor.handleFork}
        onActiveDescendantChange={setSlashActiveDescendantId}
      />

      {/* Command editor modal (lazy-loaded) */}
      {commandEditor.commandEditorOpen && (
        <Suspense fallback={null}>
          <LazyCommandEditorModal
            open={commandEditor.commandEditorOpen}
            onOpenChange={commandEditor.setCommandEditorOpen}
            editingCommand={commandEditor.editingCommand}
            prefillName={commandEditor.prefillName}
            prefillContent={commandEditor.prefillContent}
            projectPath={projectPath}
          />
        </Suspense>
      )}
    </div>
  );
}, arePropsEqual);
