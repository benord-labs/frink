// @vitest-environment happy-dom
import { act, cleanup, waitFor } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openFilesAtom } from '@/lib/code-editor/state';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { chatTreeProjectIdsAtomFamily } from './tree-projects';
import { useQuickOpenRoots } from './use-quick-open-roots';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const project = (name: string) => ({ id: name, name, path: `/w/${name}` });
const [app, web, api, docs] = ['app', 'web', 'api', 'docs'].map(project);
const CHATS: Record<string, unknown> = {
  'chat-a': { worktreePath: null, branch: null, project: app },
  'chat-b': { worktreePath: '/wt/web-1', branch: 'feat', project: web },
  'chat-c': { worktreePath: null, branch: null, project: api },
};
const TREES = { 'chat-a': ['docs'], 'chat-b': ['api'], 'chat-c': ['web'] };

async function answer(op: Operation): Promise<unknown> {
  if (op.path === 'chats.get') return CHATS[(op.input as { id: string }).id] ?? null;
  if (op.path === 'changes.getBranches') throw new Error('not a git repository');
  if (op.path === 'projects.list') return [app, web, api, docs];
  throw new Error(`Unexpected test operation: ${op.path}`);
}

const root = (path: string, name: string, isChat = false) => ({ path, name, isChat });
type QuickOpenInput = Parameters<typeof useQuickOpenRoots>[0];
/** chat-a selected in single view, in its main folder as the layout resolves it */
const SINGLE_A: QuickOpenInput['single'] = {
  chatId: 'chat-a',
  path: '/w/app',
  worktreePath: undefined,
};
const B_IN_PANE: QuickOpenInput = { pane: { index: 1, chatId: 'chat-b' }, single: SINGLE_A };
const B_ROOTS = [root('/wt/web-1', 'web', true), root('/w/api', 'api')];

function renderQuickOpen(input: QuickOpenInput) {
  const store = createStore();
  for (const [chatId, ids] of Object.entries(TREES)) {
    store.set(chatTreeProjectIdsAtomFamily(chatId), ids);
  }
  const seen: { current?: ReturnType<typeof useQuickOpenRoots> } = {};
  function Probe() {
    seen.current = useQuickOpenRoots(input);
    return null;
  }
  const asked = vi.fn(answer);
  renderWithTrpc(
    <Provider store={store}>
      <Probe />
    </Provider>,
    asked,
  );
  return {
    quickOpen: () => seen.current!,
    openFiles: () => store.get(openFilesAtom),
    askedFor: () => asked.mock.calls.map(([op]) => op.path),
  };
}

afterEach(cleanup);

describe('useQuickOpenRoots', () => {
  it.each([
    {
      name: "split view: the pane chat's worktree, not the selected chat's folder",
      input: B_IN_PANE,
      roots: B_ROOTS,
      pick: 0,
      opened: { sourceChatId: 'chat-b', sourcePaneIndex: 1, isWorktreeContext: true },
    },
    {
      name: "split view: another project in the tree of a worktree chat's pane",
      input: B_IN_PANE,
      roots: B_ROOTS,
      pick: 1,
      opened: { sourceChatId: 'chat-b', sourcePaneIndex: 1, isOtherProject: true },
    },
    {
      name: "split view: the pane chat's main folder",
      input: { pane: { index: 1, chatId: 'chat-c' }, single: SINGLE_A },
      roots: [root('/w/api', 'api', true), root('/w/web', 'web')],
      pick: 0,
      opened: { sourceChatId: 'chat-c', sourcePaneIndex: 1 },
    },
    {
      name: "single view: another project in the selected chat's tree",
      input: { single: SINGLE_A },
      roots: [root('/w/app', 'app', true), root('/w/docs', 'docs')],
      pick: 1,
      opened: { sourceChatId: 'chat-a', isOtherProject: true },
    },
    {
      name: "single view: the selected chat's worktree",
      input: { single: { chatId: 'chat-b', path: '/wt/web-1', worktreePath: '/wt/web-1' } },
      roots: B_ROOTS,
      pick: 0,
      opened: { sourceChatId: 'chat-b', isWorktreeContext: true },
    },
  ])('searches $name, and opens the file for that chat', async ({ input, roots, pick, opened }) => {
    const { quickOpen, openFiles } = renderQuickOpen(input);
    await waitFor(() => expect(quickOpen().roots).toEqual(roots));
    const picked = roots[pick]!;

    act(() => quickOpen().open(`${picked.path}/a.ts`, picked));

    expect(openFiles()).toEqual([
      expect.objectContaining({
        path: `${picked.path}/a.ts`,
        projectPath: picked.path,
        sourcePaneIndex: undefined,
        isWorktreeContext: false,
        isOtherProject: undefined,
        ...opened,
      }),
    ]);
  });

  it("searches nothing for a split pane with no chat, not the selected chat's folder", () => {
    const { quickOpen, askedFor } = renderQuickOpen({
      pane: { index: 1, chatId: null },
      single: SINGLE_A,
    });

    expect(quickOpen().roots).toEqual([]);
    // No chat is looked up at all, so the selected chat's folder can't fill in later.
    expect(askedFor()).toEqual([]);
  });
});
