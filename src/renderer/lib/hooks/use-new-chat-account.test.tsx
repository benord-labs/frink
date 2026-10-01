// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useNewChatAccount } from './use-new-chat-account';

const snap = vi.hoisted(() => ({
  resolved: { id: 'acc-default', label: 'Work', type: 'claude-code', isAuthenticated: true },
  accounts: [
    { id: 'acc-default', label: 'Work', type: 'claude-code', isAuthenticated: true },
    { id: 'acc-codex', label: 'Personal', type: 'codex', isAuthenticated: true },
  ],
}));

vi.mock('../trpc', () => ({
  trpc: {
    claudeCode: {
      getResolvedAccount: { useQuery: () => ({ data: snap.resolved, isSuccess: true }) },
      listAccounts: { useQuery: () => ({ data: snap.accounts }) },
    },
  },
}));

function renderNewChatAccount(projectId = 'proj-1') {
  const store = createStore();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  return renderHook((props: { projectId: string }) => useNewChatAccount(props.projectId), {
    wrapper,
    initialProps: { projectId },
  });
}

describe('useNewChatAccount', () => {
  it('starts on the project or workspace default and sends no account until one is picked', () => {
    const { result } = renderNewChatAccount();

    expect(result.current.account?.id).toBe('acc-default');
    expect(result.current.pickedAccountId).toBeUndefined();
  });

  it('follows the picked login, provider included, so the model list switches with it', () => {
    const { result } = renderNewChatAccount();

    act(() => result.current.pickAccount('acc-codex'));

    expect(result.current.account).toMatchObject({ id: 'acc-codex', type: 'codex' });
    expect(result.current.pickedAccountId).toBe('acc-codex');
  });

  it('keeps a pick to the project it was made in and drops it once the chat is created', () => {
    const { result, rerender } = renderNewChatAccount();
    act(() => result.current.pickAccount('acc-codex'));

    rerender({ projectId: 'proj-2' });
    expect(result.current.account?.id).toBe('acc-default');

    rerender({ projectId: 'proj-1' });
    expect(result.current.pickedAccountId).toBe('acc-codex');
    act(() => result.current.clearPick());
    expect(result.current.account?.id).toBe('acc-default');
  });
});
