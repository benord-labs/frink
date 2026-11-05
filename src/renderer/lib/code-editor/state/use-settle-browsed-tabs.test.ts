// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { type OpenFile, openFilesAtom } from './atoms';
import { useSettleBrowsedTabs } from './use-settle-browsed-tabs';

/** A tab from ros-service opened from chat A; chats A, B and C all work in /repo. */
const browsed: OpenFile = {
  path: 'src/b.ts',
  name: 'b.ts',
  projectPath: '/ros-service',
  sourceChatId: 'chat-a',
  isOtherProject: true,
};

type Chat = Parameters<typeof useSettleBrowsedTabs>[0]['chat'];
type Props = { chat: Chat; isSplitActive: boolean; keepProjectPaths?: string[] };

const inRepo = (id: string): Chat => ({ id, project: { path: '/repo' } });

function renderSettle(initial: Props) {
  const store = createStore();
  store.set(openFilesAtom, [browsed]);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(Provider, { store }, children);
  const view = renderHook((props: Props) => useSettleBrowsedTabs(props), {
    initialProps: initial,
    wrapper,
  });
  return { store, rerender: view.rerender };
}

describe('useSettleBrowsedTabs', () => {
  it('closes the tab on a single-view switch to another chat of the same project', () => {
    const { store, rerender } = renderSettle({ chat: inRepo('chat-a'), isSplitActive: false });
    expect(store.get(openFilesAtom)).toEqual([browsed]);

    rerender({ chat: inRepo('chat-c'), isSplitActive: false });

    expect(store.get(openFilesAtom)).toEqual([]);
  });

  it("keeps the tab on a switch to a chat whose file tree has the tab's project", () => {
    const { store, rerender } = renderSettle({ chat: inRepo('chat-a'), isSplitActive: false });

    rerender({ chat: inRepo('chat-c'), isSplitActive: false, keepProjectPaths: ['/ros-service'] });

    expect(store.get(openFilesAtom)).toEqual([{ ...browsed, sourceChatId: 'chat-c' }]);
  });

  it('waits for the chat to load', () => {
    const { store } = renderSettle({ chat: undefined, isSplitActive: false });

    expect(store.get(openFilesAtom)).toEqual([browsed]);
  });

  it("settles against a worktree chat's worktree, not its project's main folder", () => {
    const { store, rerender } = renderSettle({
      chat: { id: 'chat-c', worktreePath: '/ros-service', project: { path: '/repo' } },
      isSplitActive: false,
    });
    expect(store.get(openFilesAtom)).toEqual([
      { ...browsed, isOtherProject: undefined, sourceChatId: 'chat-c' },
    ]);

    store.set(openFilesAtom, [browsed]);
    rerender({
      chat: { id: 'chat-d', worktreePath: '/repo-wt', project: { path: '/ros-service' } },
      isSplitActive: false,
    });
    expect(store.get(openFilesAtom)).toEqual([]);
  });

  it('keeps every tab in split view', () => {
    const { store, rerender } = renderSettle({ chat: inRepo('chat-c'), isSplitActive: true });
    rerender({ chat: inRepo('chat-b'), isSplitActive: true });

    expect(store.get(openFilesAtom)).toEqual([browsed]);
  });

  it('keeps every tab on the first pass after split view ends, then settles', () => {
    const { store, rerender } = renderSettle({ chat: inRepo('chat-b'), isSplitActive: true });

    rerender({ chat: inRepo('chat-b'), isSplitActive: false });
    expect(store.get(openFilesAtom)).toEqual([browsed]);

    rerender({ chat: inRepo('chat-c'), isSplitActive: false });
    expect(store.get(openFilesAtom)).toEqual([]);
  });

  it('settles the next chat when split view ends with no chat loaded', () => {
    const { store, rerender } = renderSettle({ chat: inRepo('chat-b'), isSplitActive: true });

    rerender({ chat: null, isSplitActive: false });
    expect(store.get(openFilesAtom)).toEqual([browsed]);

    rerender({ chat: inRepo('chat-c'), isSplitActive: false });
    expect(store.get(openFilesAtom)).toEqual([]);
  });
});
