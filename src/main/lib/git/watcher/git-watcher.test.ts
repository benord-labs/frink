import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the @parcel/watcher subscribe callback so tests can invoke it
// to simulate the watcher dropping FSEvents.
type SubscribeCallback = (err: Error | null, events: unknown[]) => void;
let capturedCallback: SubscribeCallback | null = null;

vi.mock('@parcel/watcher', () => ({
  subscribe: vi.fn(async (_path: string, cb: SubscribeCallback) => {
    capturedCallback = cb;
    return { unsubscribe: vi.fn(async () => {}) };
  }),
}));

// electron-log writes to disk at import; stub it out.
vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('shouldProcessWatcherPath', () => {
  // Import lazily inside each test so the vi.mock'd modules resolve cleanly.
  it('allows standard .git HEAD updates', async () => {
    const { shouldProcessWatcherPath } = await import('./git-watcher');
    expect(shouldProcessWatcherPath('/repos/app/.git/HEAD')).toBe(true);
  });

  it('allows linked-worktree HEAD updates', async () => {
    const { shouldProcessWatcherPath } = await import('./git-watcher');
    expect(shouldProcessWatcherPath('/repos/main/.git/worktrees/chat-branch/HEAD')).toBe(true);
  });

  it('rejects other .git internals', async () => {
    const { shouldProcessWatcherPath } = await import('./git-watcher');
    expect(shouldProcessWatcherPath('/repos/app/.git/objects/ab/cdef')).toBe(false);
  });

  it('allows .git index updates', async () => {
    const { shouldProcessWatcherPath } = await import('./git-watcher');
    expect(shouldProcessWatcherPath('/repos/app/.git/index')).toBe(true);
  });

  it('allows linked-worktree index updates', async () => {
    const { shouldProcessWatcherPath } = await import('./git-watcher');
    expect(shouldProcessWatcherPath('/repos/app/.git/worktrees/feature-branch/index')).toBe(true);
  });

  it('allows branch ref updates under refs/heads', async () => {
    const { shouldProcessWatcherPath } = await import('./git-watcher');
    expect(shouldProcessWatcherPath('/repos/app/.git/refs/heads/main')).toBe(true);
  });

  it('allows remote ref updates under refs/remotes', async () => {
    const { shouldProcessWatcherPath } = await import('./git-watcher');
    expect(shouldProcessWatcherPath('/repos/app/.git/refs/remotes/origin/main')).toBe(true);
  });

  it('allows packed refs updates', async () => {
    const { shouldProcessWatcherPath } = await import('./git-watcher');
    expect(shouldProcessWatcherPath('/repos/app/.git/packed-refs')).toBe(true);
  });

  it('allows merge/cherry-pick/rebase operation heads', async () => {
    const { shouldProcessWatcherPath } = await import('./git-watcher');
    expect(shouldProcessWatcherPath('/repos/app/.git/MERGE_HEAD')).toBe(true);
    expect(shouldProcessWatcherPath('/repos/app/.git/CHERRY_PICK_HEAD')).toBe(true);
    expect(shouldProcessWatcherPath('/repos/app/.git/REBASE_HEAD')).toBe(true);
    expect(shouldProcessWatcherPath('/repos/main/.git/worktrees/chat/MERGE_HEAD')).toBe(true);
  });

  it('normalizes windows paths before filtering', async () => {
    const { shouldProcessWatcherPath } = await import('./git-watcher');
    expect(shouldProcessWatcherPath('C:\\repos\\main\\.git\\worktrees\\chat-branch\\HEAD')).toBe(
      true,
    );
  });

  it('allows windows standard .git HEAD updates', async () => {
    const { shouldProcessWatcherPath } = await import('./git-watcher');
    expect(shouldProcessWatcherPath('C:\\repos\\app\\.git\\HEAD')).toBe(true);
  });

  it('rejects non-whitelisted linked-worktree git internals', async () => {
    const { shouldProcessWatcherPath } = await import('./git-watcher');
    expect(shouldProcessWatcherPath('/repos/main/.git/worktrees/chat-branch/logs/HEAD')).toBe(
      false,
    );
  });

  it('allows bare .git file paths used by submodule pointers', async () => {
    const { shouldProcessWatcherPath } = await import('./git-watcher');
    expect(shouldProcessWatcherPath('/repos/main/submodules/lib-a/.git')).toBe(true);
  });
});

