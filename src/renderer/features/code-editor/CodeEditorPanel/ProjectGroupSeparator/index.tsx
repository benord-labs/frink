import { memo } from 'react';
import { isSameFolder } from '../../../../../shared/lib/path-normalization';
import { trpc } from '@/lib/trpc';

type ProjectGroupSeparatorProps = {
  /** The folder the group's tabs are from; none for the "Files" group. */
  projectPath: string | undefined;
  /** The chat whose worktree the tabs are from, when they are a worktree chat's. */
  worktreeChatId: string | undefined;
  /** The folder's own name, shown when no project name is known. */
  folderName: string;
};

/** The name the chat's project goes by. */
function chatProjectName(chat: { project: { name: string } | null } | null): string | undefined {
  return chat?.project?.name;
}

/**
 * Separator before a project's tabs in the tab bar, named as the project is registered. A worktree
 * chat's tabs take the name of that chat's project, since no project is registered at a worktree.
 */
export const ProjectGroupSeparator = memo(function ProjectGroupSeparator({
  projectPath,
  worktreeChatId,
  folderName,
}: ProjectGroupSeparatorProps) {
  const { data: rawProjects } = trpc.projects.list.useQuery(undefined, {
    enabled: Boolean(projectPath),
    staleTime: 300_000,
  });
  // Guards: during tRPC client hydration on dev start (~1-2% of the time), data can
  // briefly be a non-undefined non-array value. See commit a6d57596.
  const registered = Array.isArray(rawProjects)
    ? rawProjects.find((project) => isSameFolder(project.path, projectPath))
    : undefined;
  const chatId = projectPath ? worktreeChatId : undefined;
  // The chat view keeps the chat fresh.
  const chatProject = trpc.chats.get.useQuery(
    { id: chatId ?? '' },
    { enabled: Boolean(chatId) && !registered, staleTime: Infinity, select: chatProjectName },
  ).data;

  // Full-strength muted text: the label is what tells one project's tabs from another's, and a
  // faded one at this size falls below AA contrast.
  return (
    <div className="flex items-center px-2 py-1.5 text-[10px] text-muted-foreground font-medium uppercase tracking-wider select-none shrink-0 border-r border-border/30">
      {registered?.name ?? chatProject ?? folderName}
    </div>
  );
});
