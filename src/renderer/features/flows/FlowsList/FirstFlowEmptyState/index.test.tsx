// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type Operation, TRPCClientError } from '@trpc/client';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { observable } from '@trpc/server/observable';
import { createStore, Provider } from 'jotai';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeOverlayAtom } from '../../../../lib/atoms';
import { selectedAgentChatIdAtom } from '../../../../lib/atoms/agent-navigation-atoms';
import { useNewChatAccount } from '../../../../lib/hooks/use-new-chat-account';
import { trpc } from '../../../../lib/trpc';
import { FIRST_FLOW_PROMPT, FirstFlowEmptyState } from '.';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const CREATED_CHAT = { id: 'chat-1' };
const SIGNED_IN = { id: 'acc-1', type: 'claude-code', label: 'Claude', isAuthenticated: true };

type Options = {
  answerCreate?: boolean;
  /** What `getResolvedAccount` answers; `'pending'` never answers, `'error'` fails. */
  account?: typeof SIGNED_IN | null | 'pending' | 'error';
  /** A login picked in the New Chat composer, listed by `listAccounts`. */
  picked?: typeof SIGNED_IN;
};

/** The fake main process: the created chat, the resolved account, the listed logins. */
function answerFor(path: string, { account, picked }: Options) {
  if (path === 'chats.create') return CREATED_CHAT;
  if (path === 'claudeCode.getResolvedAccount') return account;
  if (path === 'claudeCode.listAccounts') return picked ? [picked] : [];
  return [];
}

/** Picks a login the way the New Chat composer does. */
function PickAccount({ accountId }: { accountId: string }) {
  const { pickAccount } = useNewChatAccount();
  useEffect(() => pickAccount(accountId), []);
  return null;
}

/** Answers project and account lookups; `chats.create` answers only when `answerCreate`. */
function renderEmptyState({ answerCreate = true, account = SIGNED_IN, picked }: Options = {}) {
  const calls: Operation[] = [];
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            calls.push(op);
            if (op.path === 'chats.create' && !answerCreate) return;
            if (op.path === 'claudeCode.getResolvedAccount' && account === 'pending') return;
            if (op.path === 'claudeCode.getResolvedAccount' && account === 'error') {
              return observer.error(TRPCClientError.from(new Error('lookup failed')));
            }
            observer.next({ result: { data: answerFor(op.path, { account, picked }) } });
            observer.complete();
          }),
    ],
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = createStore();
  store.set(selectedAgentChatIdAtom, 'chat-open');
  store.set(activeOverlayAtom, 'flows');
  const onCreateClick = vi.fn();
  const onOpenChat = vi.fn();
  render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <Provider store={store}>
          {picked && <PickAccount accountId={picked.id} />}
          <FirstFlowEmptyState onCreateClick={onCreateClick} onOpenChat={onOpenChat} />
        </Provider>
      </QueryClientProvider>
    </trpc.Provider>,
  );
  const createCalls = () => calls.filter((op) => op.path === 'chats.create');
  return { onCreateClick, onOpenChat, createCalls, store };
}

const aiButton = () => screen.getByRole('button', { name: 'Build with AI' });
const scratchButton = () => screen.getByRole('button', { name: 'Start from scratch' });

/** The button only becomes pressable once the account lookup has answered. */
async function clickAiButton() {
  await waitFor(() => expect(aiButton()).toBeEnabled());
  await userEvent.setup().click(aiButton());
}

describe('FirstFlowEmptyState', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('starts an agent chat outside a worktree with the first-flow prompt, then opens it', async () => {
    const { onOpenChat, createCalls } = renderEmptyState();

    await clickAiButton();

    await waitFor(() => expect(onOpenChat).toHaveBeenCalledWith(CREATED_CHAT.id));
    expect(createCalls()).toHaveLength(1);
    expect(createCalls()[0]?.input).toMatchObject({
      initialMessage: FIRST_FLOW_PROMPT,
      useWorktree: false,
    });
  });

  it('starts the chat on the login picked in New Chat', async () => {
    const picked = { ...SIGNED_IN, id: 'acc-picked' };
    const { onOpenChat, createCalls } = renderEmptyState({
      account: { ...SIGNED_IN, isAuthenticated: false },
      picked,
    });

    await clickAiButton();

    await waitFor(() => expect(onOpenChat).toHaveBeenCalledWith(CREATED_CHAT.id));
    expect(createCalls()[0]?.input).toMatchObject({ accountId: picked.id });
  });

  it.each<[string, Options['account']]>([
    ['no account is connected', null],
    ['the account is signed out', { ...SIGNED_IN, isAuthenticated: false }],
    ['the account lookup failed', 'error'],
  ])('sends the prompt to the New Chat sign-in step when %s', async (_case, account) => {
    const { onOpenChat, createCalls, store } = renderEmptyState({ account });

    await clickAiButton();

    expect(store.get(activeOverlayAtom)).toBeNull();
    expect(store.get(selectedAgentChatIdAtom)).toBeNull();
    expect(localStorage.getItem('agent-drafts-global')).toContain(FIRST_FLOW_PROMPT);
    expect(createCalls()).toHaveLength(0);
    expect(onOpenChat).not.toHaveBeenCalled();
  });

  it('waits on the account lookup without starting a chat, and keeps "Start from scratch"', async () => {
    const user = userEvent.setup();
    const { onCreateClick, createCalls } = renderEmptyState({ account: 'pending' });

    expect(aiButton()).toBeDisabled();
    await user.click(scratchButton());

    expect(onCreateClick).toHaveBeenCalledOnce();
    expect(createCalls()).toHaveLength(0);
  });

  it('locks both choices while the chat is starting', async () => {
    const { onOpenChat } = renderEmptyState({ answerCreate: false });

    await clickAiButton();

    await waitFor(() => expect(aiButton()).toBeDisabled());
    expect(scratchButton()).toBeDisabled();
    expect(onOpenChat).not.toHaveBeenCalled();
  });

  it('opens a blank flow from "Start from scratch"', async () => {
    const user = userEvent.setup();
    const { onCreateClick, createCalls } = renderEmptyState();

    await user.click(scratchButton());

    expect(onCreateClick).toHaveBeenCalledOnce();
    expect(createCalls()).toHaveLength(0);
  });
});