describe('gitWatcherRegistry', () => {
  beforeEach(async () => {
    capturedCallback = null;
    // Fresh singleton per test: the registry holds watchers across calls.
    vi.resetModules();
  });

  // Regression guard: @parcel/watcher surfaces recoverable FSEvents-dropped errors
  // by invoking its callback with `err` set. GitWatcher re-emits these as `error`
  // events. Without a listener on 'error', Node's EventEmitter turns emit('error',...)
  // into an uncaughtException (the exact spam we saw in the field). The registry
  // must attach an 'error' listener on every watcher it creates.
  it('attaches an error listener so simulated FSEvents drops do not throw', async () => {
    const { gitWatcherRegistry } = await import('./git-watcher');
    const worktreePath = '/tmp/test-worktree-error-listener';

    await gitWatcherRegistry.getOrCreate(worktreePath);

    expect(capturedCallback).not.toBeNull();
    expect(() => {
      // This is exactly how @parcel/watcher surfaces FSEvents drops.
      capturedCallback?.(new Error('Events were dropped by the FSEvents client.'), []);
    }).not.toThrow();

    await gitWatcherRegistry.dispose(worktreePath);
  });

  it('returns the same watcher instance on repeated getOrCreate for the same path', async () => {
    const { gitWatcherRegistry } = await import('./git-watcher');
    const worktreePath = '/tmp/test-worktree-reuse';

    const first = await gitWatcherRegistry.getOrCreate(worktreePath);
    const second = await gitWatcherRegistry.getOrCreate(worktreePath);

    expect(first).toBe(second);

    await gitWatcherRegistry.dispose(worktreePath);
  });

  it('routes `change` events to registered subscribers', async () => {
    const { gitWatcherRegistry } = await import('./git-watcher');
    const worktreePath = '/tmp/test-worktree-change-routing';

    const received: unknown[] = [];
    const unsubscribe = await gitWatcherRegistry.subscribe(worktreePath, (event) => {
      received.push(event);
    });

    // Directly emit a change on the underlying watcher to avoid the 300ms debounce.
    const watcher = await gitWatcherRegistry.getOrCreate(worktreePath);
    watcher.emit('change', {
      type: 'batch',
      changes: [{ path: '/tmp/test-worktree-change-routing/a.ts', type: 'change' }],
      timestamp: Date.now(),
      worktreePath,
    });

    expect(received).toHaveLength(1);

    unsubscribe();
    await gitWatcherRegistry.dispose(worktreePath);
  });
});

