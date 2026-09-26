// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKING_LINE_CHANGES_QUERY_KEY_PREFIX } from '../query-keys/changes';
import { useFileChangeListener, useGitWatcher } from './use-file-change-listener';

type FileChangedPayload = { filePath: string; type: string; subChatId: string };
type GitStatusChangedPayload = {
  worktreePath: string;
  changes: Array<{ path: string; type: 'add' | 'change' | 'unlink' }>;
};

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function hasScopedWorkingLineInvalidationCall(
  invalidateQueriesSpy: ReturnType<typeof vi.spyOn>,
  worktreePath: string,
): boolean {
  return invalidateQueriesSpy.mock.calls.some((call: [unknown, ...unknown[]]) => {
    const [arg] = call;
    if (!arg || typeof arg !== 'object' || !('predicate' in arg)) return false;
    const maybePredicate = (arg as { predicate?: (query: { queryKey: unknown[] }) => boolean })
      .predicate;
    if (typeof maybePredicate !== 'function') return false;
    return (
      maybePredicate({
        queryKey: [WORKING_LINE_CHANGES_QUERY_KEY_PREFIX, { input: { worktreePath } }],
      }) &&
      !maybePredicate({
        queryKey: [WORKING_LINE_CHANGES_QUERY_KEY_PREFIX, { input: { worktreePath: '/other' } }],
      })
    );
  });
}

describe('useFileChangeListener', () => {
  let queryClient: QueryClient;
  let invalidateQueriesSpy: ReturnType<typeof vi.spyOn>;
  let onFileChangedCallback: ((data: FileChangedPayload) => void) | null;

  const onFileChangedCleanup = vi.fn();
  const onFileChangedMock = vi.fn((callback: (data: FileChangedPayload) => void) => {
    onFileChangedCallback = callback;
    return onFileChangedCleanup;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    queryClient = new QueryClient();
    invalidateQueriesSpy = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
    onFileChangedCallback = null;
    onFileChangedCleanup.mockReset();
    onFileChangedMock.mockClear();

    Object.defineProperty(window, 'desktopApi', {
      configurable: true,
      writable: true,
      value: {
        onFileChanged: onFileChangedMock,
      },
    });
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('invalidates status only for matching worktree paths', () => {
    const worktreePath = '/tmp/project-a';
    const wrapper = createWrapper(queryClient);
    const { unmount } = renderHook(() => useFileChangeListener(worktreePath), { wrapper });

    expect(onFileChangedCallback).toBeTypeOf('function');

    onFileChangedCallback?.({
      filePath: '/tmp/project-b/src/index.ts',
      type: 'change',
      subChatId: 'sub-1',
    });
    expect(invalidateQueriesSpy).not.toHaveBeenCalled();

    onFileChangedCallback?.({
      filePath: '/tmp/project-a/src/index.ts',
      type: 'change',
      subChatId: 'sub-1',
    });
    vi.advanceTimersByTime(150);

    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: [['changes', 'getStatus'], { input: { worktreePath } }],
    });
    expect(hasScopedWorkingLineInvalidationCall(invalidateQueriesSpy, worktreePath)).toBe(true);
    expect(invalidateQueriesSpy).toHaveBeenCalledTimes(2);

    unmount();
    expect(onFileChangedCleanup).toHaveBeenCalledTimes(1);
  });

  it('does not invalidate for sibling paths sharing prefix', () => {
    const worktreePath = '/tmp/project-a';
    const wrapper = createWrapper(queryClient);
    renderHook(() => useFileChangeListener(worktreePath), { wrapper });

    onFileChangedCallback?.({
      filePath: '/tmp/project-a-other/src/index.ts',
      type: 'change',
      subChatId: 'sub-1',
    });

    expect(invalidateQueriesSpy).not.toHaveBeenCalled();
  });

  it('handles rapid consecutive matching file events', () => {
    const worktreePath = '/tmp/project-a';
    const wrapper = createWrapper(queryClient);
    renderHook(() => useFileChangeListener(worktreePath), { wrapper });

    onFileChangedCallback?.({
      filePath: '/tmp/project-a/src/a.ts',
      type: 'change',
      subChatId: 'sub-1',
    });
    onFileChangedCallback?.({
      filePath: '/tmp/project-a/src/b.ts',
      type: 'change',
      subChatId: 'sub-1',
    });
    vi.advanceTimersByTime(150);

    expect(invalidateQueriesSpy).toHaveBeenCalledTimes(3);
    expect(hasScopedWorkingLineInvalidationCall(invalidateQueriesSpy, worktreePath)).toBe(true);
  });

  it('treats exact worktree path as inside path', () => {
    const worktreePath = '/tmp/project-a';
    const wrapper = createWrapper(queryClient);
    renderHook(() => useFileChangeListener(worktreePath), { wrapper });

    onFileChangedCallback?.({
      filePath: '/tmp/project-a',
      type: 'change',
      subChatId: 'sub-1',
    });
    vi.advanceTimersByTime(150);

    expect(invalidateQueriesSpy).toHaveBeenCalledTimes(2);
  });

  it('handles windows path separators with boundary-safe matching', () => {
    const worktreePath = 'C:\\repo\\project-a';
    const wrapper = createWrapper(queryClient);
    renderHook(() => useFileChangeListener(worktreePath), { wrapper });

    onFileChangedCallback?.({
      filePath: 'C:\\repo\\project-a\\src\\index.ts',
      type: 'change',
      subChatId: 'sub-1',
    });
    vi.advanceTimersByTime(150);
    expect(invalidateQueriesSpy).toHaveBeenCalledTimes(2);

    invalidateQueriesSpy.mockClear();
    onFileChangedCallback?.({
      filePath: 'C:\\repo\\project-a-other\\src\\index.ts',
      type: 'change',
      subChatId: 'sub-1',
    });
    expect(invalidateQueriesSpy).not.toHaveBeenCalled();
  });
});

