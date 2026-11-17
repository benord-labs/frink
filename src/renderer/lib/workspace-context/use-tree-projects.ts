/**
 * The projects in a chat's file tree: the chat's own project and the projects linked to it.
 * Every surface that shows or searches those projects reads them from here.
 */
import { toast } from 'sonner';
import { isRootLikePath } from '../../../shared/lib/path-normalization';
import { trpc } from '@/lib/trpc';
import { isRealProjectPath, pathsOverlap } from './project-paths';

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
  /** Each with `missing` set when its folder is gone */
  linkedProjects?: Array<TreeProject & { missing: boolean }>;
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

const treeChat = (chat: TreeChat) => ({
  main: mainTreeProject(chat),
  linked: (chat?.linkedProjects ?? []).map(({ id, name, path, missing }) => ({
    id,
    name,
    path,
    missing,
  })),
});

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

/** Shows a link change at once, then reads the chat again, as a worktree switch does. */
function useLinkMutations() {
  const utils = trpc.useUtils();
  type Linked = NonNullable<ReturnType<typeof utils.chats.get.getData>>['linkedProjects'];
  const settle = (chatId: string, change: (linked: Linked) => Linked) => {
    utils.chats.get.setData({ id: chatId }, (old) =>
      old ? { ...old, linkedProjects: change(old.linkedProjects) } : old,
    );
    return utils.chats.get.invalidate({ id: chatId });
  };
  const onError = (error: { message: string }) => toast.error(error.message);
  const link = trpc.chats.linkProject.useMutation({
    onSuccess: (_, { chatId, projectId }) => {
      const project = utils.projects.list.getData()?.find((each) => each.id === projectId);
      // Its git provider comes with the read right after; nothing here shows it.
      const entry = project && { ...project, gitProvider: null, missing: false };
      return settle(chatId, (linked) =>
        entry && !linked.some((each) => each.id === projectId) ? [...linked, entry] : linked,
      );
    },
    onError,
  });
  const unlink = trpc.chats.unlinkProject.useMutation({
    onSuccess: (_, { chatId, projectId }) =>
      settle(chatId, (linked) => linked.filter((each) => each.id !== projectId)),
    onError,
  });
  return { link, unlink };
}

/**
 * The chat's tree projects. `extras` are the chat's linked projects in the order they were
 * linked, each `missing` when its folder is gone. `candidates` are the projects that can still be
 * linked, and `projectsStatus` tells a list still loading or failed apart from an empty one. Only
 * a chat with a project folder of its own can link any (`canAdd`). `add` and `remove` link and
 * unlink, and a refusal shows as a toast; `remove` also tells its caller through `onError`.
 * `isPending` is true while either is on its way.
 */
export function useTreeProjects(chatId: string | null | undefined) {
  const key = chatId ?? '';
  const { link, unlink } = useLinkMutations();
  const chatQuery = trpc.chats.get.useQuery(
    { id: key },
    { enabled: Boolean(chatId), select: treeChat },
  );
  const chatProject = chatQuery.data?.main ?? null;
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
  const extras = chatQuery.data?.linked ?? [];
  const candidates = main
    ? projects.filter(
        (project) =>
          canSitBeside(project, main) && !extras.some((extra) => extra.id === project.id),
      )
    : [];

  return {
    main,
    extras,
    candidates,
    projectsStatus: projectsQuery.status,
    /** Whether `main` and `extras` are final: there is no chat, or it has loaded. */
    isLoaded: !chatId || chatQuery.status !== 'pending',
    canAdd: Boolean(main),
    isPending: link.isPending || unlink.isPending,
    add: (projectId: string) => {
      if (main) link.mutate({ chatId: key, projectId });
    },
    remove: (projectId: string, options?: { onError?: () => void }) =>
      unlink.mutate({ chatId: key, projectId }, options),
  };
}

export type TreeProjects = ReturnType<typeof useTreeProjects>;
