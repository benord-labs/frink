/**
 * The projects in a chat's file tree: the chat's own project and the other projects added to it.
 * Every surface that shows or searches those projects reads them from here.
 */
import { useAtomValue, useSetAtom } from 'jotai';
import { isRootLikePath } from '../../../shared/lib/path-normalization';
import { trpc } from '@/lib/trpc';
import { isRealProjectPath, pathsOverlap } from './project-paths';
import {
  addChatTreeProjectAtom,
  chatTreeProjectIdsAtomFamily,
  removeChatTreeProjectAtom,
} from './tree-projects';

type TreeProject = { id: string; name: string; path: string };

type MainTreeProject = TreeProject & {
  /** The folder the chat works in: its worktree, else the project's folder */
  workingPath: string;
  branch: string | null;
};

type TreeChat = {
  worktreePath: string | null;
  branch: string | null;
  project: TreeProject | null;
} | null;

/** The chat's own project. None for an unknown chat (a new-chat pane), a general chat or a
 *  virtual folder, which have no folder for a tree to sit beside. */
function mainTreeProject(chat: TreeChat): MainTreeProject | null {
  const project = chat?.project;
  if (!project || !isRealProjectPath(project.path)) return null;
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    workingPath: chat.worktreePath ?? project.path,
    branch: chat.branch,
  };
}

const checkedOutBranch = (branches: { current: string }) => branches.current;

/** A project that can sit beside `main` in the tree: a real folder that is not the whole disk and
 *  neither holds nor lies inside the chat's own project or the worktree the chat works in. */
function canSitBeside(project: TreeProject, main: MainTreeProject): boolean {
  return (
    isRealProjectPath(project.path) &&
    !isRootLikePath(project.path) &&
    !pathsOverlap(project.path, main.path) &&
    !pathsOverlap(project.path, main.workingPath)
  );
}

/**
 * The chat's tree projects. `extras` follow the order they were added; a project that was deleted
 * or can't sit beside the chat's own is left out. `candidates` are the projects that can still be
 * added, and `projectsStatus` tells a list still loading or failed apart from an empty one. Only a
 * chat with a project folder of its own can add any (`canAdd`).
 */
export function useTreeProjects(chatId: string | null | undefined) {
  const key = chatId ?? '';
  const ids = useAtomValue(chatTreeProjectIdsAtomFamily(key));
  const addProject = useSetAtom(addChatTreeProjectAtom);
  const removeProject = useSetAtom(removeChatTreeProjectAtom);
  const chatProject =
    trpc.chats.get.useQuery({ id: key }, { enabled: Boolean(chatId), select: mainTreeProject })
      .data ?? null;
  // The branch checked out in the chat's folder now, read as the composer bar reads it. The branch
  // stored with the chat is set only when its worktree is made, so it misses any later checkout.
  const currentBranch = trpc.changes.getBranches.useQuery(
    { worktreePath: chatProject?.workingPath ?? '' },
    { enabled: Boolean(chatProject), staleTime: 60_000, select: checkedOutBranch },
  ).data;
  const main = chatProject && { ...chatProject, branch: currentBranch || chatProject.branch };
  const projectsQuery = trpc.projects.list.useQuery(undefined, {
    enabled: Boolean(main),
    staleTime: 300_000,
  });
  const projects = projectsQuery.data ?? [];

  const eligible = main ? projects.filter((project) => canSitBeside(project, main)) : [];
  const byId = new Map(eligible.map((project) => [project.id, project]));
  const extras = ids.flatMap((id) => {
    const project = byId.get(id);
    return project ? [{ id: project.id, name: project.name, path: project.path }] : [];
  });
  const candidates = eligible.filter((project) => !ids.includes(project.id));

  return {
    main,
    extras,
    candidates,
    projectsStatus: projectsQuery.status,
    canAdd: Boolean(main),
    add: (projectId: string) => {
      if (main) addProject({ chatId: key, projectId });
    },
    remove: (projectId: string) => removeProject({ chatId: key, projectId }),
  };
}
