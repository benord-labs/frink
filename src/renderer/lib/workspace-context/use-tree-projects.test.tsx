// @vitest-environment happy-dom
import { act, cleanup, waitFor } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { chatTreeProjectIdsAtomFamily } from './tree-projects';
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
const CHATS: Record<string, unknown> = {
  worktree: chat(app, '/wt/app-1'),
  plain: chat(app),
  unversioned: chat(app, '/wt/copy'),
  general: chat(null),
  virtual: chat({ id: 'ideas', name: 'Ideas', path: 'virtual://ideas' }),
};
// The branch each folder has checked out now; any other folder is not a git repository.
const CHECKED_OUT: Record<string, string> = { '/wt/app-1': 'feat-moved', '/w/app': 'main' };
let listState: 'ready' | 'pending' | 'error' = 'ready';

async function answer(op: Operation): Promise<unknown> {
  if (op.path === 'chats.get') {
    const { id } = op.input as { id: string };
    return id === 'loading' ? new Promise(() => {}) : (CHATS[id] ?? null);
  }
  if (op.path === 'changes.getBranches') {
    const current = CHECKED_OUT[(op.input as { worktreePath: string }).worktreePath];
    if (!current) throw new Error('not a git repository');
    return { current };
  }
  if (op.path === 'projects.list') {
    if (listState === 'pending') return new Promise(() => {});
    if (listState === 'error') throw new Error('database is locked');
    return PROJECTS;
  }
  throw new Error(`Unexpected test operation: ${op.path}`);
}

type TreeProjects = ReturnType<typeof useTreeProjects>;

function Probe({ chatId, seen }: { chatId: string; seen: Map<string, TreeProjects> }) {
  seen.set(chatId, useTreeProjects(chatId));
  return null;
}

/** Renders the hook for each chat, with `ids` already in the first chat's tree. */
function renderTrees(chatIds: string[], ids: string[]) {
  const store = createStore();
  store.set(chatTreeProjectIdsAtomFamily(chatIds[0]), ids);
  const seen = new Map<string, TreeProjects>();
  renderWithTrpc(
    <Provider store={store}>
      {chatIds.map((chatId) => (
        <Probe key={chatId} chatId={chatId} seen={seen} />
      ))}
    </Provider>,
    answer,
  );
  return {
    tree: (chatId = chatIds[0]) => seen.get(chatId)!,
    storedIds: () => store.get(chatTreeProjectIdsAtomFamily(chatIds[0])),
  };
}

const idsOf = (projects: Array<{ id: string }>) => projects.map((project) => project.id);

afterEach(() => {
  cleanup();
  listState = 'ready';
});

describe('useTreeProjects', () => {
  it.each([
    ['no chat at all', '', true],
    ['a new-chat pane', 'empty-0', true],
    ['a general chat', 'general', true],
    ['a virtual folder chat', 'virtual', true],
    ['a chat still loading', 'loading', false],
  ])('has no main project and adds nothing for %s', async (_, chatId, isLoaded) => {
    // The worktree chat lists projects only after both chats load, so this chat has loaded by then.
    const { tree, storedIds } = renderTrees([chatId, 'worktree'], ['api']);
    await waitFor(() => expect(tree('worktree').candidates).not.toHaveLength(0));

    act(() => tree().add('web'));

    expect(tree()).toMatchObject({ main: null, canAdd: false, extras: [], candidates: [] });
    expect(tree().isLoaded).toBe(isLoaded);
    expect(storedIds()).toEqual(['api']);
  });

  it('keeps added projects in order and leaves out deleted, virtual, root and overlapping ones', async () => {
    const { tree } = renderTrees(
      ['worktree'],
      ['web', 'gone', 'notes', 'disk', 'drive', 'inner', 'outer', 'wt', 'api'],
    );

    await waitFor(() => expect(idsOf(tree().extras)).toEqual(['web', 'api']));
    expect(tree().extras[0]).toEqual({ id: 'web', name: 'web', path: '/w/web' });
    expect(idsOf(tree().candidates)).toEqual(['docs']);
    expect(tree()).toMatchObject({ canAdd: true, projectsStatus: 'success', isLoaded: true });
  });

  it("offers a folder that is only some other chat's worktree", async () => {
    const { tree } = renderTrees(['plain'], []);

    await waitFor(() => expect(idsOf(tree().candidates)).toEqual(['api', 'web', 'docs', 'wt']));
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
    const { tree } = renderTrees([chatId], []);

    await waitFor(() => expect(tree().main).toEqual({ ...app, workingPath, branch }));
  });

  it('adds a project to the end of the tree and removes it again', async () => {
    const { tree } = renderTrees(['worktree'], ['web']);
    await waitFor(() => expect(idsOf(tree().candidates)).toEqual(['api', 'docs']));

    act(() => tree().add('docs'));
    expect(idsOf(tree().extras)).toEqual(['web', 'docs']);
    expect(idsOf(tree().candidates)).toEqual(['api']);

    act(() => tree().remove('web'));
    expect(idsOf(tree().extras)).toEqual(['docs']);
  });

  it.each([
    ['loads', 'pending'],
    ['fails to load', 'error'],
  ] as const)('shows no added projects and says so while the project list %s', async (_, state) => {
    listState = state;
    const { tree } = renderTrees(['plain'], ['api']);

    await waitFor(() => expect(tree().main?.workingPath).toBe('/w/app'));
    await waitFor(() => expect(tree().projectsStatus).toBe(state));
    expect(tree()).toMatchObject({ extras: [], candidates: [], canAdd: true });
    // A failed list is final; one still loading may yet hold the chat's extra projects.
    expect(tree().isLoaded).toBe(state === 'error');
  });
});
