// @vitest-environment happy-dom
import { act, cleanup, waitFor } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newTestQueryClient, renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { useTreeProjects } from './use-tree-projects';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const app = { id: 'app', name: 'app', path: '/w/app' };
const PROJECTS = [
  app,
  { id: 'api', name: 'api', path: '/w/api' },
  { id: 'web', name: 'web', path: '/w/web' },
  { id: 'docs', name: 'docs', path: '/w/docs' },
  { id: 'notes', name: 'Notes', path: 'virtual://notes' },
  { id: 'disk', name: 'disk', path: '/' },
  // A drive root overlaps no POSIX folder, so only the root check keeps it out.
  { id: 'drive', name: 'C:', path: 'C:\\' },
  { id: 'inner', name: 'inner', path: '/w/app/packages/inner' },
  { id: 'outer', name: 'outer', path: '/w' },
  // The worktree chat's own folder, registered as a project of its own.
  { id: 'wt', name: 'wt', path: '/wt/app-1' },
];
const chat = (project: object | null, worktreePath: string | null = null) => ({
  worktreePath,
  branch: worktreePath && 'feat',
  project,
});
// Any other id, such as a new-chat pane's 'empty-0', is unknown to chats.get.
const CHATS: Record<string, ReturnType<typeof chat>> = {
  worktree: chat(app, '/wt/app-1'),
  plain: chat(app),
  // Just moved into app; the list the server gave before still offers app.
  moved: chat(app),
  unversioned: chat(app, '/wt/copy'),
  general: chat(null),
  virtual: chat({ id: 'ideas', name: 'Ideas', path: 'virtual://ideas' }),
};
// The branch each folder has checked out now; any other folder is not a git repository.
const CHECKED_OUT: Record<string, string> = { '/wt/app-1': 'feat-moved', '/w/app': 'main' };
/** The projects the server would link to each chat, before leaving out those already linked.
 *  It refuses web and docs to the plain chat, as for a folder gone or one holding home. */
const LINKABLE: Record<string, string[]> = {
  worktree: ['api', 'web', 'docs'],
  plain: ['wt', 'api'],
  moved: ['app', 'api'],
};
let listState: 'ready' | 'pending' | 'error' = 'ready';
/** Each chat's linked project ids, as the database holds them; `missing` ones are gone from disk */
let links: Record<string, string[]> = {};
let missing: string[] = [];
let holdChats = false;
const linkedRow = (id: string) => ({
  ...PROJECTS.find((project) => project.id === id)!,
  missing: missing.includes(id),
});

async function answer(op: Operation): Promise<unknown> {
  const { id, chatId = '', projectId = '' } = (op.input ?? {}) as Record<string, string>;
  if (op.path === 'chats.get') {
    if (id === 'loading' || holdChats) return new Promise(() => {});
    return CHATS[id] ? { ...CHATS[id], linkedProjects: (links[id] ?? []).map(linkedRow) } : null;
  }
  if (op.path === 'chats.linkProject') {
    if (projectId === 'api') throw new Error("api's folder can't be found.");
    links[chatId] = [...(links[chatId] ?? []), projectId];
    return { success: true };
  }
  if (op.path === 'chats.unlinkProject') {
    if (projectId === 'api') throw new Error('database closed');
    links[chatId] = (links[chatId] ?? []).filter((each) => each !== projectId);
    return { success: true };
  }
  if (op.path === 'changes.getBranches') {
    const current = CHECKED_OUT[(op.input as { worktreePath: string }).worktreePath];
    if (!current) throw new Error('not a git repository');
    return { current };
  }
  if (op.path === 'chats.linkableProjects') {
    return (LINKABLE[chatId] ?? []).filter((each) => !(links[chatId] ?? []).includes(each));
  }
  if (op.path === 'projects.list') {
    if (listState === 'pending') return new Promise(() => {});
    if (listState === 'error') throw new Error('database is locked');
    return PROJECTS;
  }
  throw new Error(`Unexpected test operation: ${op.path}`);
}

type TreeProjects = ReturnType<typeof useTreeProjects>;

type ProbeProps = { chatId: string; seen: Map<string, TreeProjects>; withCandidates: boolean };

function Probe({ chatId, seen, withCandidates }: ProbeProps) {
  seen.set(chatId, useTreeProjects(chatId, { withCandidates }));
  return null;
}

