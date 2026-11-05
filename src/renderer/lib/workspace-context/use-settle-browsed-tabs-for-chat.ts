/**
 * Settles another project's tabs for the chat single view shows, keeping those of every project in
 * that chat's file tree.
 */
import { useSettleBrowsedTabs } from '@/lib/code-editor/state';
import { useTreeProjects } from './use-tree-projects';

type UseSettleBrowsedTabsForChatInput = {
  /** The chat single view shows */
  chatId: string | null;
  /** That chat once its data has loaded; null or undefined otherwise */
  chat: Parameters<typeof useSettleBrowsedTabs>[0]['chat'];
  isSplitActive: boolean;
};

/**
 * useSettleBrowsedTabs for the chat single view shows, keeping the tabs of the other projects in
 * its file tree. Settling waits until that tree knows its projects, so a tab isn't closed before
 * its project shows up.
 */
export function useSettleBrowsedTabsForChat({
  chatId,
  chat,
  isSplitActive,
}: UseSettleBrowsedTabsForChatInput): void {
  const treeProjects = useTreeProjects(chatId);
  useSettleBrowsedTabs({
    chat: treeProjects.isLoaded ? chat : null,
    isSplitActive,
    keepProjectPaths: treeProjects.extras.map((project) => project.path),
  });
}
