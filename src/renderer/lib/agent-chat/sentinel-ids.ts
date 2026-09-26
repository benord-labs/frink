const SENTINEL_PREFIX = '__new_chat';

/**
 * Builds a per-pane sentinel chatId for terminal/sidebar state when no real chat exists yet.
 * Keyed by pane index so two new-chat panes in split view don't share the same terminal.
 */
export function newChatTerminalId(paneIndex?: number): string {
  return paneIndex !== undefined ? `${SENTINEL_PREFIX}_${paneIndex}__` : `${SENTINEL_PREFIX}__`;
}
