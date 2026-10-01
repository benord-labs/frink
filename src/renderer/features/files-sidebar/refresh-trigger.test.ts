// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newTestQueryClient } from '@/lib/test-utils/render-with-trpc';
import { trpc } from '@/lib/trpc';
import {
  FILE_TREE_REFRESH_EVENT,
  FILE_TREE_REVEAL_EVENT,
  invalidateFileTreeQueries,
  triggerFileTreeRefresh,
  triggerFileTreeReveal,
  useFileTreeRefreshListeners,
} from './refresh-trigger';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

describe('refresh-trigger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('triggerFileTreeRefresh dispatches a custom event with correct detail', () => {
    const spy = vi.spyOn(window, 'dispatchEvent');
    triggerFileTreeRefresh('/tmp/proj', { force: true });

    expect(spy).toHaveBeenCalledTimes(1);
    const event = spy.mock.calls[0][0] as CustomEvent;
    expect(event.type).toBe(FILE_TREE_REFRESH_EVENT);
    expect(event.detail).toEqual({ projectPath: '/tmp/proj', force: true });
  });

  it('triggerFileTreeReveal dispatches a custom event with project and folder path', () => {
    const spy = vi.spyOn(window, 'dispatchEvent');
    triggerFileTreeReveal('/tmp/proj', 'src/components');

    expect(spy).toHaveBeenCalledTimes(1);
    const event = spy.mock.calls[0][0] as CustomEvent;
    expect(event.type).toBe(FILE_TREE_REVEAL_EVENT);
    expect(event.detail).toEqual({ projectPath: '/tmp/proj', folderPath: 'src/components' });
  });

  it('invalidateFileTreeQueries calls invalidate on both queries and bumps the trigger', () => {
    const invalidateList = vi.fn();
    const invalidateSearch = vi.fn();
    const setRefreshTrigger = vi.fn();

    const utils = {
      files: {
        listDirectory: { invalidate: invalidateList },
        search: { invalidate: invalidateSearch },
      },
    };

    invalidateFileTreeQueries(utils, setRefreshTrigger);

    expect(invalidateList).toHaveBeenCalledTimes(1);
    expect(invalidateSearch).toHaveBeenCalledTimes(1);
    expect(setRefreshTrigger).toHaveBeenCalledTimes(1);

    // Verify the updater increments
    const updater = setRefreshTrigger.mock.calls[0][0] as (prev: number) => number;
    expect(updater(5)).toBe(6);
  });
});

type GitStatusPayload = {
  worktreePath: string;
  changes: Array<{ path: string; type: 'add' | 'change' | 'unlink' }>;
};

// A real tRPC client answered in-process, so this exercises real utils.invalidate() calls
// without a module mock (mirrors renderWithTrpc, adapted for renderHook).
function createTrpcWrapper(queryClient: QueryClient) {
  const client = trpc.createClient({
    links: [
      () => (_ctx: { op: Operation }) =>
        observable((observer) => {
          observer.next({ result: { data: undefined } });
          observer.complete();
        }),
    ],
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(trpc.Provider, {
      client,
      queryClient,
      // oxlint-disable-next-line react/no-children-prop -- TRPCProviderProps types children as a required prop, so createElement's positional children fails ts:check
      children: createElement(QueryClientProvider, { client: queryClient, children }),
    });
  };
}

// Refresh and reveal events are covered through the FilesSidebar/PaneFileTree tests; this suite
// covers git:status-changed and the expand-after-drop reset.
describe('useFileTreeRefreshListeners', () => {
  let queryClient: QueryClient;
  let invalidateQueriesSpy: ReturnType<typeof vi.spyOn>;
  let gitStatusCallback: ((data: GitStatusPayload) => void) | null;
  const gitStatusCleanup = vi.fn();
  const subscribeToGitWatcher = vi.fn();
  const unsubscribeFromGitWatcher = vi.fn().mockResolvedValue(undefined);
  const onGitStatusChangedMock = vi.fn((callback: (data: GitStatusPayload) => void) => {
    gitStatusCallback = callback;
    return gitStatusCleanup;
  });

  beforeEach(() => {
    queryClient = newTestQueryClient();
    invalidateQueriesSpy = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
    gitStatusCallback = null;
    onGitStatusChangedMock.mockClear();
    subscribeToGitWatcher.mockClear();
    unsubscribeFromGitWatcher.mockClear();

    Object.defineProperty(window, 'desktopApi', {
      configurable: true,
      writable: true,
      value: {
        onGitStatusChanged: onGitStatusChangedMock,
        subscribeToGitWatcher,
        unsubscribeFromGitWatcher,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('invalidates file queries and bumps the refresh trigger for the matching project', () => {
    const { result } = renderHook(
      () => useFileTreeRefreshListeners({ projectPath: '/tmp/project-a' }),
      { wrapper: createTrpcWrapper(queryClient) },
    );

    expect(subscribeToGitWatcher).toHaveBeenCalledWith('/tmp/project-a');
    expect(gitStatusCallback).toBeTypeOf('function');
    expect(result.current.refreshTrigger).toBe(0);

    act(() => gitStatusCallback?.({ worktreePath: '/tmp/project-b', changes: [] }));
    expect(result.current.refreshTrigger).toBe(0);

    act(() => gitStatusCallback?.({ worktreePath: '/tmp/project-a', changes: [] }));
    expect(result.current.refreshTrigger).toBe(1);
    expect(invalidateQueriesSpy).toHaveBeenCalled();
  });

  it('unsubscribes from the git watcher on unmount', () => {
    const { unmount } = renderHook(
      () => useFileTreeRefreshListeners({ projectPath: '/tmp/project-a' }),
      { wrapper: createTrpcWrapper(queryClient) },
    );

    unmount();
    expect(gitStatusCleanup).toHaveBeenCalled();
    expect(unsubscribeFromGitWatcher).toHaveBeenCalledWith('/tmp/project-a');
  });

  it('clears pathToExpandAfterDrop one tick after it is set, so TreeNodes get one paint to react', () => {
    vi.useFakeTimers();
    const { result } = renderHook(
      () => useFileTreeRefreshListeners({ projectPath: '/tmp/project-a' }),
      { wrapper: createTrpcWrapper(queryClient) },
    );

    act(() => result.current.setPathToExpandAfterDrop('src/components'));
    expect(result.current.pathToExpandAfterDrop).toBe('src/components');

    act(() => vi.runAllTimers());
    expect(result.current.pathToExpandAfterDrop).toBeNull();
    vi.useRealTimers();
  });
});