describe('useGitWatcher', () => {
  let queryClient: QueryClient;
  let invalidateQueriesSpy: ReturnType<typeof vi.spyOn>;
  let onGitStatusChangedCallback: ((data: GitStatusChangedPayload) => void) | null;

  const onGitStatusChangedCleanup = vi.fn();
  const onGitStatusChangedMock = vi.fn((callback: (data: GitStatusChangedPayload) => void) => {
    onGitStatusChangedCallback = callback;
    return onGitStatusChangedCleanup;
  });
  const subscribeToGitWatcherMock = vi.fn(async () => undefined);
  const unsubscribeFromGitWatcherMock = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.useFakeTimers();
    queryClient = new QueryClient();
    invalidateQueriesSpy = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
    onGitStatusChangedCallback = null;

    onGitStatusChangedCleanup.mockReset();
    onGitStatusChangedMock.mockClear();
    subscribeToGitWatcherMock.mockClear();
    unsubscribeFromGitWatcherMock.mockClear();

    Object.defineProperty(window, 'desktopApi', {
      configurable: true,
      writable: true,
      value: {
        onGitStatusChanged: onGitStatusChangedMock,
        subscribeToGitWatcher: subscribeToGitWatcherMock,
        unsubscribeFromGitWatcher: unsubscribeFromGitWatcherMock,
      },
    });
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('subscribes and unsubscribes for active worktree', async () => {
    const worktreePath = '/tmp/project-a';
    const wrapper = createWrapper(queryClient);
    const { unmount } = renderHook(() => useGitWatcher(worktreePath), { wrapper });

    await vi.advanceTimersByTimeAsync(0);
    expect(subscribeToGitWatcherMock).toHaveBeenCalledWith(worktreePath);

    unmount();

    await vi.advanceTimersByTimeAsync(0);
    expect(unsubscribeFromGitWatcherMock).toHaveBeenCalledWith(worktreePath);
    expect(onGitStatusChangedCleanup).toHaveBeenCalledTimes(1);
  });

  it('gracefully handles watcher subscription failure', async () => {
    const worktreePath = '/tmp/project-a';
    const wrapper = createWrapper(queryClient);
    subscribeToGitWatcherMock.mockRejectedValueOnce(new Error('subscribe failed'));
    const { unmount } = renderHook(() => useGitWatcher(worktreePath), { wrapper });

    await vi.advanceTimersByTimeAsync(0);
    expect(subscribeToGitWatcherMock).toHaveBeenCalledWith(worktreePath);

    unmount();
    expect(unsubscribeFromGitWatcherMock).not.toHaveBeenCalled();
  });

  it('undoes a subscribe that resolves after the hook unmounted', async () => {
    let finishSubscribe: () => void = () => undefined;
    subscribeToGitWatcherMock.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishSubscribe = () => resolve(undefined);
        }),
    );
    const wrapper = createWrapper(queryClient);
    const { unmount } = renderHook(() => useGitWatcher('/tmp/project-a'), { wrapper });

    unmount();
    expect(unsubscribeFromGitWatcherMock).not.toHaveBeenCalled();
    finishSubscribe();
    await vi.advanceTimersByTimeAsync(0);
    expect(unsubscribeFromGitWatcherMock).toHaveBeenCalledWith('/tmp/project-a');
  });

  it('invalidates status and branches on branch-only events (no file edits)', async () => {
    const worktreePath = '/tmp/project-a';
    const wrapper = createWrapper(queryClient);
    renderHook(() => useGitWatcher(worktreePath), { wrapper });

    onGitStatusChangedCallback?.({
      worktreePath,
      changes: [],
    });
    vi.advanceTimersByTime(150);
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: [['changes', 'getStatus'], { input: { worktreePath } }],
    });
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: [['changes', 'getBranches'], { input: { worktreePath } }],
    });
    expect(hasScopedWorkingLineInvalidationCall(invalidateQueriesSpy, worktreePath)).toBe(true);
  });

  it('invalidates on unlink events as well as change/add', async () => {
    const worktreePath = '/tmp/project-a';
    const wrapper = createWrapper(queryClient);
    renderHook(() => useGitWatcher(worktreePath), { wrapper });

    onGitStatusChangedCallback?.({
      worktreePath,
      changes: [{ path: '/tmp/project-a/src/removed.ts', type: 'unlink' }],
    });
    vi.advanceTimersByTime(150);
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: [['changes', 'getStatus'], { input: { worktreePath } }],
    });
    expect(hasScopedWorkingLineInvalidationCall(invalidateQueriesSpy, worktreePath)).toBe(true);
  });

  it('invalidates status and branches on git pointer updates', async () => {
    const worktreePath = '/tmp/project-a';
    const wrapper = createWrapper(queryClient);
    renderHook(() => useGitWatcher(worktreePath), { wrapper });

    onGitStatusChangedCallback?.({
      worktreePath,
      changes: [{ path: '/tmp/project-a/.git/index', type: 'change' }],
    });
    vi.advanceTimersByTime(150);

    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: [['changes', 'getStatus'], { input: { worktreePath } }],
    });
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: [['changes', 'getBranches'], { input: { worktreePath } }],
    });
    expect(hasScopedWorkingLineInvalidationCall(invalidateQueriesSpy, worktreePath)).toBe(true);
  });

  it('ignores events from other worktrees (split pane isolation)', () => {
    const worktreePath = '/tmp/project-a';
    const wrapper = createWrapper(queryClient);
    renderHook(() => useGitWatcher(worktreePath), { wrapper });

    onGitStatusChangedCallback?.({
      worktreePath: '/tmp/project-b',
      changes: [{ path: '/tmp/project-b/src/index.ts', type: 'change' }],
    });

    expect(invalidateQueriesSpy).not.toHaveBeenCalled();
  });

  it('keeps worktree invalidations isolated with parallel watchers', () => {
    const callbacks = new Set<(data: GitStatusChangedPayload) => void>();
    Object.defineProperty(window, 'desktopApi', {
      configurable: true,
      writable: true,
      value: {
        onGitStatusChanged: (callback: (data: GitStatusChangedPayload) => void) => {
          callbacks.add(callback);
          return () => callbacks.delete(callback);
        },
        subscribeToGitWatcher: subscribeToGitWatcherMock,
        unsubscribeFromGitWatcher: unsubscribeFromGitWatcherMock,
      },
    });

    const wrapper = createWrapper(queryClient);
    renderHook(() => useGitWatcher('/tmp/project-a'), { wrapper });
    renderHook(() => useGitWatcher('/tmp/project-b'), { wrapper });

    for (const callback of callbacks) {
      callback({
        worktreePath: '/tmp/project-a',
        changes: [{ path: '/tmp/project-a/src/index.ts', type: 'change' }],
      });
    }
    vi.advanceTimersByTime(150);

    const statusAKey = {
      queryKey: [['changes', 'getStatus'], { input: { worktreePath: '/tmp/project-a' } }],
    };
    const statusBKey = {
      queryKey: [['changes', 'getStatus'], { input: { worktreePath: '/tmp/project-b' } }],
    };
    expect(invalidateQueriesSpy).toHaveBeenCalledWith(statusAKey);
    expect(invalidateQueriesSpy).not.toHaveBeenCalledWith(statusBKey);
  });

  it('keeps second pane reactive when first pane unmounts on same worktree', async () => {
    const worktreePath = '/tmp/project-a';
    const callbacks = new Set<(data: GitStatusChangedPayload) => void>();
    const localSubscribeMock = vi.fn(async () => undefined);
    const localUnsubscribeMock = vi.fn(async () => undefined);

    Object.defineProperty(window, 'desktopApi', {
      configurable: true,
      writable: true,
      value: {
        onGitStatusChanged: (callback: (data: GitStatusChangedPayload) => void) => {
          callbacks.add(callback);
          return () => callbacks.delete(callback);
        },
        subscribeToGitWatcher: localSubscribeMock,
        unsubscribeFromGitWatcher: localUnsubscribeMock,
      },
    });

    const wrapper = createWrapper(queryClient);
    const hookA = renderHook(() => useGitWatcher(worktreePath), { wrapper });
    const hookB = renderHook(() => useGitWatcher(worktreePath), { wrapper });

    const emit = (payload: GitStatusChangedPayload) => {
      for (const callback of callbacks) {
        callback(payload);
      }
    };

    emit({
      worktreePath,
      changes: [{ path: '/tmp/project-a/src/first.ts', type: 'change' }],
    });
    vi.advanceTimersByTime(150);
    expect(invalidateQueriesSpy).toHaveBeenCalledTimes(6);

    invalidateQueriesSpy.mockClear();
    hookA.unmount();

    emit({
      worktreePath,
      changes: [{ path: '/tmp/project-a/src/second.ts', type: 'change' }],
    });
    vi.advanceTimersByTime(150);

    expect(invalidateQueriesSpy).toHaveBeenCalledTimes(3);

    hookB.unmount();
  });

  it('runs the status callback for its own worktree only', () => {
    const worktreePath = '/tmp/project-a';
    const onStatusChanged = vi.fn();
    const wrapper = createWrapper(queryClient);
    renderHook(() => useGitWatcher(worktreePath, onStatusChanged), { wrapper });

    onGitStatusChangedCallback?.({ worktreePath: '/tmp/project-b', changes: [] });
    expect(onStatusChanged).not.toHaveBeenCalled();

    onGitStatusChangedCallback?.({ worktreePath, changes: [] });
    expect(onStatusChanged).toHaveBeenCalledTimes(1);
  });
});
