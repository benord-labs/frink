// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { createStore, Provider, useAtomValue } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { getDefaultRatios, splitViewAtom, splitViewChatIdsAtom } from '../../../atoms';
import { showChatInPaneAtom } from '../../../hooks/use-split-view-actions';
import { PaneHistoryNav } from './index';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const BACK_TO_OLD = /back to “old chat”/i;
const FORWARD_TO_NEW = /forward to “new chat”/i;
const OLD_AND_NEW = [
  { id: 'old', name: 'Old chat' },
  { id: 'new', name: 'New chat' },
];

/** Answers chats.list with the given live (unarchived) chats. */
function listChats(chats: { id: string; name: string | null }[]) {
  return async (op: Operation) => {
    if (op.path !== 'chats.list') throw new Error(`Unexpected test operation: ${op.path}`);
    return chats;
  };
}

/** Pane 1's open pane menu, holding its history items for whichever chat that pane shows. */
function SecondPaneMenu() {
  const chatId = useAtomValue(splitViewChatIdsAtom)[1] ?? '';
  return (
    <DropdownMenu open>
      <DropdownMenuContent>
        <PaneHistoryNav chatId={chatId} paneIndex={1} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function expectDisabled(item: HTMLElement) {
  expect(item).toHaveAttribute('aria-disabled', 'true');
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
      <SecondPaneMenu />
    </Provider>,
    listChats(chats),
  );
  return store;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(cleanup);

describe('PaneHistoryNav', () => {
  it('goes Back to the replaced chat, then Forward again', async () => {
    const store = renderAfterReplace(OLD_AND_NEW);
    const back = await screen.findByRole('menuitem', { name: BACK_TO_OLD });
    expectDisabled(screen.getByRole('menuitem', { name: 'Forward' }));

    fireEvent.click(back);
    expect(store.get(splitViewAtom).chatIds).toEqual(['other', 'old']);
    expectDisabled(await screen.findByRole('menuitem', { name: 'Back' }));

    fireEvent.click(screen.getByRole('menuitem', { name: FORWARD_TO_NEW }));
    expect(store.get(splitViewAtom).chatIds).toEqual(['other', 'new']);
    expect(await screen.findByRole('menuitem', { name: BACK_TO_OLD })).not.toHaveAttribute(
      'aria-disabled',
    );
  });

  it('skips a newer earlier chat that was archived and offers the older one', async () => {
    const store = renderAfterReplace(OLD_AND_NEW, ['archived', 'new']);
    fireEvent.click(await screen.findByRole('menuitem', { name: BACK_TO_OLD }));
    expect(store.get(splitViewAtom).chatIds).toEqual(['other', 'old']);
  });

  it('renders nothing when the pane has no history', () => {
    renderWithTrpc(
      <Provider store={createStore()}>
        <PaneHistoryNav chatId="new" paneIndex={0} />
      </Provider>,
      listChats([]),
    );
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });

  it('renders nothing once the earlier chat is open in another pane', async () => {
    const store = renderAfterReplace(OLD_AND_NEW);
    await screen.findByRole('menuitem', { name: BACK_TO_OLD });
    act(() => {
      store.set(splitViewAtom, { ...store.get(splitViewAtom), chatIds: ['old', 'new'] });
    });
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });

  it('renders nothing when the earlier chat was archived or deleted', async () => {
    renderAfterReplace([{ id: 'new', name: 'New chat' }]);
    await act(async () => {});
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });
});
