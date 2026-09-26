type IsStaleSelectionArgs = {
  chatId: string;
  isLoading: boolean;
  chatExists: boolean;
};

/**
 * Returns true when a persisted selectedChatId points to a chat that the server
 * confirmed does not exist (query finished, returned null).
 *
 * Used inside ChatView's useEffect to auto-clear stale localStorage selections,
 * preventing the infinite "Loading messages..." screen for new users or after
 * chat deletion.
 */
export function isStaleSelection({ chatId, isLoading, chatExists }: IsStaleSelectionArgs): boolean {
  if (!chatId) return false;
  if (isLoading) return false;
  return !chatExists;
}
