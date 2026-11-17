// @vitest-environment happy-dom
import { cleanup, waitFor } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type OpenFile, openFilesAtom } from '@/lib/code-editor/state';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { useSettleBrowsedTabsForChat } from './use-settle-browsed-tabs-for-chat';
import { useTreeProjects } from './use-tree-projects';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const app = { id: 'app', name: 'app', path: '/w/app' };
const api = { id: 'api', name: 'api', path: '/w/api' };
/** A tab from api opened from chat A; every chat works in app. */
const browsed: OpenFile = {
  path: 'src/b.ts',
  name: 'b.ts',
  projectPath: '/w/api',
  sourceChatId: 'chat-a',
  isOtherProject: true,
};

let releaseChat: () => void = () => {};
let chatReady = Promise.resolve();

async function answer(op: Operation): Promise<unknown> {
  if (op.path === 'chats.get') {
    // Only chat B links api.
    const { id } = op.input as { id: string };
    await chatReady;
    return {
      worktreePath: null,
      branch: null,
      project: app,
      linkedProjects: id === 'chat-b' ? [api] : [],
    };
  }
  if (op.path === 'changes.getBranches') return { current: 'main' };
  if (op.path === 'projects.list') return [app, api];
  throw new Error(`Unexpected test operation: ${op.path}`);
}

/** The shown chat's own project, once its tree has read the chat */
const seen = { main: null as { id: string } | null };

/** Single view on `chatId`, whose data has already loaded, as AgentsContent passes it. */
function Probe({ chatId }: { chatId: string }) {
  seen.main = useTreeProjects(chatId).main;
  useSettleBrowsedTabsForChat({
    chatId,
    chat: { id: chatId, project: { path: app.path } },
    isSplitActive: false,
  });
  return null;
}

/** Shows chat A with the tab open; chat B links api. */
function renderOnChatA() {
  const store = createStore();
  store.set(openFilesAtom, [browsed]);
  const view = renderWithTrpc(
    <Provider store={store}>
      <Probe chatId="chat-a" />
    </Provider>,
    answer,
  );
  const showChat = (chatId: string) =>
    view.rerender(
      <Provider store={store}>
        <Probe chatId={chatId} />
      </Provider>,
    );
  return { store, showChat };
}

afterEach(() => {
  cleanup();
  seen.main = null;
  chatReady = Promise.resolve();
});

describe('useSettleBrowsedTabsForChat', () => {
  it('keeps a tab of a project the incoming chat links on a switch to that chat', async () => {
    const { store, showChat } = renderOnChatA();

    showChat('chat-b');

    await waitFor(() =>
      expect(store.get(openFilesAtom)).toEqual([{ ...browsed, sourceChatId: 'chat-b' }]),
    );
  });

  it('settles nothing until the incoming chat says which projects it links', async () => {
    const { store, showChat } = renderOnChatA();
    await waitFor(() => expect(seen.main).toMatchObject({ id: 'app' }));
    chatReady = new Promise((resolve) => {
      releaseChat = resolve;
    });

    showChat('chat-c');
    expect(seen.main).toBeNull();
    expect(store.get(openFilesAtom)).toEqual([browsed]);

    releaseChat();
    await waitFor(() => expect(store.get(openFilesAtom)).toEqual([]));
  });
});
