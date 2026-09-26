// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invalidateList = vi.fn(async (..._args: unknown[]) => undefined);
const invalidateListCounts = vi.fn(async (..._args: unknown[]) => undefined);
const invalidateListByFolder = vi.fn(async (..._args: unknown[]) => undefined);
const invalidateGet = vi.fn(async (..._args: unknown[]) => undefined);
const invalidateSubChatMessages = vi.fn(async (..._args: unknown[]) => undefined);
const invalidateResolvedAccount = vi.fn(async (..._args: unknown[]) => undefined);
const setPendingMoveTarget = vi.fn();
const clearPendingMoveTarget = vi.fn();
const clearAllForChat = vi.fn();
const appStoreSet = vi.fn();
const focusAgentChatAtom = Symbol('focusAgentChatAtom');
const pendingMoveChatContinuationAtom = Symbol('pendingMoveChatContinuationAtom');
const setPendingMoveContinuation = vi.fn();

let moveApprovedListener: ((data: unknown) => void) | null = null;
const cleanupListener = vi.fn();
const onAgentMoveChatApproved = vi.fn((cb: (data: unknown) => void) => {
  moveApprovedListener = cb;
  return cleanupListener;
});

vi.mock('jotai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jotai')>();
  return {
    ...actual,
    useSetAtom: () => setPendingMoveContinuation,
  };
});

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      chats: {
        list: { invalidate: (...args: unknown[]) => invalidateList(...args) },
        listCounts: { invalidate: (...args: unknown[]) => invalidateListCounts(...args) },
        listByFolder: { invalidate: (...args: unknown[]) => invalidateListByFolder(...args) },
        get: { invalidate: (...args: unknown[]) => invalidateGet(...args) },
        getSubChatMessages: {
          invalidate: (...args: unknown[]) => invalidateSubChatMessages(...args),
        },
      },
      claudeCode: {
        getResolvedAccount: {
          invalidate: (...args: unknown[]) => invalidateResolvedAccount(...args),
        },
      },
    }),
  },
}));

vi.mock('../../../lib/jotai-store', () => ({
  appStore: {
    set: appStoreSet,
  },
}));

vi.mock('../../../lib/atoms', () => ({
  focusAgentChatAtom,
}));

vi.mock('../atoms', () => ({
  pendingMoveChatContinuationAtom,
  navigationSessionIdAtomFamily: vi.fn((subChatId: string) =>
    Symbol(`navigationSessionId:${subChatId}`),
  ),
}));

vi.mock('../stores/agent-chat-store', () => ({
  agentChatStore: {
    setPendingMoveTarget,
    clearPendingMoveTarget,
    clearAllForChat,
  },
}));

const { useAgentRequestMoveChat } = await import('./use-agent-request-move-chat');