describe('GitWatcher ignore filtering', () => {
  const worktreePath = '/repos/app';
  type Change = { path: string; type: string };
  type GitDir = { path: string; outsideWorktree: boolean; worktreeRoot: string };

  /** Paths under this directory count as gitignored unless a test says otherwise. */
  const keepUnignoredMock = vi.fn(async (paths: string[]) =>
    paths.filter((filePath) => !filePath.includes('/data/')),
  );
  const resetMock = vi.fn();
  const resolveGitDirMock = vi.fn(async (): Promise<GitDir | null> => ({
    path: `${worktreePath}/.git`,
    outsideWorktree: false,
    worktreeRoot: worktreePath,
  }));

  beforeEach(() => {
    capturedCallback = null;
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    keepUnignoredMock.mockReset();
    keepUnignoredMock.mockImplementation(async (paths: string[]) =>
      paths.filter((filePath) => !filePath.includes('/data/')),
    );
    resetMock.mockReset();
    resolveGitDirMock.mockReset();
    resolveGitDirMock.mockImplementation(async () => ({
      path: `${worktreePath}/.git`,
      outsideWorktree: false,
      worktreeRoot: worktreePath,
    }));
  });

  async function watch() {
    const parcel = await import('@parcel/watcher');
    const subscribeMock = vi.mocked(parcel.subscribe);
    subscribeMock.mockClear();
    const gitDir = await import('./git-dir');
    vi.spyOn(gitDir, 'resolveGitDir').mockImplementation(resolveGitDirMock);
    const ignoredPaths = await import('./ignored-paths');
    vi.spyOn(ignoredPaths, 'createIgnoreFilter').mockImplementation(() => ({
      keepUnignored: keepUnignoredMock,
      reset: resetMock,
    }));

    const { gitWatcherRegistry } = await import('./git-watcher');
    const batches: Change[][] = [];
    await gitWatcherRegistry.subscribe(worktreePath, (event) => batches.push(event.changes));
    const fireEvents = async (events: Array<{ path: string; type: string }>) => {
      capturedCallback?.(null, events);
      await vi.advanceTimersByTimeAsync(300);
    };
    const fire = (...paths: string[]) =>
      fireEvents(paths.map((path) => ({ path, type: 'update' })));
    return {
      batches,
      fire,
      fireEvents,
      subscribeMock,
      dispose: () => gitWatcherRegistry.dispose(worktreePath),
    };
  }

  it('emits no change event for a batch of ignored paths', async () => {
    const { batches, fire } = await watch();

    await fire('/repos/app/data/run.jsonl', '/repos/app/data/other.jsonl');

    expect(keepUnignoredMock).toHaveBeenCalledTimes(1);
    expect(batches).toEqual([]);
  });

  it('emits only the paths the repository does not ignore', async () => {
    const { batches, fire } = await watch();

    await fire('/repos/app/data/run.jsonl', '/repos/app/src/a.ts');

    expect(batches).toEqual([[{ path: '/repos/app/src/a.ts', type: 'change' }]]);
  });

  it('keeps ignored files appearing or going, so the file tree still sees them', async () => {
    const { batches, fireEvents } = await watch();

    await fireEvents([
      { path: '/repos/app/data/new.jsonl', type: 'create' },
      { path: '/repos/app/data/new.jsonl', type: 'update' },
      { path: '/repos/app/data/old.jsonl', type: 'delete' },
      { path: '/repos/app/data/run.jsonl', type: 'update' },
    ]);

    expect(batches).toEqual([
      [
        { path: '/repos/app/data/new.jsonl', type: 'add' },
        { path: '/repos/app/data/old.jsonl', type: 'unlink' },
      ],
    ]);
  });

  it('passes git pointers and IDE config without asking whether they are ignored', async () => {
    keepUnignoredMock.mockResolvedValue([]);
    const { batches, fire } = await watch();

    await fire('/repos/app/.git/HEAD', '/repos/app/.claude/skills/x/SKILL.md');

    expect(keepUnignoredMock).toHaveBeenCalledWith([]);
    expect(batches).toEqual([
      [
        { path: '/repos/app/.git/HEAD', type: 'change' },
        { path: '/repos/app/.claude/skills/x/SKILL.md', type: 'change' },
      ],
    ]);
  });

  it('recognises IDE config by the real path of a project opened through a symlink', async () => {
    resolveGitDirMock.mockResolvedValue({
      path: '/real/app/.git',
      outsideWorktree: false,
      worktreeRoot: '/real/app',
    });
    keepUnignoredMock.mockResolvedValue([]);
    const { batches, fire } = await watch();

    await fire('/real/app/.claude/agents/reviewer.md');

    expect(batches).toEqual([[{ path: '/real/app/.claude/agents/reviewer.md', type: 'change' }]]);
  });

  it.each([
    ['/repos/app/.gitignore'],
    ['/repos/app/pkg/.gitignore'],
    ['C:\\repos\\app\\pkg\\.gitignore'],
    ['/repos/app/.git/index'],
  ])('forgets cached ignore answers when %s changes', async (rulePath) => {
    const { fire } = await watch();

    await fire('/repos/app/src/a.ts');
    expect(resetMock).not.toHaveBeenCalled();
    await fire(rulePath);
    expect(resetMock).toHaveBeenCalledTimes(1);
  });

  it('emits everything and never builds a filter outside a git repository', async () => {
    resolveGitDirMock.mockResolvedValue(null);
    const { batches, fire } = await watch();

    await fire('/repos/app/data/run.jsonl');

    expect(keepUnignoredMock).not.toHaveBeenCalled();
    expect(batches).toEqual([[{ path: '/repos/app/data/run.jsonl', type: 'change' }]]);
  });

  it('emits nothing when disposed while the ignore check is running', async () => {
    let finishCheck: (kept: string[]) => void = () => {};
    keepUnignoredMock.mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          finishCheck = resolve;
        }),
    );
    const { batches, fire, dispose } = await watch();

    await fire('/repos/app/src/a.ts');
    await dispose();
    finishCheck(['/repos/app/src/a.ts']);
    await vi.advanceTimersByTimeAsync(0);

    expect(batches).toEqual([]);
  });

  it('flushes events that arrive during an ignore check in a following batch', async () => {
    let finishCheck: (kept: string[]) => void = () => {};
    keepUnignoredMock.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          finishCheck = resolve;
        }),
    );
    const { batches, fire } = await watch();

    await fire('/repos/app/src/a.ts');
    await fire('/repos/app/src/b.ts');
    expect(batches).toEqual([]);

    finishCheck(['/repos/app/src/a.ts']);
    await vi.advanceTimersByTimeAsync(300);

    expect(batches).toEqual([
      [{ path: '/repos/app/src/a.ts', type: 'change' }],
      [{ path: '/repos/app/src/b.ts', type: 'change' }],
    ]);
  });

  it('also watches a linked worktree git dir and emits only its pointer files', async () => {
    const gitDir = '/repos/main/.git/worktrees/app';
    resolveGitDirMock.mockResolvedValue({
      path: gitDir,
      outsideWorktree: true,
      worktreeRoot: worktreePath,
    });
    const { batches, dispose, subscribeMock } = await watch();

    // Never the shared git dir: other worktrees' refs, HEADs and indexes are not this chat's
    expect(subscribeMock.mock.calls.map((call) => call[0])).toEqual([worktreePath, gitDir]);
    expect(subscribeMock.mock.calls[1][2]).toEqual({ ignore: expect.arrayContaining(['objects']) });
    const onGitDirEvents = subscribeMock.mock.calls[1][1];
    onGitDirEvents(
      null,
      [`${gitDir}/HEAD`, `${gitDir}/logs/HEAD`, `${gitDir}/index.lock`].map((path) => ({
        path,
        type: 'update',
      })),
    );
    await vi.advanceTimersByTimeAsync(300);
    expect(batches).toEqual([[{ path: `${gitDir}/HEAD`, type: 'change' }]]);

    await dispose();
    const subscriptions = await Promise.all(
      subscribeMock.mock.results.map((result) => result.value),
    );
    for (const subscription of subscriptions) {
      expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    }
  });

  // Submodules and --separate-git-dir: one git dir outside the tree, under any name.
  it.each([['/super/.git/modules/sub'], ['/store/app.git']])(
    'reads pointers and refs from a git dir at %s',
    async (gitDir) => {
      resolveGitDirMock.mockResolvedValue({
        path: gitDir,
        outsideWorktree: true,
        worktreeRoot: worktreePath,
      });
      const { batches, subscribeMock } = await watch();

      expect(subscribeMock.mock.calls.map((call) => call[0])).toEqual([worktreePath, gitDir]);
      const onGitDirEvents = subscribeMock.mock.calls[1][1];
      onGitDirEvents(
        null,
        ['HEAD', 'refs/heads/x', 'refs/heads/x.lock', 'logs/HEAD', 'config'].map((name) => ({
          path: `${gitDir}/${name}`,
          type: 'update',
        })),
      );
      await vi.advanceTimersByTimeAsync(300);

      expect(batches).toEqual([
        [
          { path: `${gitDir}/HEAD`, type: 'change' },
          { path: `${gitDir}/refs/heads/x`, type: 'change' },
        ],
      ]);
    },
  );

  it('watches only the worktree when its git dir is inside it', async () => {
    const { subscribeMock } = await watch();
    expect(subscribeMock.mock.calls.map((call) => call[0])).toEqual([worktreePath]);
  });
});
