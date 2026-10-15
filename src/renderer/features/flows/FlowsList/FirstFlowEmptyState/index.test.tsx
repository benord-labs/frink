// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Operation } from '@trpc/client';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { observable } from '@trpc/server/observable';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '../../../../lib/trpc';
import { FIRST_FLOW_PROMPT, FirstFlowEmptyState } from '.';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const CREATED_CHAT = { id: 'chat-1' };

/** Answers project lookups with no projects; `chats.create` answers only when `answerCreate`. */
function renderEmptyState({ answerCreate }: { answerCreate: boolean }) {
  const calls: Operation[] = [];
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            calls.push(op);
            if (op.path === 'chats.create' && !answerCreate) return;
            observer.next({ result: { data: op.path === 'chats.create' ? CREATED_CHAT : [] } });
            observer.complete();
          }),
    ],
  });
  const queryClient = new QueryClient();
  const onCreateClick = vi.fn();
  const onOpenChat = vi.fn();
  render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <Provider store={createStore()}>
          <FirstFlowEmptyState onCreateClick={onCreateClick} onOpenChat={onOpenChat} />
        </Provider>
      </QueryClientProvider>
    </trpc.Provider>,
  );
  const createCalls = () => calls.filter((op) => op.path === 'chats.create');
  return { onCreateClick, onOpenChat, createCalls };
}

const aiButton = () => screen.getByRole('button', { name: 'Build my first flow with AI' });
const scratchButton = () => screen.getByRole('button', { name: 'Start from scratch' });

describe('FirstFlowEmptyState', () => {
  afterEach(cleanup);

  it('starts an agent chat outside a worktree with the first-flow prompt, then opens it', async () => {
    const user = userEvent.setup();
    const { onOpenChat, createCalls } = renderEmptyState({ answerCreate: true });

    await user.click(aiButton());

    await waitFor(() => expect(onOpenChat).toHaveBeenCalledWith(CREATED_CHAT.id));
    expect(createCalls()).toHaveLength(1);
    expect(createCalls()[0]?.input).toMatchObject({
      initialMessage: FIRST_FLOW_PROMPT,
      useWorktree: false,
    });
  });

  it('locks both choices while the chat is starting', async () => {
    const user = userEvent.setup();
    const { onOpenChat } = renderEmptyState({ answerCreate: false });

    await user.click(aiButton());

    await waitFor(() => expect(aiButton()).toBeDisabled());
    expect(scratchButton()).toBeDisabled();
    expect(onOpenChat).not.toHaveBeenCalled();
  });

  it('opens a blank flow from "Start from scratch"', async () => {
    const user = userEvent.setup();
    const { onCreateClick, createCalls } = renderEmptyState({ answerCreate: true });

    await user.click(scratchButton());

    expect(onCreateClick).toHaveBeenCalledOnce();
    expect(createCalls()).toHaveLength(0);
  });
});
