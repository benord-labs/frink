// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { paneHistoryAtom } from '@/lib/atoms/pane-history';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { getDefaultRatios, splitViewAtom } from '../../../atoms';
import { showChatInPaneAtom } from '../../../hooks/use-split-view-actions';
import { PaneBackButton } from './index';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const BACK_TO_OLD = /back to “old chat”/i;

/** Answers chats.list with the given live (unarchived) chats. */
function listChats(chats: { id: string; name: string | null }[]) {
  return async (op: Operation) => {
    if (op.path !== 'chats.list') throw new Error(`Unexpected test operation: ${op.path}`);
    return chats;
  };
}

/** A two-pane split where the sidebar has replaced `old` in pane 1 with each of `peeks` in turn. */
function renderAfterReplace(chats: { id: string; name: string | null }[], peeks = ['new']) {
  const store = createStore();
  store.set(splitViewAtom, {
    chatIds: ['other', 'old'],
    ratios: getDefaultRatios(2),
    activePaneIndex: 1,
    layout: 'horizontal',
  });
  for (const chatId of peeks) store.set(showChatInPaneAtom, { chatId });
  renderWithTrpc(
    <Provider store={store}>
      <TooltipProvider>
        <PaneBackButton chatId={peeks.at(-1) ?? ''} paneIndex={1} />
      </TooltipProvider>
    </Provider>,
    listChats(chats),
  );
  return store;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(cleanup);

describe('PaneBackButton', () => {
  it('returns the pane to the chat it replaced', async () => {
    const store = renderAfterReplace([{ id: 'old', name: 'Old chat' }]);
    fireEvent.click(await screen.findByRole('button', { name: BACK_TO_OLD }));
    expect(store.get(splitViewAtom).chatIds).toEqual(['other', 'old']);
    expect(store.get(paneHistoryAtom)).toEqual({});
  });

  it('skips a newer earlier chat that was archived and offers the older one', async () => {
    const store = renderAfterReplace([{ id: 'old', name: 'Old chat' }], ['archived', 'new']);
    fireEvent.click(await screen.findByRole('button', { name: BACK_TO_OLD }));
    expect(store.get(splitViewAtom).chatIds).toEqual(['other', 'old']);
    expect(store.get(paneHistoryAtom)).toEqual({});
  });

  it('renders nothing when the pane has no earlier chat', () => {
    renderWithTrpc(
      <Provider store={createStore()}>
        <PaneBackButton chatId="new" paneIndex={0} />
      </Provider>,
      listChats([]),
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders nothing once the earlier chat is open in another pane', async () => {
    const store = renderAfterReplace([{ id: 'old', name: 'Old chat' }]);
    await screen.findByRole('button', { name: BACK_TO_OLD });
    act(() => {
      store.set(splitViewAtom, { ...store.get(splitViewAtom), chatIds: ['old', 'new'] });
    });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders nothing when the earlier chat was archived or deleted', async () => {
    renderAfterReplace([{ id: 'new', name: 'New chat' }]);
    await act(async () => {});
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