/** Renders the hook for each chat, recording the operations it asks for. */
function renderTrees(
  chatIds: string[],
  { withCandidates = true, queryClient = newTestQueryClient() } = {},
) {
  const seen = new Map<string, TreeProjects>();
  const asked = vi.fn(answer);
  renderWithTrpc(
    <>
      {chatIds.map((chatId) => (
        <Probe key={chatId} chatId={chatId} seen={seen} withCandidates={withCandidates} />
      ))}
    </>,
    asked,
    queryClient,
  );
  return {
    tree: (chatId = chatIds[0]) => seen.get(chatId)!,
    asked: (path: string) =>
      asked.mock.calls.filter(([op]) => op.path === path).map(([op]) => op.input),
  };
}

const idsOf = (projects: Array<{ id: string }>) => projects.map((project) => project.id);

afterEach(() => {
  cleanup();
  listState = 'ready';
  links = {};
  missing = [];
  holdChats = false;
  CHATS.plain = chat(app);
});

describe('useTreeProjects', () => {
  it.each([
    ['no chat at all', '', true],
    ['a new-chat pane', 'empty-0', true],
    ['a general chat', 'general', true],
    ['a virtual folder chat', 'virtual', true],
    ['a chat still loading', 'loading', false],
  ])('has no main project and links nothing for %s', async (_, chatId, isLoaded) => {
    // The worktree chat lists projects only after both chats load, so this chat has loaded by then.
    const { tree, asked } = renderTrees([chatId, 'worktree']);
    await waitFor(() => expect(tree('worktree').candidates).not.toHaveLength(0));

    act(() => tree().add('web'));

    expect(tree()).toMatchObject({ main: null, canAdd: false, extras: [], candidates: [] });
    expect(tree().isLoaded).toBe(isLoaded);
    expect(asked('chats.linkProject')).toEqual([]);
  });

  it("shows the chat's links in link order, missing ones too, and offers the other projects", async () => {
    links = { worktree: ['web', 'api'] };
    missing = ['api'];
    const { tree } = renderTrees(['worktree']);

    await waitFor(() => expect(idsOf(tree().candidates)).toEqual(['docs']));
    expect(tree().extras).toEqual([
      { id: 'web', name: 'web', path: '/w/web', missing: false },
      { id: 'api', name: 'api', path: '/w/api', missing: true },
    ]);
    // Every surface that reads or searches the links skips a missing folder alike.
    expect(idsOf(tree().readable)).toEqual(['web']);
    expect(tree()).toMatchObject({ canAdd: true, projectsStatus: 'success', isLoaded: true });
  });

  // The server alone decides, by real path and what is on disk, so none it refuses is offered.
  it('offers only the projects the server would link, in the project list order', async () => {
    const { tree, asked } = renderTrees(['plain']);

    await waitFor(() => expect(idsOf(tree().candidates)).toEqual(['api', 'wt']));
    expect(asked('chats.linkableProjects')).toEqual([
      { chatId: 'plain', mainProjectId: 'app', workingPath: '/w/app' },
    ]);
  });

  // The server checks each project's folder on disk to answer, so only a picker or notice asks.
  it('asks what the chat can link only for a surface that offers links', async () => {
    links = { plain: ['api'] };
    const { tree, asked } = renderTrees(['plain'], { withCandidates: false });

    await waitFor(() => expect(idsOf(tree().extras)).toEqual(['api']));
    // Read in the same render as what the chat can link would be.
    await waitFor(() => expect(asked('projects.list')).toHaveLength(1));
    expect(tree().candidates).toEqual([]);
    expect(asked('chats.linkableProjects')).toEqual([]);
  });

  it("asks again once a worktree switch changes the chat's folder", async () => {
    const queryClient = newTestQueryClient();
    const { tree, asked } = renderTrees(['plain'], { queryClient });
    await waitFor(() => expect(asked('chats.linkableProjects')).toHaveLength(1));

    CHATS.plain = chat(app, '/wt/app-1');
    await act(() => queryClient.invalidateQueries({ queryKey: [['chats', 'get']] }));

    await waitFor(() => expect(tree().main?.workingPath).toBe('/wt/app-1'));
    await waitFor(() =>
      expect(asked('chats.linkableProjects').at(-1)).toEqual({
        chatId: 'plain',
        mainProjectId: 'app',
        workingPath: '/wt/app-1',
      }),
    );
  });

  it("never offers the chat's own project, even from a list read before the chat moved into it", async () => {
    const { tree } = renderTrees(['moved']);

    await waitFor(() => expect(idsOf(tree().candidates)).toEqual(['api']));
  });

  it.each([
    [
      'the branch a worktree has checked out now over the stored one',
      'worktree',
      '/wt/app-1',
      'feat-moved',
    ],
    ['the branch checked out in a chat that stores none', 'plain', '/w/app', 'main'],
    [
      'the stored branch when the folder is not a git repository',
      'unversioned',
      '/wt/copy',
      'feat',
    ],
  ])('gives the main project %s', async (_, chatId, workingPath, branch) => {
    const { tree } = renderTrees([chatId]);

    await waitFor(() => expect(tree().main).toEqual({ ...app, workingPath, branch }));
  });

  it('links a project, showing it before the chat is read again', async () => {
    links = { worktree: ['web'] };
    const { tree, asked } = renderTrees(['worktree']);
    await waitFor(() => expect(idsOf(tree().candidates)).toEqual(['api', 'docs']));
    holdChats = true;

    act(() => tree().add('docs'));

    await waitFor(() => expect(idsOf(tree().extras)).toEqual(['web', 'docs']));
    expect(asked('chats.linkProject')).toEqual([{ chatId: 'worktree', projectId: 'docs' }]);
    expect(idsOf(tree().candidates)).toEqual(['api']);
    // What it can link is read again too, whatever else its list was keyed by.
    await waitFor(() => expect(asked('chats.linkableProjects')).toHaveLength(2));
    // Still pending: it waits for the chat to be read again.
    expect(tree().isPending).toBe(true);
  });

  it('unlinks a project, dropping it before the chat is read again', async () => {
    links = { worktree: ['web', 'docs'] };
    const { tree, asked } = renderTrees(['worktree']);
    await waitFor(() => expect(tree().extras).toHaveLength(2));
    holdChats = true;

    act(() => tree().remove('web'));

    await waitFor(() => expect(idsOf(tree().extras)).toEqual(['docs']));
    expect(asked('chats.unlinkProject')).toEqual([{ chatId: 'worktree', projectId: 'web' }]);
    // Still pending: it waits for the chat to be read again.
    expect(tree().isPending).toBe(true);
  });

  it('says why an unlink failed, tells the caller and keeps the link', async () => {
    links = { worktree: ['web', 'api'] };
    const toasts = toast.getHistory().length;
    const onError = vi.fn();
    const { tree } = renderTrees(['worktree']);
    await waitFor(() => expect(tree().extras).toHaveLength(2));

    act(() => tree().remove('api', { onError }));

    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(toast.getHistory().at(-1)).toMatchObject({ type: 'error', title: 'database closed' });
    expect(toast.getHistory()).toHaveLength(toasts + 1);
    expect(idsOf(tree().extras)).toEqual(['web', 'api']);
  });

  it('says why a link was refused and leaves the links as they were', async () => {
    links = { worktree: ['web'] };
    const toasts = toast.getHistory().length;
    const { tree } = renderTrees(['worktree']);
    await waitFor(() => expect(tree().candidates).toHaveLength(2));

    act(() => tree().add('api'));

    await waitFor(() => expect(toast.getHistory()).toHaveLength(toasts + 1));
    expect(toast.getHistory().at(-1)).toMatchObject({
      type: 'error',
      title: "api's folder can't be found.",
    });
    expect(idsOf(tree().extras)).toEqual(['web']);
  });

  it.each([
    ['loads', 'pending'],
    ['fails to load', 'error'],
  ] as const)(
    "shows the chat's links but offers none while the project list %s",
    async (_, state) => {
      listState = state;
      links = { plain: ['api'] };
      const { tree } = renderTrees(['plain']);

      await waitFor(() => expect(idsOf(tree().extras)).toEqual(['api']));
      await waitFor(() => expect(tree().projectsStatus).toBe(state));
      expect(tree()).toMatchObject({ candidates: [], canAdd: true, isLoaded: true });
    },
  );
});
