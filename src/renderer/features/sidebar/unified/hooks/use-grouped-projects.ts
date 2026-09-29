/**
 * Hook to group projects by git_remote (codebase)
 * Transforms flat project/chat lists into hierarchical structure
 */

import { useAtomValue } from 'jotai';
import { useMemo } from 'react';
import { groupByCodebase } from '../../../../../shared/lib/project-codebase';
import { heldChatIdsAtom } from '../../../../lib/stores/active-transport-registry';
import type { ChatItem, CodebaseGroup } from '../types';

type ProjectInput = {
  id: string;
  name: string;
  path: string;
  gitRemoteUrl: string | null;
  gitOwner: string | null;
  gitRepo: string | null;
};

type ChatInput = {
  id: string;
  name: string | null;
  branch: string | null;
  updatedAt: Date | null;
  pinnedAt: Date | null;
  projectId: string | null;
  worktreePath: string | null;
  taskId: string | null;
  batchId: string | null;
};

type UseGroupedProjectsParams = {
  projects: ProjectInput[];
  chats: ChatInput[];
  unseenChanges: Set<string>;
  loadingChats: Set<string>;
  pendingPlans: Set<string>;
  pendingQuestions: Set<string>;
};

export function useGroupedProjects({
  projects,
  chats,
  unseenChanges,
  loadingChats,
  pendingPlans,
  pendingQuestions,
}: UseGroupedProjectsParams): CodebaseGroup[] {
  const heldChats = useAtomValue(heldChatIdsAtom);
  return useMemo(() => {
    // Guard against undefined/non-array values during initial render
    if (!Array.isArray(chats) || !Array.isArray(projects)) {
      return [];
    }

    // worktree_path == project path means no worktree; differs means actual worktree
    const projectPathById = new Map(projects.map((p) => [p.id, p.path]));

    // Build chat lookup by projectId AND collect general chats
    const chatsByProject = new Map<string, ChatItem[]>();
    const generalChats: ChatItem[] = [];
    for (const chat of chats) {
      const projectPath = chat.projectId ? projectPathById.get(chat.projectId) : undefined;
      const chatItem: ChatItem = {
        id: chat.id,
        name: chat.name,
        branch: chat.branch,
        updatedAt: chat.updatedAt,
        pinnedAt: chat.pinnedAt,
        projectId: chat.projectId,
        hasUnseenChanges: unseenChanges.has(chat.id),
        isLoading: loadingChats.has(chat.id),
        hasPendingPlan: pendingPlans.has(chat.id),
        hasPendingQuestion: pendingQuestions.has(chat.id),
        isHeld: heldChats.has(chat.id),
        isWorktree: !!chat.worktreePath && chat.worktreePath !== projectPath,
        taskId: chat.taskId,
        batchId: chat.batchId,
      };

      // Collect general chats (no project) separately
      if (!chat.projectId) {
        generalChats.push(chatItem);
        continue;
      }
      const projectChats = chatsByProject.get(chat.projectId) ?? [];
      projectChats.push(chatItem);
      chatsByProject.set(chat.projectId, projectChats);
    }

    // Group projects by git_remote (or path if no remote)
    const result: CodebaseGroup[] = [];
    const groupedProjects = groupByCodebase(
      projects,
      (project) => project.gitRemoteUrl,
      (project) => project.path,
    );

    for (const grouped of groupedProjects.values()) {
      if (grouped.length === 0) continue;
      const representative = grouped[0];
      result.push({
        gitRemote: representative.gitRemoteUrl,
        displayName: representative.gitRepo ?? representative.name,
        gitOwner: representative.gitOwner,
        gitRepo: representative.gitRepo,
        projects: grouped.map((project) => ({
          id: project.id,
          name: project.name,
          path: project.path,
          gitRemote: project.gitRemoteUrl,
          gitOwner: project.gitOwner,
          gitRepo: project.gitRepo,
        })),
        chats: grouped.flatMap((project) => chatsByProject.get(project.id) ?? []),
      });
    }

    result.sort((a, b) => a.displayName.localeCompare(b.displayName));

    // Add "General Chats" group if there are any chats without a project
    if (generalChats.length > 0) {
      result.push({
        gitRemote: null,
        displayName: 'General Chats',
        gitOwner: null,
        gitRepo: null,
        projects: [],
        chats: generalChats,
      });
    }

    return result;
  }, [projects, chats, unseenChanges, loadingChats, pendingPlans, pendingQuestions, heldChats]);
}
