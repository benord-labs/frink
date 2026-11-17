import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  handleMock,
  handlers,
  subscribeMock,
  disposeAllMock,
  invalidateGitStatusCacheMock,
  invalidateFileListCacheMock,
  gitCacheMock,
} = vi.hoisted(() => {
  const handlersMap = new Map<string, (...args: unknown[]) => unknown>();
  const handle = vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
    handlersMap.set(channel, handler);
  });
  return {
    handleMock: handle,
    handlers: handlersMap,
    subscribeMock: vi.fn(),
    disposeAllMock: vi.fn(),
    invalidateGitStatusCacheMock: vi.fn(),
    invalidateFileListCacheMock: vi.fn(),
    gitCacheMock: {
      invalidateStatus: vi.fn(),
      invalidateParsedDiff: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
  },
}));

vi.mock('../../trpc/routers/files', () => ({
  invalidateGitStatusCache: invalidateGitStatusCacheMock,
  invalidateFileListCache: invalidateFileListCacheMock,
}));

vi.mock('../cache', () => ({
  gitCache: gitCacheMock,
}));

vi.mock('./git-watcher', () => ({
  gitWatcherRegistry: {
    subscribe: subscribeMock,
    disposeAll: disposeAllMock,
  },
}));

describe('registerGitWatcherIPC', () => {
  type WatcherEvent = {
    worktreePath: string;
    changes: Array<{ path: string; type: string }>;
  };
  type WatcherCallback = (event: WatcherEvent) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    handlers.clear();
    handleMock.mockClear();
    subscribeMock.mockReset();
    invalidateGitStatusCacheMock.mockReset();
    invalidateFileListCacheMock.mockReset();
    gitCacheMock.invalidateStatus.mockReset();
    gitCacheMock.invalidateParsedDiff.mockReset();
    disposeAllMock.mockReset();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not drop HEAD change events inside throttle window', async () => {
    const nowRef = { value: 1000 };
    vi.spyOn(Date, 'now').mockImplementation(() => nowRef.value);

    let watcherCallback: WatcherCallback = () => {};
    subscribeMock.mockImplementation(async (_worktreePath: string, callback: WatcherCallback) => {
      watcherCallback = callback;
      return vi.fn();
    });

    const sendMock = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: { send: sendMock },
    } as const;

    const { registerGitWatcherIPC } = await import('./ipc-bridge');
    registerGitWatcherIPC(() => win as never);

    const subscribeHandler = handlers.get('git:subscribe-watcher');
    expect(subscribeHandler).toBeTypeOf('function');
    await subscribeHandler?.({}, '/repo/worktree');

    // First non-HEAD event forwards and sets throttle timestamp.
    watcherCallback({
      worktreePath: '/repo/worktree',
      changes: [{ path: '/repo/worktree/src/file.ts', type: 'change' }],
    });

    // HEAD update arrives inside throttle window and must still be forwarded.
    nowRef.value = 1200;
    watcherCallback({
      worktreePath: '/repo/worktree',
      changes: [{ path: '/repo/worktree/.git/HEAD', type: 'change' }],
    });

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenNthCalledWith(
      2,
      'git:status-changed',
      expect.objectContaining({
        worktreePath: '/repo/worktree',
      }),
    );
  });

  it('does not drop index/ref updates inside throttle window', async () => {
    const nowRef = { value: 1000 };
    vi.spyOn(Date, 'now').mockImplementation(() => nowRef.value);

    let watcherCallback: WatcherCallback = () => {};
    subscribeMock.mockImplementation(async (_worktreePath: string, callback: WatcherCallback) => {
      watcherCallback = callback;
      return vi.fn();
    });

    const sendMock = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: { send: sendMock },
    } as const;

    const { registerGitWatcherIPC } = await import('./ipc-bridge');
    registerGitWatcherIPC(() => win as never);

    const subscribeHandler = handlers.get('git:subscribe-watcher');
    expect(subscribeHandler).toBeTypeOf('function');
    await subscribeHandler?.({}, '/repo/worktree-pointers');

    watcherCallback({
      worktreePath: '/repo/worktree-pointers',
      changes: [{ path: '/repo/worktree-pointers/src/file.ts', type: 'change' }],
    });

    nowRef.value = 1100;
    watcherCallback({
      worktreePath: '/repo/worktree-pointers',
      changes: [{ path: '/repo/worktree-pointers/.git/index', type: 'change' }],
    });

    nowRef.value = 1200;
    watcherCallback({
      worktreePath: '/repo/worktree-pointers',
      changes: [{ path: '/repo/worktree-pointers/.git/refs/heads/main', type: 'change' }],
    });

    nowRef.value = 1300;
    watcherCallback({
      worktreePath: '/repo/worktree-pointers',
      changes: [{ path: '/repo/worktree-pointers/.git/packed-refs', type: 'change' }],
    });

    nowRef.value = 1400;
    watcherCallback({
      worktreePath: '/repo/worktree-pointers',
      changes: [{ path: '/repo/worktree-pointers/.git/refs/remotes/origin/main', type: 'change' }],
    });

    nowRef.value = 1500;
    watcherCallback({
      worktreePath: '/repo/worktree-pointers',
      changes: [{ path: '/repo/worktree-pointers/.git/MERGE_HEAD', type: 'change' }],
    });

    expect(sendMock).toHaveBeenCalledTimes(6);
  });

  it('coalesces non-HEAD events inside the window and emits trailing update', async () => {
    const nowRef = { value: 1000 };
    vi.spyOn(Date, 'now').mockImplementation(() => nowRef.value);

    let watcherCallback: WatcherCallback = () => {};
    subscribeMock.mockImplementation(async (_worktreePath: string, callback: WatcherCallback) => {
      watcherCallback = callback;
      return vi.fn();
    });

    const sendMock = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: { send: sendMock },
    } as const;

    const { registerGitWatcherIPC } = await import('./ipc-bridge');
    registerGitWatcherIPC(() => win as never);

    const subscribeHandler = handlers.get('git:subscribe-watcher');
    expect(subscribeHandler).toBeTypeOf('function');
    await subscribeHandler?.({}, '/repo/worktree-2');

    watcherCallback({
      worktreePath: '/repo/worktree-2',
      changes: [{ path: '/repo/worktree-2/src/a.ts', type: 'change' }],
    });

    nowRef.value = 1100;
    watcherCallback({
      worktreePath: '/repo/worktree-2',
      changes: [{ path: '/repo/worktree-2/src/b.ts', type: 'change' }],
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenLastCalledWith(
      'git:status-changed',
      expect.objectContaining({
        worktreePath: '/repo/worktree-2',
        changes: [{ path: '/repo/worktree-2/src/b.ts', type: 'change' }],
      }),
    );
  });

  it('cancels pending trailing non-pointer update when pointer event arrives', async () => {
    const nowRef = { value: 1000 };
    vi.spyOn(Date, 'now').mockImplementation(() => nowRef.value);

    let watcherCallback: WatcherCallback = () => {};
    subscribeMock.mockImplementation(async (_worktreePath: string, callback: WatcherCallback) => {
      watcherCallback = callback;
      return vi.fn();
    });

    const sendMock = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: { send: sendMock },
    } as const;

    const { registerGitWatcherIPC } = await import('./ipc-bridge');
    registerGitWatcherIPC(() => win as never);

    const subscribeHandler = handlers.get('git:subscribe-watcher');
    expect(subscribeHandler).toBeTypeOf('function');
    await subscribeHandler?.({}, '/repo/cancel-pending');

    watcherCallback({
      worktreePath: '/repo/cancel-pending',
      changes: [{ path: '/repo/cancel-pending/src/a.ts', type: 'change' }],
    });

    nowRef.value = 1100;
    watcherCallback({
      worktreePath: '/repo/cancel-pending',
      changes: [{ path: '/repo/cancel-pending/src/b.ts', type: 'change' }],
    });

    nowRef.value = 1200;
    watcherCallback({
      worktreePath: '/repo/cancel-pending',
      changes: [{ path: '/repo/cancel-pending/.git/index', type: 'change' }],
    });

    expect(sendMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(500);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('throttles independently per worktree', async () => {
    const nowRef = { value: 1000 };
    vi.spyOn(Date, 'now').mockImplementation(() => nowRef.value);

    let watcherCallbackA: WatcherCallback = () => {};
    let watcherCallbackB: WatcherCallback = () => {};
    subscribeMock.mockImplementation(async (worktreePath: string, callback: WatcherCallback) => {
      if (worktreePath === '/repo/a') watcherCallbackA = callback;
      if (worktreePath === '/repo/b') watcherCallbackB = callback;
      return vi.fn();
    });

    const sendMock = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: { send: sendMock },
    } as const;

    const { registerGitWatcherIPC } = await import('./ipc-bridge');
    registerGitWatcherIPC(() => win as never);

    const subscribeHandler = handlers.get('git:subscribe-watcher');
    expect(subscribeHandler).toBeTypeOf('function');
    await subscribeHandler?.({}, '/repo/a');
    await subscribeHandler?.({}, '/repo/b');

    watcherCallbackA({
      worktreePath: '/repo/a',
      changes: [{ path: '/repo/a/src/a.ts', type: 'change' }],
    });
    watcherCallbackB({
      worktreePath: '/repo/b',
      changes: [{ path: '/repo/b/src/a.ts', type: 'change' }],
    });
    nowRef.value = 1100;
    watcherCallbackA({
      worktreePath: '/repo/a',
      changes: [{ path: '/repo/a/src/b.ts', type: 'change' }],
    });
    watcherCallbackB({
      worktreePath: '/repo/b',
      changes: [{ path: '/repo/b/src/b.ts', type: 'change' }],
    });

    expect(sendMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(500);
    expect(sendMock).toHaveBeenCalledTimes(4);
  });

  // A submodule or separate-git-dir HEAD is not a `/.git/` pointer path, so it is throttled like
  // a file edit; the renderer still needs to see it to refresh the branch list.
  it('keeps every held-back path when later events arrive inside the window', async () => {
    const nowRef = { value: 1000 };
    vi.spyOn(Date, 'now').mockImplementation(() => nowRef.value);

    let watcherCallback: WatcherCallback = () => {};
    subscribeMock.mockImplementation(async (_worktreePath: string, callback: WatcherCallback) => {
      watcherCallback = callback;
      return vi.fn();
    });

    const sendMock = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: { send: sendMock },
    };

    const { registerGitWatcherIPC } = await import('./ipc-bridge');
    // SAFETY: the bridge only reads isDestroyed and webContents.send from the window.
    registerGitWatcherIPC(() => win as never);
    await handlers.get('git:subscribe-watcher')?.({}, '/repo/held');

    const fire = (path: string) =>
      watcherCallback({ worktreePath: '/repo/held', changes: [{ path, type: 'change' }] });
    fire('/repo/held/src/a.ts');
    nowRef.value = 1100;
    fire('/store/held.git/HEAD');
    nowRef.value = 1200;
    fire('/repo/held/src/b.ts');
    vi.advanceTimersByTime(500);

    expect(sendMock).toHaveBeenLastCalledWith('git:status-changed', {
      worktreePath: '/repo/held',
      changes: [
        { path: '/store/held.git/HEAD', type: 'change' },
        { path: '/repo/held/src/b.ts', type: 'change' },
      ],
    });

    // A pointer event that jumps the queue carries the held-back paths with it.
    nowRef.value = 1800;
    fire('/repo/held/src/c.ts');
    nowRef.value = 1900;
    fire('/store/held.git/refs/heads/feature');
    nowRef.value = 2000;
    fire('/repo/held/.git/index');

    expect(sendMock).toHaveBeenLastCalledWith('git:status-changed', {
      worktreePath: '/repo/held',
      changes: [
        { path: '/store/held.git/refs/heads/feature', type: 'change' },
        { path: '/repo/held/.git/index', type: 'change' },
      ],
    });
    const sends = sendMock.mock.calls.length;
    vi.advanceTimersByTime(500);
    expect(sendMock).toHaveBeenCalledTimes(sends);
  });

  it('announces an IDE config change under a skills directory', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => 1000);

    let watcherCallback: WatcherCallback = () => {};
    subscribeMock.mockImplementation(async (_worktreePath: string, callback: WatcherCallback) => {
      watcherCallback = callback;
      return vi.fn();
    });

    const sendMock = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: { send: sendMock },
    };

    const { registerGitWatcherIPC } = await import('./ipc-bridge');
    // SAFETY: the bridge only reads isDestroyed and webContents.send from the window.
    registerGitWatcherIPC(() => win as never);
    await handlers.get('git:subscribe-watcher')?.({}, '/repo/ide');

    watcherCallback({
      worktreePath: '/repo/ide',
      changes: [
        { path: '/repo/ide/.claude/skills/x/SKILL.md', type: 'add' },
        { path: '/repo/ide/.cursor/mcp.json', type: 'change' },
      ],
    });

    expect(sendMock).toHaveBeenCalledWith('ide-config:changed', {
      worktreePath: '/repo/ide',
      changes: [{ resourceType: 'skills', origin: 'claude', type: 'add' }],
    });
  });

  it('invalidates status, diff, git cache, and file list cache when forwarding events', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => 1000);

    let watcherCallback: WatcherCallback = () => {};
    subscribeMock.mockImplementation(async (_worktreePath: string, callback: WatcherCallback) => {
      watcherCallback = callback;
      return vi.fn();
    });

    const sendMock = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: { send: sendMock },
    } as const;

    const { registerGitWatcherIPC } = await import('./ipc-bridge');
    registerGitWatcherIPC(() => win as never);

    const subscribeHandler = handlers.get('git:subscribe-watcher');
    expect(subscribeHandler).toBeTypeOf('function');
    await subscribeHandler?.({}, '/repo/worktree-cache');

    watcherCallback({
      worktreePath: '/repo/worktree-cache',
      changes: [{ path: '/repo/worktree-cache/.git/index', type: 'change' }],
    });

    expect(gitCacheMock.invalidateStatus).toHaveBeenCalledWith('/repo/worktree-cache');
    expect(gitCacheMock.invalidateParsedDiff).toHaveBeenCalledWith('/repo/worktree-cache');
    expect(invalidateGitStatusCacheMock).toHaveBeenCalledWith('/repo/worktree-cache');
    expect(invalidateFileListCacheMock).toHaveBeenCalledWith('/repo/worktree-cache');
    expect(sendMock).toHaveBeenCalledWith(
      'git:status-changed',
      expect.objectContaining({
        worktreePath: '/repo/worktree-cache',
      }),
    );
  });

  it('forwards final commit state in rapid add/reset/add/commit sequence', async () => {
    const nowRef = { value: 1000 };
    vi.spyOn(Date, 'now').mockImplementation(() => nowRef.value);

    let watcherCallback: WatcherCallback = () => {};
    subscribeMock.mockImplementation(async (_worktreePath: string, callback: WatcherCallback) => {
      watcherCallback = callback;
      return vi.fn();
    });

    const sendMock = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: { send: sendMock },
    } as const;

    const { registerGitWatcherIPC } = await import('./ipc-bridge');
    registerGitWatcherIPC(() => win as never);

    const subscribeHandler = handlers.get('git:subscribe-watcher');
    expect(subscribeHandler).toBeTypeOf('function');
    await subscribeHandler?.({}, '/repo/rapid');

    // add
    watcherCallback({
      worktreePath: '/repo/rapid',
      changes: [{ path: '/repo/rapid/.git/index', type: 'change' }],
    });
    nowRef.value = 1050;

    // reset
    watcherCallback({
      worktreePath: '/repo/rapid',
      changes: [{ path: '/repo/rapid/.git/index', type: 'change' }],
    });
    nowRef.value = 1100;

    // add
    watcherCallback({
      worktreePath: '/repo/rapid',
      changes: [{ path: '/repo/rapid/.git/index', type: 'change' }],
    });
    nowRef.value = 1150;

    // commit
    watcherCallback({
      worktreePath: '/repo/rapid',
      changes: [{ path: '/repo/rapid/.git/refs/heads/main', type: 'change' }],
    });

    expect(sendMock).toHaveBeenCalledTimes(4);
    expect(sendMock).toHaveBeenLastCalledWith(
      'git:status-changed',
      expect.objectContaining({
        worktreePath: '/repo/rapid',
        changes: [{ path: '/repo/rapid/.git/refs/heads/main', type: 'change' }],
      }),
    );
  });

  it('keeps watcher until last unsubscribe and resubscribes cleanly', async () => {
    let watcherCallback: WatcherCallback = () => {};
    const underlyingUnsubscribe = vi.fn();
    subscribeMock.mockImplementation(async (_worktreePath: string, callback: WatcherCallback) => {
      watcherCallback = callback;
      return underlyingUnsubscribe;
    });

    const sendMock = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: { send: sendMock },
    } as const;

    const { registerGitWatcherIPC } = await import('./ipc-bridge');
    registerGitWatcherIPC(() => win as never);

    const subscribeHandler = handlers.get('git:subscribe-watcher');
    const unsubscribeHandler = handlers.get('git:unsubscribe-watcher');
    expect(subscribeHandler).toBeTypeOf('function');
    expect(unsubscribeHandler).toBeTypeOf('function');

    // Two panes subscribe to same project path.
    await subscribeHandler?.({}, '/repo/shared');
    await subscribeHandler?.({}, '/repo/shared');
    expect(subscribeMock).toHaveBeenCalledTimes(1);

    // First pane unmounts; watcher should still stay alive for second pane.
    await unsubscribeHandler?.({}, '/repo/shared');
    expect(underlyingUnsubscribe).not.toHaveBeenCalled();

    watcherCallback({
      worktreePath: '/repo/shared',
      changes: [{ path: '/repo/shared/.git/index', type: 'change' }],
    });
    expect(sendMock).toHaveBeenCalledWith(
      'git:status-changed',
      expect.objectContaining({ worktreePath: '/repo/shared' }),
    );

    // Second pane unmounts; watcher should tear down exactly once.
    await unsubscribeHandler?.({}, '/repo/shared');
    expect(underlyingUnsubscribe).toHaveBeenCalledTimes(1);

    // Fresh subscribe should create a new underlying watcher subscription.
    await subscribeHandler?.({}, '/repo/shared');
    expect(subscribeMock).toHaveBeenCalledTimes(2);
  });

  it('clears throttle timestamps when cleanupGitWatchers is called', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => 1000);

    let watcherCallback: WatcherCallback = () => {};
    const underlyingUnsubscribe = vi.fn();
    subscribeMock.mockImplementation(async (_worktreePath: string, callback: WatcherCallback) => {
      watcherCallback = callback;
      return underlyingUnsubscribe;
    });

    const sendMock = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: { send: sendMock },
    } as const;

    const { cleanupGitWatchers, registerGitWatcherIPC } = await import('./ipc-bridge');
    registerGitWatcherIPC(() => win as never);

    const subscribeHandler = handlers.get('git:subscribe-watcher');
    expect(subscribeHandler).toBeTypeOf('function');

    await subscribeHandler?.({}, '/repo/cleanup');
    watcherCallback({
      worktreePath: '/repo/cleanup',
      changes: [{ path: '/repo/cleanup/src/one.ts', type: 'change' }],
    });
    expect(sendMock).toHaveBeenCalledTimes(1);

    await cleanupGitWatchers();
    expect(underlyingUnsubscribe).toHaveBeenCalledTimes(1);
    expect(disposeAllMock).toHaveBeenCalledTimes(1);

    // Re-subscribe at the same timestamp and emit a non-pointer change.
    // If lastEventTime was not cleared, this would be throttled and dropped.
    await subscribeHandler?.({}, '/repo/cleanup');
    watcherCallback({
      worktreePath: '/repo/cleanup',
      changes: [{ path: '/repo/cleanup/src/two.ts', type: 'change' }],
    });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('shares one watcher between subscribes that overlap before it starts', async () => {
    const { registerGitWatcherIPC } = await import('./ipc-bridge');
    const stop = vi.fn();
    let start: (stop: () => void) => void = () => undefined;
    subscribeMock.mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          start = resolve;
        }),
    );
    registerGitWatcherIPC(() => null);
    const subscribeHandler = handlers.get('git:subscribe-watcher');
    const unsubscribeHandler = handlers.get('git:unsubscribe-watcher');

    const first = subscribeHandler?.({}, '/repo/shared');
    const second = subscribeHandler?.({}, '/repo/shared');
    start(stop);
    await Promise.all([first, second]);
    expect(subscribeMock).toHaveBeenCalledTimes(1);

    await unsubscribeHandler?.({}, '/repo/shared');
    expect(stop).not.toHaveBeenCalled();
    await unsubscribeHandler?.({}, '/repo/shared');
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
