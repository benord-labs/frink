import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { commandFetcher } from '@/lib/commands/command-fetcher';
import { expandSlashCommand } from '@/lib/commands/expand-slash-command';
import { isRunBusy } from '../../../../../lib/agent-chat/steer/run-busy';
import type { TextSelectionSource } from '../../../context/text-selection-context';
import { MENTION_PREFIXES, MENTION_PREVIEW_SANITIZE_REGEX } from '../../../mentions';
import type { AgentsMentionsEditorHandle } from '../../../mentions/agents-mentions-editor';
import { utf8ToBase64 } from '../utils';

/**
 * Generate a unique queue item ID
 */
function generateQueueId() {
  return `queue-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Create a queue item
 */
function createQueueItem(
  id: string,
  message: string,
): import('../../../lib/queue-utils').AgentQueueItem {
  return {
    id,
    status: 'pending' as const,
    message,
    timestamp: new Date(),
  };
}

import type { AgentQueueItem } from '../../../lib/queue-utils';
import type { Message } from '../../../stores/message-store';

type QuickCommentState = {
  selectedText: string;
  source: TextSelectionSource;
  rect: DOMRect;
};

type UseQuickCommentParams = {
  editorRef: RefObject<AgentsMentionsEditorHandle | null>;
  subChatId: string;
  projectPath: string | undefined;
  isStreamingRef: RefObject<boolean>;
  sendMessageRef: RefObject<(message: Message) => void>;
  addToQueue: (subChatId: string, item: AgentQueueItem) => void;
  isResolvedExecutionAccountReady: boolean;
};

/**
 * Hook to manage quick comment functionality
 * Handles quick comment trigger, submission, and cancellation
 */
export const useQuickComment = ({
  editorRef,
  subChatId,
  projectPath,
  isStreamingRef,
  sendMessageRef,
  addToQueue,
  isResolvedExecutionAccountReady,
}: UseQuickCommentParams) => {
  // Blocks sends after unmount; set in setup too, as a hot update re-runs cleanup then setup.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Quick comment state
  const [quickCommentState, setQuickCommentState] = useState<QuickCommentState | null>(null);

  // Handler for quick comment trigger from popover
  const handleQuickComment = useCallback(
    (text: string, source: TextSelectionSource, rect: DOMRect) => {
      setQuickCommentState({ selectedText: text, source, rect });
    },
    [],
  );

  // Handler for quick comment submission
  const handleQuickCommentSubmit = useCallback(
    async (comment: string, selectedText: string, source: TextSelectionSource) => {
      // Snapshot the send function BEFORE any async work to prevent stale ref reads.
      // If the component re-renders with a new useChat instance during the await,
      // sendMessageRef.current may point to the new instance.
      const snapshotSendMessage = sendMessageRef.current;

      // Expand custom slash commands before sending. Lookup failures resolve to the
      // original text inside expandSlashCommand, so no caller-side fallback is needed.
      const expandedComment = await expandSlashCommand(comment, projectPath, commandFetcher);

      // After the async gap, bail out if this component unmounted
      if (!isMountedRef.current) {
        return;
      }

      // Format message with mention token + comment
      const preview = selectedText.slice(0, 50).replace(MENTION_PREVIEW_SANITIZE_REGEX, '');
      const encodedText = utf8ToBase64(selectedText);

      let mentionToken: string;
      if (source.type === 'diff') {
        const lineNum = source.lineNumber || 0;
        mentionToken = `@[${MENTION_PREFIXES.DIFF}${source.filePath}:${lineNum}:${preview}:${encodedText}]`;
      } else if (source.type === 'tool-edit') {
        // Tool edit is treated as code/diff context
        mentionToken = `@[${MENTION_PREFIXES.DIFF}${source.filePath}:0:${preview}:${encodedText}]`;
      } else {
        mentionToken = `@[${MENTION_PREFIXES.QUOTE}${preview}:${encodedText}]`;
      }

      const message = `${mentionToken} ${expandedComment}`;

      // While a turn runs (here or only in main), queue instead of sending directly
      if (isRunBusy(subChatId, isStreamingRef.current)) {
        const item = createQueueItem(generateQueueId(), message);
        addToQueue(subChatId, item);
        toast.success('Reply queued', {
          description: 'Will be sent when current response completes',
        });
      } else {
        // Send directly
        if (!isResolvedExecutionAccountReady) {
          toast.error('Account settings are still loading', {
            description: 'Try again in a moment.',
          });
        } else if (snapshotSendMessage) {
          (
            snapshotSendMessage as (
              message: import('../../../stores/message-store').Message,
            ) => void
          )({
            id: generateQueueId(),
            role: 'user',
            parts: [{ type: 'text', text: message }],
          });
          toast.success('Reply sent');
        }
      }

      // Close quick comment input
      setQuickCommentState(null);
      // Focus chat input
      editorRef.current?.focus();
    },
    [
      subChatId,
      projectPath,
      isStreamingRef,
      sendMessageRef,
      addToQueue,
      editorRef,
      isResolvedExecutionAccountReady,
    ],
  );

  // Handler for quick comment cancellation
  const handleQuickCommentCancel = useCallback(() => {
    setQuickCommentState(null);
  }, []);

  // Focus handler for text selection popover - focus chat input after adding to context
  const handleFocusInput = useCallback(() => {
    editorRef.current?.focus();
  }, [editorRef]);

  return {
    quickCommentState,
    handleQuickComment,
    handleQuickCommentSubmit,
    handleQuickCommentCancel,
    handleFocusInput,
  };
};
