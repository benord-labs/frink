/* eslint-disable max-lines, max-lines-per-function */

import { Button } from '@benord-labs/frink-primitives';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ChatAtmosphereSurface } from '@/components/ChatAtmosphereSurface';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { type NewChatTarget, shouldScaffoldNewProject } from '@/lib/agent-chat/new-chat-target';
import { newChatTerminalId } from '@/lib/agent-chat/sentinel-ids';
import {
  chatContextFileAtomFamily,
  chatContextFileDismissedAtomFamily,
  clearCodeSelectionContextAtomFamily,
  codeSelectionContextAtomFamily,
} from '@/lib/code-editor/state';
import { commandFetcher } from '@/lib/commands/command-fetcher';
import { expandSlashCommand } from '@/lib/commands/expand-slash-command';
import { pastedTextMention } from '@/lib/mentions/queued-message-text';
import type { TaskData } from '@/lib/tasks/format-task-message';
import {
  CLAUDE_CODE_MODELS,
  CODEX_MODELS,
  claudeModelToPickerItem,
  codexModelToPickerItem,
  isClaudeModelVisible,
  isCodexModelVisible,
} from '../../../../shared/lib/models';
import type { ChatMode } from '../../../../shared/types/chat-mode';
import { usePersistedToggle } from '../../../hooks/use-persisted-toggle';
import {
  agentsSettingsDialogActiveTabAtom,
  agentsSettingsDialogOpenAtom,
  hiddenModelsAtom,
  pendingAccountAuthAtom,
} from '../../../lib/atoms';
import { appStore } from '../../../lib/jotai-store';
import { trpc } from '../../../lib/trpc';
import { runChatShortcutAction } from '../../../lib/work-queue/chat-owns-keyboard-shortcuts';
import { terminalSidebarOpenAtomFamily } from '../../terminal/atoms';
import { TerminalBottomPanel } from '../../terminal/terminal-bottom-panel';
import {
  agentsDebugModeAtom,
  agentsSidebarOpenAtom,
  agentsUnseenChangesAtom,
  NEW_CHAT_PANE,
  newChatWorktreePathAtom,
  pendingNewChatTextAtom,
  splitViewActivePaneIndexAtom,
  splitViewChatIdsAtom,
} from '../atoms';
import {
  AgentsSlashCommand,
  COMMAND_PROMPTS,
  LazyCommandEditorModal,
  SLASH_COMMAND_LISTBOX_ID,
  type SlashCommandOption,
} from '../commands';
import { NewChatFormHeader } from '../components/new-chat-form-header';
import { NoAccountsEmptyState } from '../components/no-accounts-empty-state';
import { shouldShowWorktreeBanner, WorktreeBanner } from '../components/worktree-banner';
import { useBranchManagement } from '../hooks/use-branch-management';
import { useCommandEditor } from '../hooks/use-command-editor';
import { useDraftManagement } from '../hooks/use-draft-management';
import { useEditorHandlers } from '../hooks/use-editor-handlers';
import { useEffectiveModelForPane } from '../hooks/use-effective-model-for-pane';
import { useEffectiveChatModeForPane } from '../hooks/use-effective-plan-mode-for-pane';
import { useEffectiveProjectForPane } from '../hooks/use-effective-project-for-pane';
import { useEffectiveWorkModeForPane } from '../hooks/use-effective-work-mode-for-pane';
import { useFocusInputOnEnter } from '../hooks/use-focus-input-on-enter';
import { useModelNormalization } from '../hooks/use-model-normalization';
import { useToggleFocusOnCmdEsc } from '../hooks/use-toggle-focus-on-cmd-esc';
import { newChatDraftKey } from '../lib/drafts';
import { createNewChatStaging, seedNewChatNavigation } from '../lib/new-chat-navigation';
import { cleanupSentinelState } from '../lib/sentinel-cleanup';
import {
  AgentsFileMention,
  type AgentsMentionsEditorHandle,
  type FileMentionOption,
  MENTION_PREVIEW_SANITIZE_REGEX,
} from '../mentions';
import { ActionsToolbar } from './ActionsToolbar';
import { ChatInputContextBar } from './active-chat/components/ChatInputContextBar';
import { GitBranchCheckout } from './active-chat/components/git-branch-checkout';
import {
  accountGateRefetchInterval,
  ACCOUNT_NOT_READY_TOAST_MESSAGE_START_CHAT,
  showAccountNotReadyToast,
  type UnauthAccountForSend,
  utf8ToBase64,
} from './active-chat/utils';
import { EditorSection } from './EditorSection';
import { LIMITS, STRINGS } from './new-chat-form-constants';
import { ProjectSelectionSection } from './ProjectSelectionSection';

