import { useEffect, useRef } from 'react';
import { chatOwnsKeyboardShortcuts } from '../../../../../lib/work-queue/chat-owns-keyboard-shortcuts';
import type { AgentsMentionsEditorHandle } from '../../../mentions';
import { agentChatStore } from '../../../stores/agent-chat-store';

type Props = {
  isActive: boolean;
  /** True when this pane is focused. Only the focused pane should handle pane-scoped shortcuts (Escape, Cmd+Enter, Cmd+Down). */
  isPaneActive?: boolean;
  isStreaming: boolean;
  subChatId: string;
  pendingQuestions: unknown;
  hasUnapprovedPlan: boolean;
  editorRef: React.RefObject<AgentsMentionsEditorHandle | null>;
  stop: () => Promise<void>;
  handleQuestionsSkip: () => Promise<unknown>;
  handleApprovePlan: () => void;
  scrollToBottom: () => void;
  /** Set when the user has loaded a queued item into the input for editing. Escape (when not streaming) abandons the edit. */
  editingItemId?: string | null;
  onAbandonEdit?: () => void;
  /**
   * True while a flow run drives this chat (running strip / paused bar shown). The raw stop
   * shortcuts (Escape, Ctrl+C, Cmd+Shift+Backspace) are suppressed: they abort the turn WITHOUT
   * flows.cancelRun, stranding the run "running" over a dead turn — the strip's deliberate
   * Pause / two-step Stop own those verbs (decision flow-run-chat-surface).
   */
  suppressRawStop?: boolean;
};

export function KeyboardShortcutsManager({
  isActive,
  isPaneActive = true,
  isStreaming,
  subChatId,
  pendingQuestions,
  hasUnapprovedPlan,
  editorRef,
  stop,
  handleQuestionsSkip,
  handleApprovePlan,
  scrollToBottom,
  editingItemId = null,
  onAbandonEdit,
  suppressRawStop = false,
}: Props) {
  // Lives inside the chat, so it reports whether this chat is visible at all.
  const chatRef = useRef<HTMLSpanElement>(null);

  // Escape to stop streaming (only when this pane is focused)
  useEffect(() => {
    if (!isActive || !isPaneActive) return;

    const handleKeyDown = async (e: KeyboardEvent) => {
      // If a closer handler already consumed this event (e.g. mentions editor closing its
      // suggestion dropdown via preventDefault on Escape), do nothing. Otherwise pressing
      // Escape to dismiss a mention/slash-command popup would also fire abandon-edit /
      // stop-stream on the same key event.
      if (e.defaultPrevented || !chatOwnsKeyboardShortcuts(chatRef.current)) return;

      let shouldStop = false;
      let shouldSkipQuestions = false;
      let shouldAbandonEdit = false;

      // Check for Escape key
      if (e.key === 'Escape') {
        const target = e.target as HTMLElement;
        const isInsideOverlay = target?.closest('[role="dialog"]');

        // Check if any dialog/modal is open anywhere in the document
        const hasOpenDialog = document.querySelector(
          '[role="dialog"][aria-modal="true"], [data-modal="agents-settings"]',
        );

        if (!isInsideOverlay && !hasOpenDialog) {
          if (isStreaming) {
            if (pendingQuestions) {
              shouldSkipQuestions = true;
            } else if (!suppressRawStop) {
              shouldStop = true;
            }
          } else if (editingItemId && onAbandonEdit) {
            // Not streaming but the user has a queued item loaded for editing — Escape abandons it.
            shouldAbandonEdit = true;
          }
        }
      }

      // Check for Ctrl+C (only Ctrl, not Cmd on Mac)
      if (e.ctrlKey && !e.metaKey && e.code === 'KeyC') {
        if (!isStreaming || suppressRawStop) return;

        const selection = window.getSelection();
        const hasSelection = selection && selection.toString().length > 0;

        // If there's a text selection, let browser handle copy
        if (hasSelection) return;

        shouldStop = true;
      }

      // Check for Cmd+Shift+Backspace (Mac) or Ctrl+Shift+Backspace (Windows/Linux)
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key === 'Backspace' &&
        isStreaming &&
        !suppressRawStop
      ) {
        shouldStop = true;
      }

      if (shouldSkipQuestions) {
        e.preventDefault();
        await handleQuestionsSkip();
      } else if (shouldStop) {
        e.preventDefault();
        agentChatStore.setManuallyAborted(subChatId, true);
        await stop();
      } else if (shouldAbandonEdit && onAbandonEdit) {
        e.preventDefault();
        onAbandonEdit();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    isActive,
    isPaneActive,
    isStreaming,
    stop,
    subChatId,
    pendingQuestions,
    handleQuestionsSkip,
    editingItemId,
    onAbandonEdit,
    suppressRawStop,
  ]);

  // Cmd+Enter to approve plan (only when this pane is focused)
  useEffect(() => {
    if (!isActive || !isPaneActive) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!chatOwnsKeyboardShortcuts(chatRef.current)) return;
      if (e.key === 'Enter' && e.metaKey && !e.shiftKey && hasUnapprovedPlan && !isStreaming) {
        e.preventDefault();
        handleApprovePlan();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, isPaneActive, hasUnapprovedPlan, isStreaming, handleApprovePlan]);

  // Cmd/Ctrl + Arrow Down to scroll to bottom (only when this pane is focused)
  useEffect(() => {
    if (!isActive || !isPaneActive) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!chatOwnsKeyboardShortcuts(chatRef.current)) return;
      if (e.key === 'ArrowDown' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        const inputValue = editorRef.current?.getValue() || '';
        if (inputValue.trim().length > 0) {
          return;
        }

        e.preventDefault();
        scrollToBottom();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, isPaneActive, scrollToBottom, editorRef]);

  return <span ref={chatRef} aria-hidden />;
}
