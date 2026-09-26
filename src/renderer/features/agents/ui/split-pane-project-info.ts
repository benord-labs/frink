import { normalizePathForComparison } from '../../files-sidebar/utils/resolve-effective-project-path';

type PaneProjectInfo = { path: string; isWorktree?: boolean };
type SplitPaneChatInfo = { projectId?: string | null; worktreePath?: string | null };

export function buildSplitPaneProjectInfo(params: {
  isSplitActive: boolean;
  chatIds: Array<string | null>;
  newChatPaneId: string;
  agentChatsById: Map<string, SplitPaneChatInfo>;
  resolveLocalProject: (projectId: string) => PaneProjectInfo | undefined;
}): Map<string, PaneProjectInfo> {
  const { isSplitActive, chatIds, newChatPaneId, agentChatsById, resolveLocalProject } = params;
  if (!isSplitActive || agentChatsById.size === 0) return new Map<string, PaneProjectInfo>();

  const map = new Map<string, PaneProjectInfo>();
  for (const chatId of chatIds) {
    if (!chatId || chatId === newChatPaneId) continue;
    const chat = agentChatsById.get(chatId);
    const localProject = chat?.projectId ? resolveLocalProject(chat.projectId) : undefined;
    const normalizedWorktree = normalizePathForComparison(chat?.worktreePath);
    const normalizedProject = normalizePathForComparison(localProject?.path);
    const isRealWorktree = Boolean(
      chat?.worktreePath &&
      !(normalizedWorktree && normalizedProject && normalizedWorktree === normalizedProject),
    );
    if (chat?.worktreePath && isRealWorktree) {
      map.set(chatId, { path: chat.worktreePath, isWorktree: true });
      continue;
    }
    if (!chat?.projectId) continue;
    const project = localProject;
    if (project) {
      map.set(chatId, project);
    }
  }
  return map;
}

export function resolvePaneProjectInfoForChat(params: {
  isRealChat: boolean;
  isNewChat: boolean;
  chatId: string | null;
  splitPaneCount: number;
  paneProjectInfo: Map<string, PaneProjectInfo>;
  selectedProjectFallback?: PaneProjectInfo;
  newChatPaneProject?: PaneProjectInfo;
}): PaneProjectInfo | undefined {
  const {
    isRealChat,
    isNewChat,
    chatId,
    splitPaneCount,
    paneProjectInfo,
    selectedProjectFallback,
    newChatPaneProject,
  } = params;

  if (isRealChat && chatId) {
    return (
      paneProjectInfo.get(chatId) ??
      // Prevent cross-pane contamination in 2+ split panes.
      (splitPaneCount < 2 ? selectedProjectFallback : undefined)
    );
  }
  if (isNewChat) {
    return newChatPaneProject ?? selectedProjectFallback;
  }
  return undefined;
}
