/**
 * The projects in a chat's file tree: the chat's own project and the projects linked to it.
 * Every surface that shows or searches those projects reads them from here.
 */
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { isRealProjectPath } from './project-paths';

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

type Status = 'pending' | 'error' | 'success';

/** One status for lists read together: failed if either failed, else loading if either is. */
const bothStatus = (a: Status, b: Status): Status =>
  a === 'error' || b === 'error' ? 'error' : a === 'pending' || b === 'pending' ? 'pending' : a;

/** Shows a link change at once, then reads the chat, and what it can link, again, as a worktree
 *  switch does. */
function useLinkMutations() {
  const utils = trpc.useUtils();
  type Linked = NonNullable<ReturnType<typeof utils.chats.get.getData>>['linkedProjects'];
  const settle = (chatId: string, change: (linked: Linked) => Linked) => {
    utils.chats.get.setData({ id: chatId }, (old) =>
      old ? { ...old, linkedProjects: change(old.linkedProjects) } : old,
    );
    void utils.chats.linkableProjects.invalidate({ chatId });
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
 * The chat's tree projects. `linked` are the chat's linked projects in the order they were
 * linked, each `missing` when its folder is gone, and `readable` those whose folder is there.
 * With `withCandidates`, `candidates` are the projects the server would link now, and
 * `projectsStatus` tells a list still loading or failed apart from an empty one; the server checks
 * each project's folder on disk to answer, so only a surface that offers links asks. Only a chat
 * with a project folder of its own (`main`) can link any. `link` and `unlink` do so, and a refusal
 * shows as a toast; `unlink` also tells its caller through `onError`.
 * `isPending` is true while either is on its way.
 */
export function useTreeProjects(
  chatId: string | null | undefined,
  { withCandidates = false }: { withCandidates?: boolean } = {},
) {
  const key = chatId ?? '';
  const mutations = useLinkMutations();
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
  // The answer turns on the chat's own project and folder, so a move or worktree switch asks again.
  // Links, unlinks, a broadcast and the picker opening read it again too, hence the long staleTime.
  const linkableQuery = trpc.chats.linkableProjects.useQuery(
    { chatId: key, mainProjectId: main?.id, workingPath: main?.workingPath },
    { enabled: withCandidates && Boolean(main), staleTime: 300_000 },
  );
  const projects = projectsQuery.data ?? [];
  const linked = chatQuery.data?.linked ?? [];
  const linkable = main ? (linkableQuery.data ?? []) : [];
  // A link shows here before the server's list is read again, and the chat's own project never
  // shows, even in a list read before the chat moved into it.
  const candidates = projects.filter(
    (project) =>
      project.id !== main?.id &&
      linkable.includes(project.id) &&
      !linked.some((each) => each.id === project.id),
  );

  return {
    main,
    linked,
    readable: linked.filter((project) => !project.missing),
    candidates,
    projectsStatus: bothStatus(projectsQuery.status, linkableQuery.status),
    /** Whether `main` and `linked` are final: there is no chat, or it has loaded. */
    isLoaded: !chatId || chatQuery.status !== 'pending',
    isPending: mutations.link.isPending || mutations.unlink.isPending,
    link: (projectId: string) => {
      if (main) mutations.link.mutate({ chatId: key, projectId });
    },
    unlink: (projectId: string, options?: { onError?: () => void }) =>
      mutations.unlink.mutate({ chatId: key, projectId }, options),
  };
}

export type TreeProjects = ReturnType<typeof useTreeProjects>;
