import { beforeEach, describe, expect, it, vi } from 'vitest';

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