describe('useAgentRequestMoveChat', () => {
  beforeEach(() => {
    moveApprovedListener = null;
    cleanupListener.mockReset();
    onAgentMoveChatApproved.mockClear();
    setPendingMoveContinuation.mockReset();
    invalidateList.mockClear();
    invalidateListCounts.mockClear();
    invalidateListByFolder.mockClear();
    invalidateGet.mockClear();
    invalidateSubChatMessages.mockClear();
    invalidateResolvedAccount.mockClear();
    setPendingMoveTarget.mockReset();
    clearPendingMoveTarget.mockReset();
    clearAllForChat.mockReset();
    appStoreSet.mockReset();

    Object.defineProperty(window, 'desktopApi', {
      writable: true,
      configurable: true,
      value: {
        onAgentMoveChatApproved,
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'desktopApi', {
      writable: true,
      configurable: true,
      value: undefined,
    });
  });

  it('sets pending target, clears chat cache, invalidates queries, then selects chat', async () => {
    renderHook(() => useAgentRequestMoveChat());

    act(() => {
      moveApprovedListener?.({
        chatId: 'chat-1',
        subChatId: 'sub-1',
        projectId: 'project-2',
        projectName: 'Project 2',
        projectPath: '/tmp/project-2',
        requestedWorktreePath: null,
        navigationSessionId: 'nav-1',
      });
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(setPendingMoveContinuation).toHaveBeenCalled();
      });
    });

    expect(setPendingMoveTarget).toHaveBeenCalledWith('chat-1', 'project-2', null);
    expect(clearAllForChat).toHaveBeenCalledWith('chat-1');
    expect(invalidateList).toHaveBeenCalledTimes(1);
    expect(invalidateListCounts).toHaveBeenCalledTimes(1);
    expect(invalidateListByFolder).toHaveBeenCalledTimes(1);
    expect(invalidateGet).toHaveBeenCalledWith({ id: 'chat-1' });
    expect(invalidateSubChatMessages).toHaveBeenCalledTimes(1);
    expect(invalidateResolvedAccount).toHaveBeenCalledWith({ chatId: 'chat-1' });
    expect(invalidateResolvedAccount).toHaveBeenCalledWith({ projectId: 'project-2' });
    expect(appStoreSet.mock.calls[0]?.[1]).toBe('nav-1');
    expect(appStoreSet).toHaveBeenNthCalledWith(2, focusAgentChatAtom, 'chat-1');
    expect(setPendingMoveContinuation).toHaveBeenCalledWith({
      chatId: 'chat-1',
      subChatId: 'sub-1',
      projectName: 'Project 2',
      projectPath: '/tmp/project-2',
    });
  });

  it('does nothing when desktop API listener is unavailable', () => {
    Object.defineProperty(window, 'desktopApi', {
      writable: true,
      configurable: true,
      value: {},
    });

    renderHook(() => useAgentRequestMoveChat());
    expect(setPendingMoveTarget).not.toHaveBeenCalled();
    expect(invalidateList).not.toHaveBeenCalled();
  });

  it('keeps one move approval subscription across parent rerenders', () => {
    const { rerender, unmount } = renderHook(() => useAgentRequestMoveChat());

    rerender();
    expect(onAgentMoveChatApproved).toHaveBeenCalledTimes(1);
    expect(cleanupListener).not.toHaveBeenCalled();

    unmount();
    expect(cleanupListener).toHaveBeenCalledTimes(1);
  });

  it('handles repeated approvals for the same chat idempotently with consistent invalidation sequence', async () => {
    renderHook(() => useAgentRequestMoveChat());

    act(() => {
      moveApprovedListener?.({
        chatId: 'chat-1',
        subChatId: 'sub-1',
        projectId: 'project-2',
        projectName: 'Project 2',
        projectPath: '/tmp/project-2',
        requestedWorktreePath: '/tmp/project-2/.worktree/feat-x',
        navigationSessionId: 'nav-1',
      });
      moveApprovedListener?.({
        chatId: 'chat-1',
        subChatId: 'sub-1',
        projectId: 'project-2',
        projectName: 'Project 2',
        projectPath: '/tmp/project-2',
        requestedWorktreePath: '/tmp/project-2/.worktree/feat-x',
        navigationSessionId: 'nav-1',
      });
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(setPendingMoveContinuation).toHaveBeenCalledTimes(2);
      });
    });

    expect(setPendingMoveTarget).toHaveBeenCalledTimes(2);
    expect(setPendingMoveTarget).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      'project-2',
      '/tmp/project-2/.worktree/feat-x',
    );
    expect(invalidateList).toHaveBeenCalledTimes(2);
    expect(invalidateListCounts).toHaveBeenCalledTimes(2);
    expect(invalidateListByFolder).toHaveBeenCalledTimes(2);
    expect(invalidateGet).toHaveBeenCalledTimes(2);
    expect(invalidateSubChatMessages).toHaveBeenCalledTimes(2);
    expect(invalidateResolvedAccount).toHaveBeenCalledTimes(4);
    expect(setPendingMoveContinuation).toHaveBeenCalledTimes(2);
    expect(appStoreSet).toHaveBeenCalledWith(focusAgentChatAtom, 'chat-1');
  });

  it('falls back to selecting chat + continuation when invalidation rejects', async () => {
    invalidateList.mockRejectedValueOnce(new Error('invalidate failed'));
    renderHook(() => useAgentRequestMoveChat());

    act(() => {
      moveApprovedListener?.({
        chatId: 'chat-1',
        subChatId: 'sub-1',
        projectId: 'project-2',
        projectName: 'Project 2',
        projectPath: '/tmp/project-2',
        requestedWorktreePath: '/tmp/project-2/.worktree/feat-x',
        navigationSessionId: 'nav-1',
      });
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(setPendingMoveContinuation).toHaveBeenCalled();
      });
    });

    expect(setPendingMoveTarget).toHaveBeenCalledWith(
      'chat-1',
      'project-2',
      '/tmp/project-2/.worktree/feat-x',
    );
    // Failed invalidation must clear the pending target so the Chat isn't stranded behind the
    // freshness gate (permanent black screen). Mirrors the DnD handleMoveChat catch path.
    expect(clearPendingMoveTarget).toHaveBeenCalledWith('chat-1');
    expect(setPendingMoveContinuation).toHaveBeenCalledWith({
      chatId: 'chat-1',
      subChatId: 'sub-1',
      projectName: 'Project 2',
      projectPath: '/tmp/project-2',
    });
  });
});