type NewChatFormProps = {
  isMobileFullscreen?: boolean;
  onBackToChats?: () => void;
  /** When in split view, the 0-based pane index. Enables file tree toggle in header. */
  splitPaneIndex?: number;
};

export function NewChatForm({
  isMobileFullscreen = false,
  onBackToChats,
  splitPaneIndex,
}: NewChatFormProps) {
  // Sidebar and chat state
  const [sidebarOpen, setSidebarOpen] = useAtom(agentsSidebarOpenAtom);
  const unseenChanges = useAtomValue(agentsUnseenChangesAtom);
  const hasAnyUnseenChanges = unseenChanges.size > 0;
  const [hasContent, setHasContent] = useState(false);
  // 'new' scaffolds a project; the other targets create general chats.
  const [newChatTarget, setNewChatTarget] = useState<NewChatTarget>('unset');
  const {
    project: selectedProject,
    setProject: setSelectedProject,
    validatedProject,
  } = useEffectiveProjectForPane(splitPaneIndex);
  const localProjectPath = validatedProject?.path;

  /** Per-pane sentinel for terminal state — keyed so split-view panes don't collide */
  const terminalId = useMemo(() => newChatTerminalId(splitPaneIndex), [splitPaneIndex]);
  const draftKey = useMemo(() => newChatDraftKey(splitPaneIndex), [splitPaneIndex]);

  // Code selection and active file from editor (keyed by NEW_CHAT_PANE so selection is written when this pane is active)
  const codeSelectionContext = useAtomValue(codeSelectionContextAtomFamily(NEW_CHAT_PANE));
  const clearCodeSelectionContext = useSetAtom(clearCodeSelectionContextAtomFamily(NEW_CHAT_PANE));
  const chatContextFile = useAtomValue(chatContextFileAtomFamily(NEW_CHAT_PANE));
  const activeFileDismissed = useAtomValue(chatContextFileDismissedAtomFamily(NEW_CHAT_PANE));
  const setActiveFileDismissed = useSetAtom(chatContextFileDismissedAtomFamily(NEW_CHAT_PANE));

  // TerminalBottomPanel skips its own registration to avoid duplicate active-chat handlers.
  useEffect(() => {
    if (!localProjectPath) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey || e.code !== 'KeyJ') return;
      if (e.shiftKey) return; // ⌘⇧J = mode toggle, not applicable (no sidebar in new-chat)

      // In split view, only the active pane responds (same atoms as subscribed UI reads)
      if (splitPaneIndex !== undefined) {
        const chatIds = appStore.get(splitViewChatIdsAtom);
        const activePaneIndex = appStore.get(splitViewActivePaneIndexAtom);
        if (chatIds.length >= 2 && activePaneIndex !== splitPaneIndex) return;
      }

      e.preventDefault();
      e.stopPropagation();
      const wasOpen = appStore.get(terminalSidebarOpenAtomFamily(terminalId));
      runChatShortcutAction(appStore, true, () =>
        appStore.set(terminalSidebarOpenAtomFamily(terminalId), !wasOpen),
      );

      if (wasOpen) {
        requestAnimationFrame(() => {
          const chatIds = appStore.get(splitViewChatIdsAtom);
          const activePaneIndex = appStore.get(splitViewActivePaneIndexAtom);
          const isSplit = chatIds.length >= 2;
          const container = isSplit
            ? document.querySelector(`[data-pane-index="${activePaneIndex}"]`)
            : document;
          const editor =
            (container?.querySelector('[contenteditable="true"]') as HTMLElement) ??
            (container?.querySelector('textarea, input') as HTMLElement);
          editor?.focus();
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [localProjectPath, terminalId, splitPaneIndex]);

  useEffect(() => {
    return () => cleanupSentinelState(terminalId);
  }, [terminalId]);

  const setPendingAccountAuth = useSetAtom(pendingAccountAuthAtom);

  const { chatMode, setChatMode, cycleChatMode } = useEffectiveChatModeForPane(splitPaneIndex, {
    hasProject: Boolean(selectedProject),
  });
  const [staging] = useState(createNewChatStaging);
  const { workMode, setWorkMode } = useEffectiveWorkModeForPane(splitPaneIndex);
  const [selectedWorktreePath, setSelectedWorktreePath] = useAtom(newChatWorktreePathAtom);

  // New chat intentionally omits SplitPaneBranchBarHeightSync for its distinct column layout.

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset on project ID change only
  useEffect(() => {
    setSelectedWorktreePath(null);
  }, [selectedProject?.id]);
  const _debugMode = useAtomValue(agentsDebugModeAtom);
  const setSettingsDialogOpen = useSetAtom(agentsSettingsDialogOpenAtom);
  const setSettingsActiveTab = useSetAtom(agentsSettingsDialogActiveTabAtom);

  const branchManagement = useBranchManagement({
    project: validatedProject ? { id: validatedProject.id, path: validatedProject.path } : null,
  });
  const [createBranchDialogOpen, setCreateBranchDialogOpen] = useState(false);

  const [worktreeBannerDismissed, setWorktreeBannerDismissed] = usePersistedToggle(
    'worktree-banner-dismissed',
  );

  const { data: worktreeConfigData } = trpc.worktreeConfig.get.useQuery(
    { projectId: validatedProject?.id ?? '' },
    { enabled: !!validatedProject?.id && workMode === 'worktree' && !worktreeBannerDismissed },
  );

  const showWorktreeBanner = shouldShowWorktreeBanner({
    workMode,
    projectPath: validatedProject?.path,
    dismissed: worktreeBannerDismissed,
    configData: worktreeConfigData,
  });

  const handleDismissWorktreeBanner = () => {
    setWorktreeBannerDismissed(true);
  };

  const handleConfigureWorktree = () => {
    if (validatedProject?.id) {
      setSettingsActiveTab(`project-${validatedProject.id}`);
      setSettingsDialogOpen(true);
    }
  };

  const { data: resolvedAccount, isSuccess: accountResolved } =
    trpc.claudeCode.getResolvedAccount.useQuery(
      { projectId: validatedProject?.id },
      { staleTime: 30000, refetchInterval: accountGateRefetchInterval },
    );
  const isCodexAccount = resolvedAccount?.type === 'codex';

  const hiddenModelFamilies = useAtomValue(hiddenModelsAtom);
  const { lastSelectedModelId, setLastSelectedModelId } = useEffectiveModelForPane(splitPaneIndex);
  // Claude models: filter by visibility and map to picker items
  const visibleClaudeModels = useMemo(
    () => CLAUDE_CODE_MODELS.filter((m) => isClaudeModelVisible(m, hiddenModelFamilies)),
    [hiddenModelFamilies],
  );
  const claudeModelsList = useMemo(
    () => visibleClaudeModels.map(claudeModelToPickerItem),
    [visibleClaudeModels],
  );

  // Codex models: filter by visibility and map to picker items
  const visibleCodexModels = useMemo(
    () => CODEX_MODELS.filter((m) => isCodexModelVisible(m, hiddenModelFamilies)),
    [hiddenModelFamilies],
  );
  const codexModelsList = useMemo(
    () => visibleCodexModels.map(codexModelToPickerItem),
    [visibleCodexModels],
  );

  const modelsList = isCodexAccount ? codexModelsList : claudeModelsList;
  const selectedModel = isCodexAccount
    ? codexModelToPickerItem(
        visibleCodexModels.find((m) => m.id === lastSelectedModelId) ??
          visibleCodexModels[0] ??
          CODEX_MODELS[0],
      )
    : (claudeModelsList.find((m) => m.id === lastSelectedModelId) ?? claudeModelsList[0]);

  // Normalize model selection when account type changes (Codex ↔ Claude)
  useModelNormalization(
    isCodexAccount,
    lastSelectedModelId,
    setLastSelectedModelId,
    accountResolved,
  );

  // Editor and file input refs
  const editorRef = useRef<AgentsMentionsEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [slashActiveDescendantId, setSlashActiveDescendantId] = useState<string | undefined>();

  // Composer content and its persistence across destination changes (Flows/Settings unmount us).
  const {
    images,
    handleAddAttachments,
    removeImage,
    clearImages,
    isUploading,
    pastedTexts,
    addPastedText,
    removePastedText,
    clearPastedTexts,
    taskAttachment,
    handleContentChange,
    clearCurrentDraft,
    beginSend,
    resumeDraftPersistence,
    hasAttachments,
  } = useDraftManagement({ editorRef, setHasContent, draftKey });

  // Editor handlers (mentions, slash, paste, drag & drop)
  const editorHandlers = useEditorHandlers({
    onAddAttachments: handleAddAttachments,
    onAddPastedText: addPastedText,
    onAddTaskContext: useCallback(
      (taskData: TaskData) => {
        taskAttachment.setAttachedTask(taskData);
        editorRef.current?.focus();
      },
      [taskAttachment],
    ),
  });

  // tRPC utils for cache invalidation & data fetching
  const utils = trpc.useUtils();

  // Command editor modal state (shared hook)
  const commandEditor = useCommandEditor({
    onBeforeEdit: editorHandlers.handleCloseSlashTrigger,
  });

  // Mode tooltip state
  const [modeTooltip, setModeTooltip] = useState<{
    visible: boolean;
    position: { top: number; left: number };
    mode: ChatMode;
  } | null>(null);
  const tooltipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasShownTooltipRef = useRef(false);
  const [modeDropdownOpen, setModeDropdownOpen] = useState(false);
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);

  const handleOpenModelSettings = useCallback(() => {
    setIsModelDropdownOpen(false);
    setSettingsActiveTab('models');
    setSettingsDialogOpen(true);
  }, [setSettingsActiveTab, setSettingsDialogOpen]);

  // Keyboard shortcuts
  useFocusInputOnEnter(editorRef, splitPaneIndex);
  useToggleFocusOnCmdEsc(editorRef, splitPaneIndex);

  // Auto-focus input when NewChatForm is shown (skip on mobile)
  useEffect(() => {
    if (isMobileFullscreen) return;
    const timeoutId = setTimeout(() => {
      editorRef.current?.focus();
    }, LIMITS.AUTOFOCUS_DELAY_MS);
    return () => clearTimeout(timeoutId);
  }, [isMobileFullscreen]);

  const createChatMutation = trpc.chats.create.useMutation({
    onSuccess: async (data, variables) => {
      // Link task to chat if present
      if (variables.taskId) {
        await taskAttachment.linkTaskToChat(variables.taskId, data.id);
      }

      // Clear editor, images, pasted texts, attached task, code selection, and command banner on success
      editorRef.current?.clear();
      clearImages();
      clearPastedTexts();
      taskAttachment.clearTask();
      clearCurrentDraft();
      appStore.set(newChatWorktreePathAtom, null);
      appStore.set(pendingNewChatTextAtom, null);
      appStore.set(codeSelectionContextAtomFamily(NEW_CHAT_PANE), null);
      appStore.set(chatContextFileDismissedAtomFamily(NEW_CHAT_PANE), false);
      utils.chats.list.invalidate();
      utils.chats.listCounts.invalidate();

      // Navigate + seed per-chat atoms (shared with the goal-first build flow).
      seedNewChatNavigation(appStore.get, appStore.set, data.id, {
        isCodexAccount,
        subChatId: data.subChats?.[0]?.id,
        autoModeEnabled: staging.pending.autoMode,
        codexSpeed: staging.pending.codexSpeed,
      });

      // Chat created — keep the scaffolded project and release the send guard.
      scaffoldedProjectIdRef.current = null;
      isSendingRef.current = false;

      // Clean up sentinel state from localStorage to prevent stale entries
      cleanupSentinelState(terminalId);
    },
    onError: (error) => {
      appStore.set(pendingNewChatTextAtom, null);
      isSendingRef.current = false;
      resumeDraftPersistence();
      // Roll back a project scaffolded for this send so we don't orphan a folder with no chat.
      const orphanId = scaffoldedProjectIdRef.current;
      if (orphanId) {
        deleteProject.mutate({ id: orphanId });
        scaffoldedProjectIdRef.current = null;
      }
      toast.error(error.message);
    },
  });

  // "New project" default (epic sc-788): when no existing project is selected, sending scaffolds
  // a gitless ~/.frink/builds/<slug> project so non-technical users never face a repo decision.
  const scaffoldProject = trpc.projects.scaffold.useMutation();
  const deleteProject = trpc.projects.delete.useMutation({
    onSuccess: () => {
      utils.projects.list.invalidate();
    },
  });
  // Tracks a project scaffolded for THIS send so it can be rolled back if chat creation fails
  // (otherwise a freshly-scaffolded folder + DB row would be left with no chat).
  const scaffoldedProjectIdRef = useRef<string | null>(null);
  // Guards against a rapid double-send (Enter pressed twice during the scaffold await) creating
  // duplicate projects + chats. Cleared on the chat mutation's terminal callbacks.
  const isSendingRef = useRef(false);

  const handleSend = useCallback(async () => {
    // Prepend attached task message if present
    const taskToLink = taskAttachment.prependTaskMessage();

    // Get value from uncontrolled editor
    let message: string = editorRef.current?.getValue() || '';

    // Allow send if there's text, images, pasted text files, code selection, or attached task
    const hasText = message.trim().length > 0;
    const hasImages = images.filter((img) => !img.isLoading && img.url).length > 0;
    const hasPastedTexts = pastedTexts.length > 0;

    if (!hasText && !hasImages && !hasPastedTexts && !codeSelectionContext) {
      return;
    }

    // Gate: if no authenticated account exists, surface a friendly toast pointing
    // at the Connect Claude flow rather than letting the executor produce its
    // user-hostile "No Claude Code credentials configured" error mid-execution.
    if (accountResolved && (resolvedAccount === null || !resolvedAccount.isAuthenticated)) {
      const unauthForSend: UnauthAccountForSend =
        resolvedAccount && !resolvedAccount.isAuthenticated
          ? { label: resolvedAccount.label, type: resolvedAccount.type }
          : null;
      showAccountNotReadyToast(unauthForSend, setPendingAccountAuth, {
        message: ACCOUNT_NOT_READY_TOAST_MESSAGE_START_CHAT,
      });
      return;
    }

    // Expand custom slash commands (e.g. "/hello world" → command content with $ARGUMENTS replaced)
    message = await expandSlashCommand(message, localProjectPath, commandFetcher);

    // Build message parts array (images first, then text)
    type MessagePart =
      | { type: 'text'; text: string }
      | {
          type: 'data-image';
          data: {
            url: string;
            mediaType?: string;
            filename?: string;
            base64Data?: string;
          };
        };

    const parts: MessagePart[] = images
      .filter((img) => !img.isLoading && img.url)
      .map((img) => ({
        type: 'data-image' as const,
        data: {
          url: img.url || '',
          mediaType: img.mediaType,
          filename: img.filename,
          base64Data: img.base64Data,
        },
      }));

    // Add code selection as mention (same format as active-chat useMessageSend)
    // Encode fileName so colons (e.g. Windows drive) don't break delimiter-based parsing
    let mentionPrefix = '';
    if (codeSelectionContext) {
      const preview = codeSelectionContext.preview.replace(MENTION_PREVIEW_SANITIZE_REGEX, '');
      const encodedText = utf8ToBase64(codeSelectionContext.text);
      const safeFileName = encodeURIComponent(codeSelectionContext.fileName);
      mentionPrefix = `@[code:${safeFileName}:${codeSelectionContext.startLine}-${codeSelectionContext.endLine}:${preview}:${encodedText}] `;
    }

    // Add pasted text as pasted mentions (format: pasted:size:preview|filepath)
    // Use "|" as separator since file paths can contain colons.
    let finalMessage: string = message.trim();
    if (pastedTexts.length > 0) {
      const pastedMentions = pastedTexts.map(pastedTextMention).join(' ');
      finalMessage = pastedMentions + (finalMessage ? ` ${finalMessage}` : '');
    }

    // getValue() automatically encodes command-highlight blocks with [/cmd:] delimiters
    if (mentionPrefix || finalMessage) {
      parts.push({ type: 'text' as const, text: mentionPrefix + finalMessage });
    }

    const taskTitleForNaming = taskToLink?.title.trim() || undefined;
    const initialName = message.trim().slice(0, 50) || taskTitleForNaming || undefined;

    // Block a concurrent send (double Enter during the scaffold await) — would create duplicates.
    if (isSendingRef.current) return;
    isSendingRef.current = true;
    beginSend();

    // Store the submitted text so null panes can show a loading view during the API call
    appStore.set(pendingNewChatTextAtom, message.trim() || initialName || '');

    // "New project" default: no existing project selected → scaffold a gitless one from the
    // message so the agent has a real cwd. Existing-project selections are untouched.
    let projectId = selectedProject?.id ?? '';
    let projectPath = selectedProject?.path ?? '';
    // No project selected: scaffold a Frink-managed project only if the user picked "New
    // project". Otherwise it's a general chat (empty projectId, no folder created).
    scaffoldedProjectIdRef.current = null;
    if (shouldScaffoldNewProject(!!selectedProject, newChatTarget)) {
      try {
        const built = await scaffoldProject.mutateAsync({
          goal: message.trim() || initialName || 'New project',
        });
        projectId = built.id;
        projectPath = built.path;
        scaffoldedProjectIdRef.current = built.id;
        utils.projects.list.invalidate();
      } catch (err) {
        appStore.set(pendingNewChatTextAtom, null);
        isSendingRef.current = false;
        resumeDraftPersistence();
        toast.error(err instanceof Error ? err.message : 'Failed to create your project');
        return;
      }
    }

    // Create chat with the selected or freshly-scaffolded project, branch, message, and task ID
    staging.capture();
    createChatMutation.mutate({
      projectId,
      projectPath,
      name: initialName,
      taskId: taskToLink?.id,
      taskTitle: taskTitleForNaming,
      initialMessageParts: parts.length > 0 ? parts : undefined,
      baseBranch:
        workMode === 'worktree' && selectedProject
          ? branchManagement.selectedBranch || undefined
          : undefined,
      branchType:
        workMode === 'worktree' && selectedProject
          ? branchManagement.selectedBranchType
          : undefined,
      useWorktree: workMode === 'worktree' && !!selectedProject,
      existingWorktreePath:
        workMode !== 'worktree' && selectedWorktreePath ? selectedWorktreePath : undefined,
      mode: chatMode,
    });
    // Editor, images, pasted texts, and attached task are cleared in onSuccess callback
  }, [
    taskAttachment,
    selectedProject,
    localProjectPath,
    createChatMutation,
    scaffoldProject,
    newChatTarget,
    beginSend,
    resumeDraftPersistence,
    branchManagement.selectedBranch,
    branchManagement.selectedBranchType,
    workMode,
    selectedWorktreePath,
    images,
    pastedTexts,
    codeSelectionContext,
    chatMode,
    utils,
    accountResolved,
    resolvedAccount,
    setPendingAccountAuth,
  ]);

  const handleMentionSelect = useCallback(
    (mention: FileMentionOption) => {
      // Category navigation - enter subpage instead of inserting mention
      if (mention.type === 'category') {
        if (mention.id === 'files') {
          editorHandlers.setShowingFilesList(true);
          return;
        }
        if (mention.id === 'skills') {
          editorHandlers.setShowingSkillsList(true);
          return;
        }
        if (mention.id === 'agents') {
          editorHandlers.setShowingAgentsList(true);
          return;
        }
        if (mention.id === 'tools') {
          editorHandlers.setShowingToolsList(true);
          return;
        }
      }

      // Otherwise: insert mention as normal
      editorRef.current?.insertMention(mention);
      editorHandlers.handleCloseTrigger();
    },
    [editorHandlers],
  );

  // Save draft to localStorage when content changes - removed duplicate, now using hook

  const handleSlashSelect = useCallback(
    (command: SlashCommandOption) => {
      // Clear the slash command text from editor
      editorRef.current?.clearSlashCommand();
      editorHandlers.handleCloseSlashTrigger();

      // Handle builtin commands
      if (command.category === 'builtin') {
        switch (command.name) {
          case 'plan':
            if (chatMode !== 'plan') setChatMode('plan');
            break;
          case 'agent':
            if (chatMode !== 'agent') setChatMode('agent');
            break;
          case 'debug':
            if (selectedProject && chatMode !== 'debug') setChatMode('debug');
            break;
          // Prompt-based commands - insert as highlighted command block
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
    [chatMode, setChatMode, editorHandlers, selectedProject],
  );

  // Container click handler
  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    const { target } = e;
    // Portaled popovers (e.g. the project picker) bubble clicks through React but sit outside the DOM.
    if (!(target instanceof Element) || !e.currentTarget.contains(target)) return;
    if (!target.closest('button, [contenteditable]')) editorRef.current?.focus();
  }, []);

  const splitActivePaneIndex = useAtomValue(splitViewActivePaneIndexAtom);
  const isActivePane = splitPaneIndex === undefined || splitPaneIndex === splitActivePaneIndex;

  const projectSelectionProps = {
    project: validatedProject
      ? {
          id: validatedProject.id,
          name: validatedProject.name,
          path: validatedProject.path,
          gitOwner: validatedProject.gitOwner,
          gitProvider: validatedProject.gitProvider,
        }
      : null,
    overrideProject: splitPaneIndex !== undefined ? selectedProject : undefined,
    onOverrideProjectChange: splitPaneIndex !== undefined ? setSelectedProject : undefined,
    newChatTarget,
    onNewChatTargetChange: setNewChatTarget,
    workMode,
    branches: branchManagement.branches,
    selectedBranch: branchManagement.selectedBranch,
    selectedBranchType: branchManagement.selectedBranchType,
    defaultBranch: branchManagement.defaultBranch,
    isLoadingBranches: branchManagement.isLoading,
    isCreatingChat: createChatMutation.isPending,
    branchSearch: branchManagement.branchSearch,
    branchPopoverOpen: branchManagement.branchPopoverOpen,
    createBranchDialogOpen,
    onWorkModeChange: setWorkMode,
    onBranchSelect: branchManagement.setSelectedBranch,
    onBranchSearchChange: branchManagement.setBranchSearch,
    onBranchPopoverOpenChange: branchManagement.setBranchPopoverOpen,
    onCreateBranchDialogOpenChange: setCreateBranchDialogOpen,
    onBranchCreated: (branchName: string) => {
      branchManagement.setSelectedBranch(branchName, 'local');
    },
  };

  return (
    <div className="flex h-full">
      {/* Main column */}
      <ChatAtmosphereSurface className="h-full">
        <div className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col">
          <NewChatFormHeader
            isMobileFullscreen={isMobileFullscreen}
            isSidebarOpen={sidebarOpen}
            hasUnseenChanges={hasAnyUnseenChanges}
            onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
            onBackToChats={onBackToChats}
            projectId={validatedProject?.id}
            splitPaneIndex={splitPaneIndex}
            projectPath={localProjectPath}
          />

          <div className="flex flex-1 items-center justify-center overflow-y-auto relative">
            <div className="@container/hero w-full max-w-2xl space-y-4 md:space-y-6 relative z-10 px-4">
              {/*
                When no authenticated account exists we show ONLY the empty state.
                Showing the chat editor underneath is contradictory — the user can't
                send anything until they connect. The "What needs to happen next?"
                title is also hidden because the empty-state card has its own heading.
                The top-left AccountIndicator separately surfaces the
                unauthenticated row's amber warning state.
              */}
              {accountResolved && (resolvedAccount === null || !resolvedAccount.isAuthenticated) ? (
                <NoAccountsEmptyState
                  existingAccount={
                    resolvedAccount && !resolvedAccount.isAuthenticated
                      ? {
                          label: resolvedAccount.label,
                          type: resolvedAccount.type,
                        }
                      : null
                  }
                />
              ) : (
                <>
                  <div className="text-center">
                    <h1 className="text-2xl @min-[19.25rem]/hero:text-4xl text-balance font-medium tracking-tight">
                      {STRINGS.TITLE}
                    </h1>
                  </div>

                  {/* Drop zone container */}
                  <section
                    className="@container/composer relative w-full"
                    onDragOver={editorHandlers.handleDragOver}
                    onDragLeave={editorHandlers.handleDragLeave}
                    onDrop={(e) => {
                      editorHandlers.handleDrop(e);
                      // Refocus editor after drop
                      requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                          editorRef.current?.focus();
                        });
                      });
                    }}
                    aria-label="Drop zone for files"
                  >
                    {/* biome-ignore lint/a11y/useSemanticElements: Container for editor focus, actual input is AgentsMentionsEditor */}
                    <div
                      className="relative w-full cursor-text"
                      role="textbox"
                      tabIndex={-1}
                      onClick={handleContainerClick}
                      onKeyDown={(e) => {
                        // Allow keyboard interaction to focus editor
                        // Only handle when the event target is this container (not bubbled from editor)
                        if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                          e.preventDefault();
                          editorRef.current?.focus();
                        }
                      }}
                    >
                      {/* Code selection / active file context chip (same UX as chat input) */}
                      {(codeSelectionContext || (chatContextFile && !activeFileDismissed)) && (
                        <div className="flex flex-wrap gap-1 mb-2">
                          {codeSelectionContext ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  onClick={() => {
                                    clearCodeSelectionContext();
                                    setActiveFileDismissed(true);
                                  }}
                                  className="flex gap-1 min-h-[44px] min-w-[44px] h-auto px-2 py-1 text-xs rounded-md font-normal"
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
                          ) : chatContextFile ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  onClick={() => setActiveFileDismissed(true)}
                                  className="flex min-h-[44px] min-w-[44px] h-auto px-2 py-1 text-xs rounded-md font-normal"
                                  aria-label={`Remove ${chatContextFile.name} from context`}
                                >
                                  <span className="truncate max-w-[120px]">
                                    {chatContextFile.name}
                                  </span>
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {chatContextFile.name} — click to remove from context
                              </TooltipContent>
                            </Tooltip>
                          ) : null}
                        </div>
                      )}
                      <EditorSection
                        editorRef={editorRef}
                        images={images}
                        pastedTexts={pastedTexts}
                        attachedTask={taskAttachment.attachedTask}
                        isFocused={editorHandlers.isFocused}
                        isDragOver={editorHandlers.isDragOver}
                        isDisabled={createChatMutation.isPending || scaffoldProject.isPending}
                        isMobileFullscreen={isMobileFullscreen}
                        onRemoveImage={removeImage}
                        onRemovePastedText={removePastedText}
                        onRemoveTask={taskAttachment.clearTask}
                        slashActiveDescendantId={slashActiveDescendantId}
                        slashCommandListboxId={
                          editorHandlers.showSlashDropdown ? SLASH_COMMAND_LISTBOX_ID : undefined
                        }
                        onMentionTrigger={(params) => {
                          if (validatedProject) {
                            editorHandlers.handleMentionTrigger(params);
                          }
                        }}
                        onCloseTrigger={editorHandlers.handleCloseTrigger}
                        onSlashTrigger={editorHandlers.handleSlashTrigger}
                        onCloseSlashTrigger={editorHandlers.handleCloseSlashTrigger}
                        onContentChange={handleContentChange}
                        onSubmit={handleSend}
                        onShiftTab={cycleChatMode}
                        onPaste={editorHandlers.handlePaste}
                        onFocus={() => editorHandlers.setIsFocused(true)}
                        onBlur={() => editorHandlers.setIsFocused(false)}
                      >
                        <ActionsToolbar
                          codexSpeedRef={staging.codexSpeed}
                          chatMode={chatMode}
                          onModeChange={setChatMode}
                          modeDropdownOpen={modeDropdownOpen}
                          onModeDropdownOpenChange={setModeDropdownOpen}
                          modeTooltip={modeTooltip}
                          onModeTooltipChange={setModeTooltip}
                          tooltipTimeoutRef={tooltipTimeoutRef}
                          hasShownTooltipRef={hasShownTooltipRef}
                          disableDebugMode={!selectedProject}
                          autoMode={{
                            autoModeRef: staging.autoMode,
                            accountResolved,
                            account: resolvedAccount,
                            selectedModelId: lastSelectedModelId,
                          }}
                          selectedModel={selectedModel}
                          availableModels={modelsList}
                          onModelChange={(model) => setLastSelectedModelId(model.id)}
                          modelVariant={isCodexAccount ? 'codex' : 'claude'}
                          isModelDropdownOpen={isModelDropdownOpen}
                          onModelDropdownOpenChange={setIsModelDropdownOpen}
                          onOpenModelSettings={handleOpenModelSettings}
                          fileInputRef={fileInputRef}
                          images={images}
                          onAttachClick={() => fileInputRef.current?.click()}
                          onFileInputChange={(e) => {
                            const files = Array.from(e.target.files || []);
                            handleAddAttachments(files);
                            e.target.value = '';
                          }}
                          hasContent={hasContent || !!codeSelectionContext || hasAttachments}
                          isUploading={isUploading}
                          isSubmitting={createChatMutation.isPending || scaffoldProject.isPending}
                          onSend={handleSend}
                        />
                      </EditorSection>

                      {validatedProject && workMode === 'local' ? (
                        <GitBranchCheckout
                          worktreePath={validatedProject.path}
                          currentBranch={branchManagement.currentBranch}
                          isActive={isActivePane}
                          branchPickerClassName="min-w-0"
                        >
                          {({ branchPicker, dialogNodes }) => (
                            <>
                              <ProjectSelectionSection
                                {...projectSelectionProps}
                                localBranchCheckoutPicker={branchPicker}
                              />
                              {dialogNodes}
                            </>
                          )}
                        </GitBranchCheckout>
                      ) : (
                        <ProjectSelectionSection {...projectSelectionProps} />
                      )}

                      {showWorktreeBanner && (
                        <WorktreeBanner
                          onConfigure={handleConfigureWorktree}
                          onDismiss={handleDismissWorktreeBanner}
                        />
                      )}

                      <AgentsFileMention
                        isOpen={editorHandlers.showMentionDropdown && !!validatedProject}
                        onClose={editorHandlers.handleCloseTrigger}
                        onSelect={handleMentionSelect}
                        searchText={editorHandlers.mentionSearchText}
                        position={editorHandlers.mentionPosition}
                        projectPath={localProjectPath}
                        showingFilesList={editorHandlers.showingFilesList}
                        showingSkillsList={editorHandlers.showingSkillsList}
                        showingAgentsList={editorHandlers.showingAgentsList}
                        showingToolsList={editorHandlers.showingToolsList}
                      />

                      <AgentsSlashCommand
                        isOpen={editorHandlers.showSlashDropdown}
                        onClose={editorHandlers.handleCloseSlashTrigger}
                        onSelect={handleSlashSelect}
                        searchText={editorHandlers.slashSearchText}
                        position={editorHandlers.slashPosition}
                        projectPath={localProjectPath}
                        hasProject={Boolean(selectedProject)}
                        chatMode={chatMode}
                        onCreateCommand={commandEditor.openCreate}
                        onEditCommand={commandEditor.openEdit}
                        onForkCommand={commandEditor.handleFork}
                        onActiveDescendantChange={setSlashActiveDescendantId}
                      />
                    </div>
                  </section>
                </>
              )}
            </div>
          </div>

          {validatedProject && workMode === 'worktree' && (
            <ChatInputContextBar
              currentBranch={null}
              workspaceFolderName={validatedProject.path.split('/').pop()}
              worktreePath={selectedWorktreePath ?? validatedProject.path}
              className="w-full shrink-0 px-4 pb-2"
            />
          )}

          {validatedProject && workMode === 'local' && (
            <ChatInputContextBar
              currentBranch={null}
              workspaceFolderName={validatedProject.name}
              worktreePath={validatedProject.path}
              className="w-full shrink-0 px-4 pb-2"
            />
          )}

          {/* Terminal bottom panel — always bottom in new chat (no sidebar available) */}
          {localProjectPath && (
            <TerminalBottomPanel
              chatId={terminalId}
              cwd={selectedWorktreePath ?? localProjectPath}
              workspaceId={terminalId}
              autoCreate
              hideModeSwitcher
            />
          )}

          {/* Command editor modal (lazy-loaded) */}
          {commandEditor.commandEditorOpen && (
            <Suspense fallback={null}>
              <LazyCommandEditorModal
                open={commandEditor.commandEditorOpen}
                onOpenChange={commandEditor.setCommandEditorOpen}
                editingCommand={commandEditor.editingCommand}
                prefillName={commandEditor.prefillName}
                prefillContent={commandEditor.prefillContent}
                projectPath={localProjectPath}
              />
            </Suspense>
          )}
        </div>
      </ChatAtmosphereSurface>
    </div>
  );
}
