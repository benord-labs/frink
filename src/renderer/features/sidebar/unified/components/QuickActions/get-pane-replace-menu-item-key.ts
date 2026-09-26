/**
 * React key for "Replace pane" dropdown rows. When `paneChatId` is null, include
 * `paneIndex` so multiple empty panes never share the same key.
 */
export function getPaneReplaceMenuItemKey(
  paneChatId: string | null | undefined,
  paneIndex: number,
): string {
  return paneChatId != null ? `replace-pane-${paneChatId}` : `replace-pane-empty-${paneIndex}`;
}
