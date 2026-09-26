/**
 * Constants for active chat component
 */

export const STRINGS = {
  // Toast messages
  RENAME_CHAT_NOT_FOUND: 'Send a message first before renaming this chat',
  RENAME_CHAT_FAILED: 'Failed to rename chat',
  SUB_CHAT_NOT_FOUND_WARNING: 'Sub-chat not found in DB, keeping local mode state',
  UPDATE_MODE_ERROR_PREFIX: 'Failed to update sub-chat mode:',
  FAILED_TO_ROLLBACK: 'Failed to rollback',
  QUESTION_ANSWER_RETRY: 'Answer not sent. The question is still active; please try again.',
  QUESTION_SKIP_RETRY: 'Skip not sent. The question is still active; please try again.',

  // Accessibility labels
  SCROLL_TO_BOTTOM: 'Scroll to bottom',
  COPY_MESSAGE: 'Copy',
  ROLLBACK: 'Rollback',
  EXPAND_STEPS: 'Expand',
  COLLAPSE_STEPS: 'Collapse',
  PREVIEW_NOT_AVAILABLE: 'Preview not available',

  // UI text
  SET_UP_REPOSITORY_FOR_PREVIEW: 'Set up this repository to enable live preview',
  NEW_CHAT: 'New Chat',

  // Step counts
  STEP_COUNT: (count: number) => `${count} ${count === 1 ? 'step' : 'steps'}`,
} as const;
