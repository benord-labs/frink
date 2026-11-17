/* eslint-disable max-lines, max-lines-per-function */

import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { memo, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { attachedContextFile } from '@/lib/mentions/queued-message-text';
import { handlePasteEvent } from '@/lib/utils/paste-text';
import type { ChatMode } from '../../../../shared/types/chat-mode';
import {
  PromptInput,
  PromptInputActions,
  PromptInputContextItems,
} from '../../../components/ui/prompt-input';
import { useComposerPlaceholder } from '../../../lib/agent-chat/use-composer-placeholder';
import { unsupportedChatControls } from '../../../lib/ai-providers/chat-options';
import { useProviderModels } from '../../../lib/ai-providers/use-provider-models';
import {
  agentsSettingsDialogActiveTabAtom,
  agentsSettingsDialogOpenAtom,
} from '../../../lib/atoms';
import { wakeHoldAdoptedAtomFamily } from '../../../lib/stores/active-transport-registry';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { runChatShortcutAction } from '../../../lib/work-queue/chat-owns-keyboard-shortcuts';
import { lastSelectedModelIdAtomFamily, splitViewAtom } from '../atoms';
import {
  AgentsSlashCommand,
  insertPickedCommand,
  LazyCommandEditorModal,
  SLASH_COMMAND_LISTBOX_ID,
  type SlashCommandOption,
} from '../commands';
import { AttachedTask } from '../components/AttachedTask';
import { AgentSendButton } from '../components/agent-send-button';
import { ChatAutoModeToggle } from '../components/auto-mode-toggle';
import { ComposerAttachButton } from '../components/ComposerAttachButton';
import { EditorContextChip } from '../components/EditorContextChip';
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

type ChatInputAreaProps = ComposerForwardedProps & {
  // Diff text context from selected diff sidebar text
  diffTextContexts?: DiffTextContext[];
  onRemoveDiffTextContext?: (id: string) => void;
  // Code selection context from Monaco editor (auto-added when code is selected)
  codeSelectionContext?: CodeSelectionContext | null;
  onClearCodeSelection?: () => void;
  // Active file context (auto-included current file being viewed). Click to remove from context.
  activeFileName?: string | null;
  activeFilePath?: string | null;
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
/** Props compared by identity: primitives, refs (stable) and callbacks (memoized in the parent). */
const IDENTITY_COMPARED_PROPS = [
  'isStreaming',
  'isCompacting',
  'isUploading',
  'subChatId',
  'parentChatId',
  'teamId',
  'repository',
  'projectPath',
  'projectId',
  'isMobile',
  'queueLength',
  'firstQueueItemId',
  'activeFileDismissed',
  'activeFileName',
  'activeFilePath',
  'editorRef',
  'fileInputRef',
  'onSend',
  'onForceSend',
  'onStop',
  'onCompact',
  'onAddAttachments',
  'onRemoveImage',
  'onRemoveTextContext',
  'onAddPastedText',
  'onRemovePastedText',
  'onInputContentChange',
  'onSendFromQueue',
  'onDismissActiveFile',
  'onClearCodeSelection',
  'onRemoveDiffTextContext',
] as const satisfies readonly (keyof ChatInputAreaProps)[];

function arePropsEqual(prevProps: ChatInputAreaProps, nextProps: ChatInputAreaProps): boolean {
  if (IDENTITY_COMPARED_PROPS.some((key) => prevProps[key] !== nextProps[key])) {
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
  onAddAttachments,
  onRemoveImage,
  isUploading,
  textContexts,
  onRemoveTextContext,
  diffTextContexts,
  onRemoveDiffTextContext,
  codeSelectionContext,
  onClearCodeSelection,
  activeFileName,
  activeFilePath,
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
  const { data: resolvedAccount, isSuccess: accountResolved } =
    trpc.claudeCode.getResolvedAccount.useQuery(
      { chatId: parentChatId },
      { enabled: !!parentChatId, staleTime: 30000 },
    );
  // A saved model the account can't use stays selected and named, so the trigger shows what a send
  // would carry; the send itself is refused with a plain message.
  const models = useProviderModels(resolvedAccount?.type, lastSelectedModelId, {
    keepUnavailable: true,
  });
  const controls = unsupportedChatControls(resolvedAccount?.type);
  const hiddenModes: ChatMode[] = projectId ? controls.modes : [...controls.modes, 'debug'];
  const composerPlaceholder = useComposerPlaceholder(parentChatId, isStreaming);
  const stopEndsBackgroundWork = useAtomValue(wakeHoldAdoptedAtomFamily(subChatId));
  const { chatMode, commitModeChange } = useChatMode(subChatId, parentChatId);
  // A saved mode this agent has no equivalent for becomes Agent, once per chat: a failed save
  // leaves the send refused in plain words rather than retrying.
  const agentHidesMode = controls.modes.includes(chatMode);
  const modeCorrectedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!agentHidesMode || modeCorrectedForRef.current === subChatId) return;
    modeCorrectedForRef.current = subChatId;
    commitModeChange('agent');
  }, [agentHidesMode, commitModeChange, subChatId]);

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
    resolvedAccount?.type,
    lastSelectedModelId,
    setLastSelectedModelId,
    accountResolved,
    models.codexCatalog,
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
    pastedTexts,
    textContexts,
    extraContextCount: diffTextContexts?.length ?? 0,
    onContentChange: handleContentChange,
  });

  const handleEditorBlur = useCallback(() => {
    setIsFocused(false);
    saveDraftWithAttachments();
  }, [saveDraftWithAttachments]);

  // Editor submit handler - handles Enter key with queue logic
  // If input is empty and queue has items, stop stream and send first from queue
  const handleEditorSubmit = useCallback(async () => {
    // Enter must wait like the send button does, or a file still copying misses the message.
    if (isUploading) return;
    // Prepend attached task message if present and get task reference
    const taskToLink = taskAttachment.prependTaskMessage();

    const inputValue = editorRef.current?.getValue() || '';
    const hasText = inputValue.trim().length > 0;
    const hasAttachments =
      images.length > 0 ||
      pastedTexts.length > 0 ||
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
    isUploading,
    taskAttachment,
    parentChatId,
    editorRef,
    images,
    pastedTexts,
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
      }

      // Otherwise: insert mention as normal
      editorRef.current?.insertMention(mention);
      setShowMentionDropdown(false);
      // Reset subpage state
      setShowingFilesList(false);
      setShowingSkillsList(false);
      setShowingAgentsList(false);
      setShowingToolsList(false);
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
  }, []);

  const handleEditorShiftTab = useCallback(() => {
    const cycle = CHAT_MODE_CYCLE.filter((m) => !hiddenModes.includes(m));
    const idx = cycle.indexOf(chatMode);
    commitModeChange(cycle[(idx + 1) % cycle.length]);
  }, [chatMode, commitModeChange, hiddenModes]);

  const handleSlashSelect = useCallback(
    (command: SlashCommandOption) => {
      // Clear the slash command text from editor
      editorRef.current?.clearSlashCommand();
      setShowSlashDropdown(false);

      // Mode switches and compaction act here; every other pick is written into the composer
      if (command.category === 'builtin') {
        switch (command.name) {
          case 'plan':
            commitModeChange('plan');
            return;
          case 'agent':
            commitModeChange('agent');
            return;
          case 'debug':
            if (projectId) commitModeChange('debug');
            return;
          case 'compact':
            onCompact();
            return;
        }
      }
      insertPickedCommand(editorRef.current, command);
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

  // The rule the send path reads too, so the chip shows exactly what the next message carries.
  const attachedFileName = attachedContextFile(
    activeFileName,
    activeFileDismissed,
    codeSelectionContext,
  );
  const hasEditorContext = Boolean(codeSelectionContext || attachedFileName);

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
                hasEditorContext ||
                images.length > 0 ||
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
                    {(hasEditorContext ||
                      images.length > 0 ||
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
                        <EditorContextChip
                          selection={codeSelectionContext}
                          fileName={attachedFileName}
                          filePath={attachedFileName ? activeFilePath : null}
                          onRemoveSelection={() => onClearCodeSelection?.()}
                          onRemoveFile={() => onDismissActiveFile?.()}
                        />
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
                    hiddenModes={hiddenModes}
                  />

                  <ChatAutoModeToggle
                    chatId={parentChatId}
                    accountResolved={accountResolved}
                    account={resolvedAccount}
                    selectedModelId={lastSelectedModelId}
                  />

                  <ModelSelector
                    selectedModel={models.selected}
                    availableModels={models.items}
                    onModelChange={(m) => setLastSelectedModelId(m.id)}
                    modelVariant={models.variant}
                    isOpen={isModelDropdownOpen}
                    onOpenChange={setIsModelDropdownOpen}
                    onOpenModelSettings={openModelSettings}
                    chatId={parentChatId}
                    unavailable={models.unavailable}
                    hint={models.hint}
                  />
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
                  {controls.commands.includes('compact') ? null : (
                    <AgentContextIndicator
                      className={HIDE_CONTEXT_RING_TIER}
                      tokenData={messageTokenData}
                      onCompact={onCompact}
                      isCompacting={isCompacting}
                      disabled={isStreaming}
                    />
                  )}

                  <ComposerAttachButton
                    label="Attach files"
                    onClick={() => fileInputRef.current?.click()}
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
                          pastedTexts.length === 0 &&
                          textContexts.length === 0 &&
                          (diffTextContexts?.length ?? 0) === 0 &&
                          queueLength === 0) ||
                        isUploading
                      }
                      hasContent={
                        hasContent ||
                        images.length > 0 ||
                        pastedTexts.length > 0 ||
                        textContexts.length > 0 ||
                        (diffTextContexts?.length ?? 0) > 0
                      }
                      onClick={() => {
                        // If input is empty and queue has items, send first queue item
                        if (
                          !hasContent &&
                          images.length === 0 &&
                          pastedTexts.length === 0 &&
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
        isOpen={showMentionDropdown && (!!projectPath || !!repository || !!projectId)}
        onClose={() => {
          setShowMentionDropdown(false);
          // Reset subpage state when closing
          setShowingFilesList(false);
          setShowingSkillsList(false);
          setShowingAgentsList(false);
          setShowingToolsList(false);
        }}
        onSelect={handleMentionSelect}
        searchText={mentionSearchText}
        position={mentionPosition}
        teamId={teamId}
        repository={repository}
        projectPath={projectPath}
        changedFiles={changedFiles}
        // Subpage navigation state
        showingFilesList={showingFilesList}
        showingSkillsList={showingSkillsList}
        showingAgentsList={showingAgentsList}
        showingToolsList={showingToolsList}
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
        disabledCommands={controls.commands}
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
